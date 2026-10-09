/**
 * Player settings, kept in localStorage. Each setting offers a fixed set of
 * sensible choices rather than free entry.
 */
import { effect, signal } from "@preact/signals";
import { MINUTES_PER_DAY } from "@sim/time";

export interface AutosaveOption {
  id: "off" | "6h" | "12h" | "day";
  label: string;
  hint: string;
  /** Game minutes between autosaves; null for off. */
  minutes: number | null;
}

export const AUTOSAVE_OPTIONS: readonly AutosaveOption[] = [
  { id: "6h", label: "Every 6 hours", hint: "At 00:00, 06:00, 12:00 and 18:00", minutes: 6 * 60 },
  { id: "12h", label: "Every 12 hours", hint: "At midnight and midday", minutes: 12 * 60 },
  { id: "day", label: "Every day", hint: "At midnight", minutes: MINUTES_PER_DAY },
  {
    id: "off",
    label: "Off",
    hint: "Only save by hand",
    minutes: null,
  },
];

const DEFAULT_AUTOSAVE: AutosaveOption["id"] = "6h";
const STORAGE_KEY = "hospital-manager:settings";

interface Settings {
  autosave: AutosaveOption["id"];
}

function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<Settings>;
    const autosave = AUTOSAVE_OPTIONS.some((o) => o.id === raw.autosave)
      ? raw.autosave!
      : DEFAULT_AUTOSAVE;
    return { autosave };
  } catch {
    return { autosave: DEFAULT_AUTOSAVE };
  }
}

export const settings = signal<Settings>(loadSettings());
export const settingsOpen = signal(false);

effect(() => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings.value));
  } catch {
    // Storage blocked: settings last for this session only.
  }
});

export function autosaveOption(): AutosaveOption {
  return AUTOSAVE_OPTIONS.find((o) => o.id === settings.value.autosave)!;
}
