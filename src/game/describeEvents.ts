/**
 * What the HUD's event chips and the Hospital dialog's Events tab show:
 * pressure events forecast or under way, what they do and what the player
 * can do about them, and past ones (systems/pressure.ts).
 */
import { equipmentById, roomById } from "@data/catalogue";
import { POWER } from "@data/maintenance";
import { pressureEventById, type EventFrequency, type StrikeDef } from "@data/pressure";
import type { SimState } from "@sim/state";
import { intensity, isCooled, knownEvents } from "@sim/systems/pressure";
import { strikeCounts } from "@sim/systems/strikes";
import { outbreakRooms } from "@sim/systems/outbreaks";
import { generatorCapacity, isPowered, powerCut } from "@sim/world/service";
import { clockFromTick, formatDate, TICKS_PER_DAY, TICKS_PER_MINUTE } from "@sim/time";

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
    /** A strike: how many will be out, and how many kept at work. */
    note: string | null;
    coming: boolean;
    when: string;
    /** 0–1 now; a wave builds and fades. */
    intensity: number;
    shape: "wave" | "flat";
  }[];
  /** A major incident on standby or under way, for the declare and stand-down buttons. */
  majorIncident: {
    eventId: number;
    cause: string;
    expected: number;
    arrived: number;
    /** P1 casualties still to come. */
    critical: number;
    declared: boolean;
    /** Casualties have started arriving. */
    underWay: boolean;
    /** Off-duty staff asked to come in. */
    asked: number;
    coming: number;
    calledIn: number;
  } | null;
  /** Standby power: generators, how many powered items they cover, and (in a cut) how many are off. */
  power: {
    generators: number;
    capacity: number;
    poweredItems: number;
    cut: boolean;
    without: number;
  };
  /** Rooms with norovirus cases now. */
  outbreak: ReturnType<typeof outbreakRooms>;
  /** In the heat: patient rooms without enough cooling. */
  uncooled: { name: string; count: number }[] | null;
  past: { name: string; dates: string }[];
}

function majorIncident(state: SimState): EventsData["majorIncident"] {
  const mi = state.pressure.majorIncident;
  const e = mi && state.pressure.active.find((a) => a.id === mi.eventId);
  if (!mi || (e && e.announced > state.tick)) return null;
  return {
    eventId: mi.eventId,
    cause: mi.cause,
    expected: mi.expected,
    arrived: mi.arrived,
    critical: mi.casualties.filter((c) => c.conditionId === "major_trauma").length,
    declared: mi.declared !== null,
    underWay: !e || state.tick >= e.start,
    asked: mi.asked,
    coming: mi.coming.length,
    calledIn: mi.calledIn.length,
  };
}

const dayOf = (tick: number) => clockFromTick(tick).day;

function when(state: SimState, start: number, end: number): { coming: boolean; text: string } {
  if (state.tick < start) {
    const days = dayOf(start) - dayOf(state.tick);
    const mins = Math.max(1, Math.round((start - state.tick) / TICKS_PER_MINUTE));
    if (mins < 120) return { coming: true, text: `in ${mins} min` };
    return {
      coming: true,
      text: days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`,
    };
  }
  if (end - start < TICKS_PER_DAY) return { coming: false, text: "under way" };
  const day = Math.floor((state.tick - start) / TICKS_PER_DAY) + 1;
  const of = Math.round((end - start) / TICKS_PER_DAY);
  return { coming: false, text: `day ${day} of ${of}` };
}

function strikeNote(state: SimState, strike: StrikeDef, coming: boolean): string {
  const { out, working } = strikeCounts(state, strike);
  if (strike.mode === "planned_only") {
    return `${out} consultants ${coming ? "will strike" : "on strike"}: no clinics or planned operations ${coming ? "on strike days" : "until it's over"}.`;
  }
  const kept = working > 0 ? `; ${working} kept at work by the derogations` : "";
  return `${out} of your staff ${coming ? "will walk out" : "are on strike"}${kept}.`;
}

export function eventChips(state: SimState): EventChip[] {
  return knownEvents(state).map((e) => {
    const w = when(state, e.start, e.end);
    return {
      id: e.id,
      label: pressureEventById.get(e.defId)!.short,
      when: w.text,
      coming: w.coming,
    };
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
  if (knownEvents(state).some((e) => pressureEventById.get(e.defId)!.heat)) {
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
    majorIncident: majorIncident(state),
    outbreak: outbreakRooms(state),
    power: powerSummary(state),
    active: knownEvents(state).map((e) => {
      const def = pressureEventById.get(e.defId)!;
      const w = when(state, e.start, e.end);
      return {
        id: e.id,
        name: def.name,
        description: def.description,
        levers: def.levers,
        note: def.strike ? strikeNote(state, def.strike, w.coming) : null,
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

function powerSummary(state: SimState): EventsData["power"] {
  const capacity = generatorCapacity(state, state.rooms);
  const poweredItems = Object.values(state.objects).filter(
    (o) => equipmentById.get(o.defId)?.power,
  ).length;
  return {
    generators: capacity / POWER.itemsPerGenerator,
    capacity,
    poweredItems,
    cut: powerCut(state),
    without: Object.values(state.objects).filter((o) => !isPowered(state, o.id)).length,
  };
}
