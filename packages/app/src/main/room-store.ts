import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import type { Room } from '../shared/types.js';

interface StoreFile {
  version: 1;
  rooms: Room[];
}

/**
 * Rooms on disk.
 *
 * Deliberately a separate file from `devices.json`. That file holds
 * safeStorage-encrypted auth tokens; grouping data is not sensitive and has no
 * business sitting beside them. Keeping them apart also means a corrupt or
 * hand-edited rooms file costs you your grouping, never your pairings.
 *
 * Rooms exist only in Betterleaf — the Nanoleaf API has no equivalent, so
 * nothing here is ever written to a device.
 */
export class RoomStore {
  #file: string;
  #cache: Room[] | undefined;

  constructor(file?: string) {
    this.#file = file ?? path.join(app.getPath('userData'), 'rooms.json');
  }

  async load(): Promise<Room[]> {
    if (this.#cache) return this.#cache;
    try {
      const parsed = JSON.parse(await fs.readFile(this.#file, 'utf8')) as StoreFile;
      this.#cache = (parsed.rooms ?? [])
        .filter((r) => typeof r?.id === 'string' && typeof r?.name === 'string')
        .map((r, i) => ({
          id: r.id,
          name: r.name,
          deviceSerials: Array.isArray(r.deviceSerials) ? r.deviceSerials : [],
          order: typeof r.order === 'number' ? r.order : i,
        }))
        .sort((a, b) => a.order - b.order);
    } catch {
      this.#cache = [];
    }
    return this.#cache;
  }

  async save(rooms: Room[]): Promise<void> {
    this.#cache = rooms;
    const file: StoreFile = { version: 1, rooms };
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    await fs.writeFile(this.#file, JSON.stringify(file, null, 2), 'utf8');
  }

  async create(name: string): Promise<Room> {
    const rooms = [...(await this.load())];
    const room: Room = {
      id: randomUUID(),
      name: name.trim() || 'New room',
      deviceSerials: [],
      order: rooms.length,
    };
    rooms.push(room);
    await this.save(rooms);
    return room;
  }

  async rename(id: string, name: string): Promise<void> {
    const rooms = await this.load();
    const room = rooms.find((r) => r.id === id);
    if (!room) return;
    // Renaming keeps the id, so membership and any saved selection survive it.
    await this.save(rooms.map((r) => (r.id === id ? { ...r, name: name.trim() || r.name } : r)));
  }

  async remove(id: string): Promise<void> {
    const rooms = await this.load();
    await this.save(
      rooms.filter((r) => r.id !== id).map((r, i) => ({ ...r, order: i })),
    );
  }

  async reorder(ids: string[]): Promise<void> {
    const rooms = await this.load();
    const byId = new Map(rooms.map((r) => [r.id, r]));
    const ordered: Room[] = [];
    for (const id of ids) {
      const room = byId.get(id);
      if (room) {
        ordered.push({ ...room, order: ordered.length });
        byId.delete(id);
      }
    }
    // Anything the caller didn't mention keeps its relative order at the end,
    // so a stale id list can never silently drop a room.
    for (const room of byId.values()) ordered.push({ ...room, order: ordered.length });
    await this.save(ordered);
  }

  /**
   * Put a device in a room, or nowhere when `roomId` is null.
   *
   * A device is in at most one room, so this removes it from every other room
   * as part of the same write — there is no window where it is in two.
   */
  async assign(serialNo: string, roomId: string | null): Promise<void> {
    const rooms = await this.load();
    await this.save(
      rooms.map((room) => {
        const without = room.deviceSerials.filter((s) => s !== serialNo);
        const shouldHave = room.id === roomId;
        return {
          ...room,
          deviceSerials: shouldHave ? [...without, serialNo] : without,
        };
      }),
    );
  }

  /** Drop a serial from every room. Called when a device is forgotten. */
  async pruneDevice(serialNo: string): Promise<void> {
    const rooms = await this.load();
    if (!rooms.some((r) => r.deviceSerials.includes(serialNo))) return;
    await this.save(
      rooms.map((r) => ({
        ...r,
        deviceSerials: r.deviceSerials.filter((s) => s !== serialNo),
      })),
    );
  }
}
