/**
 * Norovirus outbreaks (GAME_DESIGN §9), spreading patient to patient.
 *
 * It comes in with admissions and visitors while it's going round the
 * community (the norovirus season, an event most winters), and now and
 * then at other times. Each hour, every patient with symptoms (or shedding
 * it after) may pass it to others in the same room, or (on staff hands and
 * shared kit) to a patient in another ward room, and to staff working near
 * them, who are then off sick. Nurses move symptomatic patients into a
 * free side room, where a case alone hardly spreads (isolation); enhanced
 * infection control (a policy) halves spread at a daily cost; restricting
 * visiting cuts what visitors bring in.
 *
 * Closures: the infection prevention and control team closes a room with
 * two or more cases at once to admissions, and reopens it after a deep
 * clean once its last case has been clear for 48 hours. With the policy
 * set to "you decide", they only advise, and the player closes and reopens
 * rooms themselves (they can close one early either way). Patients with it
 * aren't discharged until 48 hours symptom-free.
 */
import { NOROVIRUS } from "@data/infection";
import { pressureEventById } from "@data/pressure";
import { onSite, type Patient } from "../agents";
import { emit } from "../events";
import { nextFloat, nextInt } from "../rng";
import type { Room, SimState } from "../state";
import { TICKS_PER_MINUTE } from "../time";
import { roomAt } from "../world/rooms";
import { freeCouches, reserve } from "../places";
import { dirtyCouch, jobsForPatient, postJob } from "./jobBoard";
import { book } from "./serviceLines";

const TICKS_PER_HOUR = 60 * TICKS_PER_MINUTE;
const INPATIENT_ROOMS = new Set(["ward", "side_room"]);

/** How infectious someone is now: 0 incubating or clear, 1 with symptoms, less after. */
export function infectiousness(state: SimState, p: Patient): number {
  const i = p.infection;
  if (!i || state.tick < i.symptoms) return 0;
  if (state.tick < i.clears) return 1;
  if (state.tick < i.clears + NOROVIRUS.clearHours * TICKS_PER_HOUR)
    return NOROVIRUS.tailInfectivity;
  return 0;
}

export function symptomatic(state: SimState, p: Patient): boolean {
  const i = p.infection;
  return !!i && state.tick >= i.symptoms && state.tick < i.clears;
}

/** Not to be discharged yet: until 48 hours symptom-free. */
export function infectionHold(state: SimState, p: Patient): boolean {
  const i = p.infection;
  return !!i && state.tick < i.clears + NOROVIRUS.clearHours * TICKS_PER_HOUR;
}

/** How much norovirus is going round the community now, 0–1 (the norovirus season). */
function community(state: SimState): number {
  let c = 0;
  for (const e of state.pressure.active) {
    if (!pressureEventById.get(e.defId)!.community) continue;
    if (state.tick < e.start || state.tick >= e.end) continue;
    const t = (state.tick - e.start) / (e.end - e.start);
    c = Math.max(c, Math.sin(Math.PI * t));
  }
  return c;
}

/** Infects someone: incubating now, symptoms later. */
export function infect(state: SimState, p: Patient, acquired: boolean): void {
  if (p.infection || p.death) return;
  const [i0, i1] = NOROVIRUS.incubationHours;
  const [s0, s1] = NOROVIRUS.symptomaticHours;
  const symptoms = state.tick + nextInt(state.rng, i0, i1) * TICKS_PER_HOUR;
  p.infection = {
    caught: state.tick,
    symptoms,
    clears: symptoms + nextInt(state.rng, s0, s1) * TICKS_PER_HOUR,
    acquired,
  };
}

/** A new admission: brought in incubating, while it's going round. */
export function admissionSeed(state: SimState, p: Patient): void {
  // With events off, no outbreaks (and no draws on the random stream).
  if (state.settings.eventFrequency === "off") return;
  const chance = NOROVIRUS.sporadicSeed + NOROVIRUS.admissionSeed * community(state);
  if (nextFloat(state.rng) < chance) infect(state, p, false);
}

/** A visitor sitting down with them: may bring it in, depending on visiting. */
export function visitSeed(state: SimState, p: Patient): void {
  if (state.settings.eventFrequency === "off") return;
  const chance = NOROVIRUS.visitSeed[state.policies.visiting] * community(state);
  if (chance > 0 && nextFloat(state.rng) < chance) infect(state, p, true);
}

