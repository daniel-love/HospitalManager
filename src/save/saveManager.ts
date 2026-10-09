/**
 * Save slots in IndexedDB, autosave rotation, file export/import, and resuming
 * on start-up.
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
}

const AUTOSAVE_SLOTS = 3;
const AUTOSAVE_PREFIX = "autosave-";
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

/** All saves, newest first. */
export async function listSaves(): Promise<SaveSlot[]> {
  const records = await (await db()).getAll("saves");
  return records
    .map((r) => ({ id: r.id, meta: r.meta, autosave: r.id.startsWith(AUTOSAVE_PREFIX) }))
    .sort((a, b) => b.meta.savedAt.localeCompare(a.meta.savedAt));
}

/** Saves under a name; saving again with the same name overwrites it. */
export async function saveGame(state: SimState, name: string): Promise<SaveSlot> {
  const file = encodeSave(state, name);
  const id = `save:${name.trim().toLowerCase()}`;
  await (await db()).put("saves", { id, meta: file.meta, file });
  rememberLastSave(id);
  return { id, meta: file.meta, autosave: false };
}

/** Writes to the oldest of the rotating autosave slots, under the hospital's name. */
export async function autosave(state: SimState, name: string): Promise<void> {
  const d = await db();
  const slots = await Promise.all(
    Array.from({ length: AUTOSAVE_SLOTS }, (_, n) => d.get("saves", `${AUTOSAVE_PREFIX}${n + 1}`)),
  );
  let target = 0;
  for (let n = 0; n < AUTOSAVE_SLOTS; n++) {
    const slot = slots[n];
    if (!slot) {
      target = n;
      break;
    }
    if (slot.meta.savedAt < slots[target]!.meta.savedAt) target = n;
  }
  const file = encodeSave(state, name);
  const id = `${AUTOSAVE_PREFIX}${target + 1}`;
  await d.put("saves", { id, meta: file.meta, file });
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
