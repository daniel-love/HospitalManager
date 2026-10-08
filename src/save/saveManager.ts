/**
 * Save slots in IndexedDB, autosave rotation, and file export/import.
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

let dbPromise: Promise<IDBPDatabase<HospitalDB>> | null = null;

function db(): Promise<IDBPDatabase<HospitalDB>> {
  dbPromise ??= openDB<HospitalDB>("hospital-manager", 1, {
    upgrade(d) {
      d.createObjectStore("saves", { keyPath: "id" });
    },
  });
  return dbPromise;
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
  return { id, meta: file.meta, autosave: false };
}

/** Writes to the oldest of the rotating autosave slots. */
export async function autosave(state: SimState): Promise<void> {
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
  const file = encodeSave(state, "Autosave");
  await d.put("saves", { id: `${AUTOSAVE_PREFIX}${target + 1}`, meta: file.meta, file });
}

export async function loadGame(id: string): Promise<SimState> {
  const record = await (await db()).get("saves", id);
  if (!record) throw new SaveError("That save no longer exists");
  return decodeSave(record.file).state;
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