function roomOf(state: SimState, p: Patient): Room | undefined {
  return roomAt(state, 0, Math.round(p.x), Math.round(p.y));
}

/** The key a room's closure is saved under: its floor and first tile, like other room settings. */
const keyOf = (room: Room) => `${room.floor}:${room.tiles[0]!}`;

/** Closes an inpatient room to admissions, or reopens it (beds are deep cleaned). */
export function setRoomClosed(
  state: SimState,
  room: Room,
  closed: boolean,
  by: "ipc" | "player",
): void {
  const grid = state.floors[room.floor]!;
  for (const key of Object.keys(state.closedRooms)) {
    const [floor, tile] = key.split(":").map(Number);
    if (floor === room.floor && grid.roomId[tile!] === room.id) delete state.closedRooms[key];
  }
  room.closed = closed;
  if (closed) {
    state.closedRooms[keyOf(room)] = { since: state.tick, by };
    return;
  }
  // A deep clean before anyone new comes in.
  for (const id of room.objectIds) {
    const o = state.objects[id];
    if (o && (o.defId === "hospital_bed" || o.defId === "profiling_bed")) dirtyCouch(state, id);
  }
}

/** Each hour: symptoms start, it spreads, the infection control team acts. */
export function updateOutbreaks(state: SimState): void {
  if (state.tick % TICKS_PER_HOUR !== 0) return;
  const patients = Object.values(state.patients).filter(
    (p) => (p.stage === "on_ward" || p.stage === "transferring") && !p.death,
  );
  const control = state.policies.infectionControl ? NOROVIRUS.enhancedControl : 1;
  if (state.policies.infectionControl) {
    const cost = (patients.length * NOROVIRUS.enhancedCostPerBedDay) / 24;
    state.money -= cost;
    book(state, "supplies", cost, "wards");
  }
  const byRoom = new Map<number, Patient[]>();
  for (const p of patients) {
    const room = roomOf(state, p);
    if (!room || !INPATIENT_ROOMS.has(room.typeId)) continue;
    byRoom.set(room.id, [...(byRoom.get(room.id) ?? []), p]);
  }

  let elsewhere = 0;
  for (const [roomId, here] of byRoom) {
    const room = state.rooms[roomId - 1]!;
    let load = 0;
    for (const p of here) {
      const w = infectiousness(state, p);
      if (w === 0) continue;
      // A case alone in a side room, isolated, hardly spreads.
      const isolated = room.typeId === "side_room" && here.length === 1;
      load += w * (isolated ? NOROVIRUS.isolation : 1);
      // The first symptoms: a case, counted; nurses isolate them if they can.
      if (state.tick === p.infection!.symptoms) onset(state, p, room);
    }
    if (load === 0) continue;
    elsewhere += load;
    const chance = 1 - (1 - NOROVIRUS.roomSpread * control) ** load;
    for (const p of here) if (!p.infection && nextFloat(state.rng) < chance) infect(state, p, true);
    // Staff working here.
    const staffChance = NOROVIRUS.staffCatch * control * load;
    for (const s of Object.values(state.staff)) {
      if (!onSite(s) || s.sickUntil !== null) continue;
      if (roomAt(state, 0, Math.round(s.x), Math.round(s.y))?.id !== roomId) continue;
      if (nextFloat(state.rng) >= staffChance) continue;
      const [lo, hi] = NOROVIRUS.staffOffHours;
      s.sickUntil = state.tick + nextInt(state.rng, lo, hi) * TICKS_PER_HOUR;
    }
  }
  // On hands and shared kit, to another ward room.
  if (elsewhere > 0 && nextFloat(state.rng) < NOROVIRUS.wardSpread * control * elsewhere) {
    const open = patients.filter((p) => !p.infection);
    if (open.length > 0) infect(state, open[nextInt(state.rng, 0, open.length - 1)]!, true);
  }
  for (const p of patients) {
    if (p.infection && symptomatic(state, p)) p.mood = Math.max(0, p.mood - NOROVIRUS.moodPerHour);
    // Not home until 48 hours symptom-free.
    if (p.infection && p.stayUntil !== null) {
      const clear = p.infection.clears + NOROVIRUS.clearHours * TICKS_PER_HOUR;
      if (p.infection.symptoms <= state.tick && p.stayUntil < clear) p.stayUntil = clear;
    }
  }
  closures(state, byRoom);
  let closedBeds = 0;
  for (const r of state.rooms) {
    if (!r.closed) continue;
    closedBeds += r.objectIds.filter((id) => {
      const d = state.objects[id]?.defId;
      return d === "hospital_bed" || d === "profiling_bed";
    }).length;
  }
  state.today.stats.closedBedHours += closedBeds;
}

