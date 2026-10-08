/**
 * Upgrades older save files to the current version, one step at a time.
 * When SIM_STATE_VERSION goes from N to N+1, add a `N: (save) => ...` entry
 * that transforms a version-N save into a version-N+1 save.
 */
import { SIM_STATE_VERSION } from "@sim/state";

type RawSave = Record<string, unknown> & { version: number };

const migrations: Record<number, (save: RawSave) => RawSave> = {};

export function migrate(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || !("version" in raw)) return raw;
  let save = raw as RawSave;
  while (typeof save.version === "number" && save.version < SIM_STATE_VERSION) {
    const step = migrations[save.version];
    if (!step) break; // Leave it for validation to reject.
    save = { ...step(save), version: save.version + 1 };
  }
  return save;
}
