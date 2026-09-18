export interface Flags {
  _: string[];
  [key: string]: string | boolean | string[] | undefined;
}

/** Minimal `--flag value` / `--flag` parser; no dependency worth adding for this. */
export function parseFlags(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!arg.startsWith('--')) {
      flags._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i++;
    }
  }
  return flags;
}

/** Fixed-width table, so output stays readable when piped. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (c ?? '').padEnd(widths[i]!))
      .join('  ')
      .trimEnd();

  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)]
    .join('\n')
    .concat('\n');
}

/** HSV (h 0-360, s and v 0-1) to 8-bit RGB. */
export function hsvToRgb(
  h: number,
  s: number,
  v: number,
): { r: number; g: number; b: number } {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  const rgb =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];

  return {
    r: Math.round((rgb[0]! + m) * 255),
    g: Math.round((rgb[1]! + m) * 255),
    b: Math.round((rgb[2]! + m) * 255),
  };
}