/** Symptoms start: counted if caught here, and moved to a side room if one's free. */
function onset(state: SimState, p: Patient, room: Room): void {
  if (p.infection!.acquired) state.today.stats.hospitalInfections++;
  if (room.typeId === "side_room" || p.bed === null) return;
  if (jobsForPatient(state, p.id).some((j) => j.kind === "isolate")) return;
  const bed = freeCouches(state, "side_room", ["inpatient_bed"], p)[0];
  if (!bed) return;
  postJob(state, {
    kind: "isolate",
    roles: ["porter", "nurse"],
    patientId: p.id,
    objectId: bed.id,
    roomType: "side_room",
    dueTick: state.tick,
    durationTicks: 1,
  });
  // The side room's bed is theirs.
  reserve(state, bed.id, 0, p.id);
}

/** Closing rooms with cases in, and reopening clear ones (or, with "you decide", advising). */
function closures(state: SimState, byRoom: Map<number, Patient[]>): void {
  const ipc = state.policies.outbreakClosures === "ipc";
  for (const room of state.rooms) {
    if (room.typeId !== "ward") continue;
    const here = byRoom.get(room.id) ?? [];
    const cases = here.filter((p) => symptomatic(state, p)).length;
    const shedding = here.some(
      (p) => infectionHold(state, p) && p.infection!.symptoms <= state.tick,
    );
    if (!room.closed && cases >= NOROVIRUS.closeAtCases) {
      if (ipc) {
        setRoomClosed(state, room, true, "ipc");
        emit(
          state,
          `Norovirus: the infection control team has closed a ward room to admissions (${cases} patients with symptoms). It reopens after a deep clean, 48 hours after the last case is clear.`,
          "warn",
          {
            x: room.bounds.x + Math.floor(room.bounds.w / 2),
            y: room.bounds.y + Math.floor(room.bounds.h / 2),
          },
          undefined,
          undefined,
          "events",
        );
      } else if (state.tick % (6 * TICKS_PER_HOUR) === 0) {
        emit(
          state,
          `Norovirus: ${cases} patients in one ward room have symptoms. The infection control team advises closing it to admissions (select the room).`,
          "warn",
          {
            x: room.bounds.x + Math.floor(room.bounds.w / 2),
            y: room.bounds.y + Math.floor(room.bounds.h / 2),
          },
        );
      }
    } else if (room.closed && !shedding && ipc && state.closedRooms[keyOf(room)]?.by === "ipc") {
      setRoomClosed(state, room, false, "ipc");
      emit(
        state,
        "Norovirus: a ward room has been deep cleaned and reopened to admissions.",
        "info",
      );
    }
  }
}

/** For the room inspector: closed or not, by whom, and how many have symptoms there. */
export function roomClosure(
  state: SimState,
  room: Room,
): { closed: boolean; byTeam: boolean; cases: number } {
  let cases = 0;
  for (const p of Object.values(state.patients)) {
    if (p.stage !== "on_ward" || !symptomatic(state, p)) continue;
    if (roomOf(state, p)?.id === room.id) cases++;
  }
  return {
    closed: room.closed,
    byTeam: state.closedRooms[keyOf(room)]?.by === "ipc",
    cases,
  };
}

/** Rooms with norovirus cases now, for the Events tab. */
export function outbreakRooms(
  state: SimState,
): { name: string; cases: number; closed: boolean; at: { x: number; y: number } }[] {
  const out = new Map<
    number,
    { name: string; cases: number; closed: boolean; at: { x: number; y: number } }
  >();
  for (const p of Object.values(state.patients)) {
    if (p.stage !== "on_ward" || !symptomatic(state, p)) continue;
    const room = roomOf(state, p);
    if (!room) continue;
    const entry = out.get(room.id) ?? {
      name: room.typeId === "side_room" ? "Side Room" : "Ward",
      cases: 0,
      closed: room.closed,
      at: {
        x: room.bounds.x + Math.floor(room.bounds.w / 2),
        y: room.bounds.y + Math.floor(room.bounds.h / 2),
      },
    };
    entry.cases++;
    out.set(room.id, entry);
  }
  return [...out.values()];
}
