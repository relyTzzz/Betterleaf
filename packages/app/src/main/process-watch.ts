import { execFile } from 'node:child_process';

/**
 * What is running right now: image names, and full paths where we can get them.
 *
 * Both, because neither alone is enough. A path is the precise answer — several
 * unrelated programs ship a `launcher.exe`, and Java games all show up as
 * `javaw.exe` — but Windows refuses the path of processes running at a higher
 * integrity level than Betterleaf, so roughly half of a typical list has no path
 * at all. Those can still be matched by name.
 */
export interface ProcessSnapshot {
  /** Lowercased image names, e.g. `league of legends.exe`. */
  names: Set<string>;
  /** Lowercased full paths, for the processes that would tell us. */
  paths: Set<string>;
}

export type ListProcesses = () => Promise<ProcessSnapshot>;

/**
 * Name and path in one pass.
 *
 * `wmic` would have been the cheap way to ask, but it has been removed from
 * Windows 11 (verified missing on 26200), so this goes through PowerShell.
 * Measured at ~680ms against ~690ms for a bare `tasklist` on the same machine,
 * so paths cost nothing extra and there is no reason to keep two code paths.
 */
const PS_LIST =
  'Get-CimInstance Win32_Process | ForEach-Object { $_.Name + [char]9 + $_.ExecutablePath }';

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      // A failure here means this poll saw nothing, and the next is seconds
      // away. Throwing would take down a background timer over a transient.
      (error, stdout) => resolve(error ? '' : stdout),
    );
  });
}

/**
 * Lowercase and strip quotes, so what someone types compares equal to what the
 * system reports.
 *
 * On Windows forward slashes are also folded to backslashes, because people
 * type them out of habit and the two mean the same thing there. Not elsewhere:
 * a slash is the only separator POSIX has, and rewriting it would turn every
 * path into nonsense.
 */
export function normaliseEntry(raw: string, platform = process.platform): string {
  const trimmed = raw.trim().replace(/^["']|["']$/g, '');
  const separated = platform === 'win32' ? trimmed.replace(/\//g, '\\') : trimmed;
  return separated.toLowerCase();
}

/** A full path rather than a bare image name. */
export function looksLikePath(entry: string): boolean {
  return entry.includes('\\') || entry.includes('/') || /^[a-z]:/.test(entry);
}

function parsePowerShell(stdout: string): ProcessSnapshot {
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const name = line.slice(0, tab).trim();
    const full = line.slice(tab + 1).trim();
    if (name) names.add(normaliseEntry(name));
    // Empty for processes Windows would not tell us about; name still counts.
    if (full) paths.add(normaliseEntry(full));
  }
  return { names, paths };
}

/**
 * Parse `tasklist /fo csv /nh`, whose first column is the quoted image name.
 *
 * The fallback for when PowerShell is unavailable or blocked. Only the first
 * field is read, so a window title containing commas or quotes cannot shift the
 * column we care about.
 */
export function parseTasklist(stdout: string): ProcessSnapshot {
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^"([^"]+)"/.exec(line.trim());
    if (match?.[1]) names.add(normaliseEntry(match[1]));
  }
  return { names, paths: new Set() };
}

export function parsePs(stdout: string): ProcessSnapshot {
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Normalised as POSIX explicitly rather than by the running platform: this
    // parser only ever sees POSIX output, and folding its slashes the way
    // Windows wants would ruin every path.
    if (trimmed.startsWith('/')) paths.add(normaliseEntry(trimmed, 'linux'));
    const base = trimmed.split(/[\\/]/).pop();
    if (base) names.add(normaliseEntry(base, 'linux'));
  }
  return { names, paths };
}

/** The real process list for this platform. */
export const listRunningProcesses: ListProcesses = async () => {
  if (process.platform === 'win32') {
    const viaPowerShell = parsePowerShell(
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], 15_000),
    );
    if (viaPowerShell.names.size > 0) return viaPowerShell;
    // Locked-down machines can refuse to run PowerShell at all. Names only is a
    // worse answer than names and paths, but it is much better than nothing.
    return parseTasklist(await run('tasklist', ['/fo', 'csv', '/nh'], 10_000));
  }
  return parsePs(await run('ps', ['-A', '-o', 'comm='], 10_000));
};

/**
 * Does any of this rule's entries match what is running?
 *
 * An entry containing a separator is treated as a full path and compared only
 * against paths, so `C:\Games\A\game.exe` does not match a `game.exe` running
 * from somewhere else — that precision is the whole point of writing a path.
 * A bare name is compared against names, tolerating a missing `.exe`, because
 * that is how people say the name of a program.
 *
 * Returns the entry that matched, for showing why the rule is active.
 */
export function matchProcess(
  entries: string[],
  running: ProcessSnapshot,
): string | undefined {
  for (const raw of entries) {
    const entry = normaliseEntry(raw);
    if (!entry) continue;

    if (looksLikePath(entry)) {
      if (running.paths.has(entry)) return entry;
      continue;
    }

    if (running.names.has(entry)) return entry;
    if (!entry.includes('.') && running.names.has(`${entry}.exe`)) return `${entry}.exe`;
  }
  return undefined;
}
