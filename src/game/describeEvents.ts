/**
 * What the HUD's event chips and the Hospital dialog's Events tab show:
 * pressure events forecast or under way, what they do and what the player
 * can do about them, and past ones (systems/pressure.ts).
 */
import { roomById } from "@data/catalogue";
import { pressureEventById, type EventFrequency } from "@data/pressure";
import type { SimState } from "@sim/state";
import { intensity, isCooled } from "@sim/systems/pressure";
import { clockFromTick, formatDate, TICKS_PER_DAY } from "@sim/time";

export interface EventChip {
  id: number;
  /** Short: "Flu season", "Heatwave". */
  label: string;
  /** "in 3 days", "day 4 of 6". */
  when: string;
  coming: boolean;
}

export interface EventsData {
  frequency: EventFrequency;
  active: {
    id: number;
    name: string;
    description: string;
    levers: string[];
    coming: boolean;
    when: string;
    /** 0–1 now; a wave builds and fades. */
    intensity: number;
    shape: "wave" | "flat";
  }[];
  /** In the heat: patient rooms without enough cooling. */
  uncooled: { name: string; count: number }[] | null;
  past: { name: string; dates: string }[];
}

const SHORT: Record<string, string> = {
  winter_surge: "Flu season",
  heatwave: "Heatwave",
};

const dayOf = (tick: number) => clockFromTick(tick).day;

function when(state: SimState, start: number, end: number): { coming: boolean; text: string } {
  if (state.tick < start) {
    const days = dayOf(start) - dayOf(state.tick);
    return {
      coming: true,
      text: days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`,
    };
  }
  const day = Math.floor((state.tick - start) / TICKS_PER_DAY) + 1;
  const of = Math.round((end - start) / TICKS_PER_DAY);
  return { coming: false, text: `day ${day} of ${of}` };
}

export function eventChips(state: SimState): EventChip[] {
  return state.pressure.active.map((e) => {
    const w = when(state, e.start, e.end);
    return { id: e.id, label: SHORT[e.defId] ?? e.defId, when: w.text, coming: w.coming };
  });
}

/** Rooms patients spend time in, which need cooling in a heatwave. */
const PATIENT_ROOMS = new Set([
  "waiting_area",
  "minors_cubicle",
  "majors_bay",
  "resus_bay",
  "ward",
  "side_room",
  "recovery",
  "day_surgery_unit",
]);

export function describeEvents(state: SimState): EventsData {
  let uncooled: EventsData["uncooled"] = null;
  // Coming or under way: time to get cooling in.
  if (state.pressure.active.some((e) => pressureEventById.get(e.defId)!.heat)) {
    const counts = new Map<string, number>();
    for (const r of state.rooms) {
      if (!r.valid || !PATIENT_ROOMS.has(r.typeId) || isCooled(state, r)) continue;
      counts.set(r.typeId, (counts.get(r.typeId) ?? 0) + 1);
    }
    uncooled = [...counts].map(([typeId, count]) => ({
      name: roomById.get(typeId)?.name ?? typeId,
      count,
    }));
  }
  return {
    frequency: state.settings.eventFrequency,
    active: state.pressure.active.map((e) => {
      const def = pressureEventById.get(e.defId)!;
      const w = when(state, e.start, e.end);
      return {
        id: e.id,
        name: def.name,
        description: def.description,
        levers: def.levers,
        coming: w.coming,
        when: w.coming
          ? `From ${formatDate(dayOf(e.start))} (${w.text}), until about ${formatDate(dayOf(e.end))}`
          : `Since ${formatDate(dayOf(e.start))}: ${w.text}`,
        intensity: intensity(state, e),
        shape: def.shape,
      };
    }),
    uncooled,
    past: [...state.pressure.past].reverse().map((p) => ({
      name: pressureEventById.get(p.defId)?.name ?? p.defId,
      dates: `${formatDate(dayOf(p.start))} – ${formatDate(dayOf(p.end))}`,
    })),
  };
}
