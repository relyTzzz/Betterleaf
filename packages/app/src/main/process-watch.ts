import { execFile } from 'node:child_process';

/**
 * Which programs are running right now.
 *
 * Shells out rather than using a native module, for the same reason the rest of
 * Betterleaf avoids them: a native addon has to be rebuilt for every Electron
 * version and is the main thing standing between a user and the app just
 * working.
 *
 * It is not free. Measured on a normal desktop with ~100 processes, `tasklist`
 * takes about 550ms of wall time per run, so this must not be called on a tight
 * loop — the engine skips it entirely when no rule needs it, and polls slowly
 * when one does.
 *
 * Deliberately only answers "is it running", not "is it focused". Reading the
 * foreground window's owner needs Win32 calls, which would mean either a native
 * addon or spawning PowerShell every few seconds — both far more expensive than
 * the question is worth.
 */
export type ListProcesses = () => Promise<Set<string>>;

function run(command: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      // A failure here is not worth surfacing: it means this poll saw nothing,
      // and the next one is a few seconds away. Throwing would take down a
      // background timer for a transient condition.
      (error, stdout) => resolve(error ? '' : stdout),
    );
  });
}

/**
 * Parse `tasklist /fo csv /nh`, whose first column is the quoted image name.
 *
 * Only the first field is read, so a process whose window title contains commas
 * or quotes cannot shift the column we care about.
 */
function parseTasklist(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^"([^"]+)"/.exec(line.trim());
    if (match?.[1]) names.add(match[1].toLowerCase());
  }
  return names;
}

function parsePs(stdout: string): Set<string> {
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    // `comm` can be a full path on Linux; the basename is what a rule names.
    const base = trimmed.split(/[\\/]/).pop();
    if (base) names.add(base.toLowerCase());
  }
  return names;
}

/** The real process list for this platform. */
export const listRunningProcesses: ListProcesses = async () => {
  if (process.platform === 'win32') {
    return parseTasklist(await run('tasklist', ['/fo', 'csv', '/nh'], 5_000));
  }
  return parsePs(await run('ps', ['-A', '-o', 'comm='], 5_000));
};

/**
 * Does this rule's list of names match what is running?
 *
 * Tolerates a missing `.exe`, because that is how people say the name of a
 * program and typing it the other way is not a mistake worth punishing.
 */
export function matchProcess(
  names: string[],
  running: Set<string>,
): string | undefined {
  for (const raw of names) {
    const name = raw.trim().toLowerCase();
    if (!name) continue;
    if (running.has(name)) return name;
    if (!name.includes('.') && running.has(`${name}.exe`)) return `${name}.exe`;
  }
  return undefined;
}

export { parseTasklist, parsePs };
