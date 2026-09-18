import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { dialog } from 'electron';
import {
  isNanoleafEffect,
  type NanoleafDevice,
  type NanoleafEffect,
} from '@betterleaf/protocol';

/**
 * What happened when effects were written to a device.
 *
 * Partial success is the normal case, not an error case: a file exported from a
 * Canvas may contain a rhythm effect the Light Panels can take and the Canvas
 * cannot, or vice versa. Reporting per-effect outcomes lets the UI say which
 * ones landed and precisely why the others did not.
 */
export interface ImportOutcome {
  imported: string[];
  skipped: { name: string; reason: string }[];
  cancelled?: boolean;
}

export interface ExportOutcome {
  path: string;
  count: number;
  cancelled?: boolean;
}

const FILTERS = [
  { name: 'Nanoleaf effects', extensions: ['json'] },
  { name: 'All files', extensions: ['*'] },
];

/** Read effects out of a parsed JSON document, accepting one or many. */
export function parseEffectFile(parsed: unknown): NanoleafEffect[] {
  if (Array.isArray(parsed)) return parsed.filter(isNanoleafEffect);
  if (isNanoleafEffect(parsed)) return [parsed];
  // Tolerate the shape a device's own `requestAll` returns, so a raw API
  // response saved to disk imports without being reshaped by hand.
  if (typeof parsed === 'object' && parsed !== null) {
    for (const key of ['animations', 'effects']) {
      const value = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value.filter(isNanoleafEffect);
    }
  }
  return [];
}

/** Save every effect on a device to a JSON file the user picks. */
export async function exportEffectsToFile(
  device: NanoleafDevice,
): Promise<ExportOutcome> {
  const effects = await device.exportEffects();

  const { canceled, filePath } = await dialog.showSaveDialog({
    title: `Export effects from ${device.name}`,
    defaultPath: `${device.name.replace(/[^\w.-]+/g, '-')}-effects.json`,
    filters: FILTERS,
  });

  if (canceled || !filePath) return { path: '', count: 0, cancelled: true };

  await writeFile(filePath, JSON.stringify(effects, null, 2), 'utf8');
  return { path: filePath, count: effects.length };
}

/** Write effects from a JSON file the user picks onto a device. */
export async function importEffectsFromFile(
  device: NanoleafDevice,
): Promise<ImportOutcome> {
  const { canceled, filePaths } = await dialog.showOpenDialog({
    title: `Import effects into ${device.name}`,
    properties: ['openFile'],
    filters: FILTERS,
  });

  const file = filePaths[0];
  if (canceled || !file) return { imported: [], skipped: [], cancelled: true };

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return {
      imported: [],
      skipped: [{ name: path.basename(file), reason: 'That file is not valid JSON.' }],
    };
  }

  const effects = parseEffectFile(parsed);
  if (effects.length === 0) {
    return {
      imported: [],
      skipped: [
        { name: path.basename(file), reason: 'No Nanoleaf effects in that file.' },
      ],
    };
  }

  return writeEffects(device, effects);
}

/**
 * Copy every effect from one device to another.
 *
 * The case that makes export/import worth having with two lights and no cloud:
 * author once, run it on both walls.
 */
export async function copyEffectsBetween(
  from: NanoleafDevice,
  to: NanoleafDevice,
): Promise<ImportOutcome> {
  return writeEffects(to, await from.exportEffects());
}

/**
 * Write a batch, keeping going past the ones that do not fit.
 *
 * One incompatible effect must not abandon the rest of the batch — that would
 * make a single rhythm effect in a file of twenty stop the other nineteen.
 */
async function writeEffects(
  device: NanoleafDevice,
  effects: readonly NanoleafEffect[],
): Promise<ImportOutcome> {
  const outcome: ImportOutcome = { imported: [], skipped: [] };

  for (const effect of effects) {
    try {
      await device.importEffect(effect);
      outcome.imported.push(effect.animName);
    } catch (err) {
      outcome.skipped.push({
        name: effect.animName,
        reason: (err as Error).message,
      });
    }
  }

  return outcome;
}
