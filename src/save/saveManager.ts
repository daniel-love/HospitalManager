/**
 * Save slots in IndexedDB, autosaves, file export/import, and resuming on
 * start-up.
 *
 * Each game (told apart by its seed) has one autosave, overwritten each time,
 * and a save name belongs to one game: saving under a name another game's
 * saves already use is refused, so the list never shows two hospitals under
 * the same name.
 *
 * To resume, localStorage holds the id of the last save written or loaded,
 * plus a "resume snapshot" written as the page closes. The snapshot is
 * synchronous because an IndexedDB write started then is cut off; it's
 * overwritten each time and isn't listed, so reloading never piles up saves.
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { SimState } from "@sim/state";
import { decodeSave, encodeSave, SaveError, type SaveFile, type SaveMeta } from "./codec";

interface SaveRecord {
  id: string;
  meta: SaveMeta;
  file: SaveFile;
}

interface HospitalDB extends DBSchema {
  saves: { key: string; value: SaveRecord };
}

export interface SaveSlot {
  id: string;
  meta: SaveMeta;
  autosave: boolean;
  /** The game's seed, which tells one game's saves from another's. */
  seed: number;
}

/**
 * Autosave ids are "autosave:<seed>". Older versions rotated through
 * "autosave-1" to "autosave-3"; those are still listed until deleted.
 */
const AUTOSAVE_PREFIX = "autosave";
/** Id of the last save written or loaded; "" after New game. */
const LAST_SAVE_KEY = "hospital-manager:last-save";
/** Save file of the game as the page was closed, if it had moved on since the last save. */
const RESUME_KEY = "hospital-manager:resume";

let dbPromise: Promise<IDBPDatabase<HospitalDB>> | null = null;

function db(): Promise<IDBPDatabase<HospitalDB>> {
  dbPromise ??= openDB<HospitalDB>("hospital-manager", 1, {
    upgrade(d) {
      d.createObjectStore("saves", { keyPath: "id" });
    },
  });
  return dbPromise;
}

/**
 * Remembers which save to resume (null after New game). The game now matches
 * that save, so any older resume snapshot is dropped.
 */
export function rememberLastSave(id: string | null): void {
  try {
    localStorage.setItem(LAST_SAVE_KEY, id ?? "");
    localStorage.removeItem(RESUME_KEY);
  } catch {
    // Storage blocked: reloading just starts a new game.
  }
}

/** Saves the game for resuming, synchronously so it's safe as the page closes. */
export function saveResumeSnapshot(state: SimState, name: string): void {
  try {
    localStorage.setItem(RESUME_KEY, JSON.stringify(encodeSave(state, name)));
  } catch (err) {
    // Full or blocked: reloading resumes the last save instead.
    console.warn("Couldn't save the game for resuming", err);
    localStorage.removeItem(RESUME_KEY);
  }
}

function toSlot(r: SaveRecord): SaveSlot {
  return {
    id: r.id,
    meta: r.meta,
    autosave: r.id.startsWith(AUTOSAVE_PREFIX),
    seed: r.file.state.seed,
  };
}

/** All saves, newest first. */
export async function listSaves(): Promise<SaveSlot[]> {
  const records = await (await db()).getAll("saves");
  return records.map(toSlot).sort((a, b) => b.meta.savedAt.localeCompare(a.meta.savedAt));
}

function nameKey(name: string): string {
  return name.trim().toLowerCase();
}

/** True if a different game (another seed) already has a save under this name. */
export function nameTakenByOtherGame(slots: SaveSlot[], name: string, seed: number): boolean {
  const key = nameKey(name);
  return slots.some((s) => s.seed !== seed && nameKey(s.meta.name) === key);
}

/**
 * `name`, or failing that "name (2)", "name (3)"… — the first that no other
 * game's saves use.
 */
export async function uniqueSaveName(name: string, seed: number): Promise<string> {
  const slots = await listSaves();
  let candidate = name;
  for (let n = 2; nameTakenByOtherGame(slots, candidate, seed); n++) candidate = `${name} (${n})`;
  return candidate;
}

/**
 * Saves under a name; saving the same game again under that name overwrites
 * it. Throws SaveError if another game's saves use the name.
 */
export async function saveGame(state: SimState, name: string): Promise<SaveSlot> {
  if (nameTakenByOtherGame(await listSaves(), name, state.seed)) {
    throw new SaveError(`"${name.trim()}" is already used by a different hospital's saves`);
  }
  const file = encodeSave(state, name);
  const id = `save:${nameKey(name)}`;
  await (await db()).put("saves", { id, meta: file.meta, file });
  rememberLastSave(id);
  return toSlot({ id, meta: file.meta, file });
}

/** Overwrites this game's autosave, under the hospital's save name. */
export async function autosave(state: SimState, name: string): Promise<void> {
  const file = encodeSave(state, name);
  const id = `${AUTOSAVE_PREFIX}:${state.seed}`;
  await (await db()).put("saves", { id, meta: file.meta, file });
  rememberLastSave(id);
}

export interface LoadedSave {
  /** The hospital's name, as it was saved under. */
  name: string;
  state: SimState;
}

export async function loadGame(id: string): Promise<LoadedSave> {
  const record = await (await db()).get("saves", id);
  if (!record) throw new SaveError("That save no longer exists");
  const { meta, state } = decodeSave(record.file);
  rememberLastSave(id);
  return { name: meta.name, state };
}

/**
 * The game to resume on start-up: the resume snapshot if there is one,
 * otherwise the last save written or loaded (or, if nothing has been
 * remembered yet, the newest save). Null after New game or with no saves.
 */
export async function loadLastSave(): Promise<LoadedSave | null> {
  let snapshot: string | null;
  let id: string | null;
  try {
    snapshot = localStorage.getItem(RESUME_KEY);
    id = localStorage.getItem(LAST_SAVE_KEY);
  } catch {
    return null;
  }
  try {
    if (snapshot !== null) {
      const { meta, state } = decodeSave(JSON.parse(snapshot));
      return { name: meta.name, state };
    }
    if (id === "") return null;
    id ??= (await listSaves())[0]?.id ?? null;
    return id === null ? null : await loadGame(id);
  } catch (err) {
    // Deleted or unreadable: forget it so the next reload doesn't try again.
    rememberLastSave(null);
    throw err;
  }
}

export async function deleteSave(id: string): Promise<void> {
  await (await db()).delete("saves", id);
}

/** Downloads a save as a .hospital.json file. */
export async function exportSave(id: string): Promise<void> {
  const record = await (await db()).get("saves", id);
  if (!record) throw new SaveError("That save no longer exists");
  const blob = new Blob([JSON.stringify(record.file)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${record.meta.name.replace(/[^\w -]+/g, "_") || "hospital"}.hospital.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Reads a save file chosen by the player. Throws SaveError if it's invalid. */
export async function importSaveFile(file: File): Promise<SimState> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    throw new SaveError("That file isn't a save (not JSON)");
  }
  return decodeSave(raw).state;
}
