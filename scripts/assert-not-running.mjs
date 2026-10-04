/*
 * Refuse to package while Betterleaf is running from the folder being replaced.
 *
 * electron-builder empties release/win-unpacked before writing the new build
 * beside it and renaming it into place. A running copy keeps its exe and DLLs
 * locked, so the emptying deletes everything else — resources.pak, the locale
 * files, snapshot_blob.bin — and then the rename fails. What is left launches,
 * but without Chromium's built-in stylesheet: the page title is drawn across the
 * top, every div is laid out inline, and sliders ignore their values. That
 * happened on 2026-09-30 and went unnoticed for days, because closing the window
 * only hides Betterleaf to the tray, so "it is closed" is easy to believe.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') process.exit(0);

const release = path
  .join(path.dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'app', 'release')
  .toLowerCase();

let paths = [];
try {
  const out = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name = 'Betterleaf.exe'\" | ForEach-Object { $_.ExecutablePath }",
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );
  paths = out.split(/\r?\n/).map((p) => p.trim().toLowerCase()).filter(Boolean);
} catch {
  // Could not ask. Packaging anyway is no worse than before this check existed.
  process.exit(0);
}

if (paths.some((p) => p.startsWith(release))) {
  console.error(
    'Betterleaf is running from packages/app/release, so packaging would delete\n' +
      'half of it and fail. Quit it from the tray icon (closing the window only\n' +
      'hides it), then run this again.',
  );
  process.exit(1);
}
