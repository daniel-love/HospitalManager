/**
 * Readable consequences (GAME_DESIGN §1.1): every half hour, look for the
 * usual reasons an A&E grinds to a halt and say so in the notifications
 * feed. Also tidies up after layout changes (reservations on items that were
 * sold, cubicles left dirty with no cleaning job).
 */
import {
  CUBICLE_CLEAN_MINS,
  FOUR_HOUR_MINS,
  TOILET_CLEAN_MINS,
  TOILET_USES_BEFORE_CLEAN,
} from "@data/patients";
import { conditionById, roleNames } from "@data/catalogue";
import type { StaffRoleId } from "@data/schema";
import { warn } from "../events";
import { freeToilet, isCouch, missingRoom, receptionDesks, seatCount } from "../places";
import type { SimState } from "../state";
import { TICKS_PER_MINUTE } from "../time";
import { roomOfObject } from "../world/rooms";
import { ambulancesWaiting, needsTrolley } from "./ambulances";
import { hasCleaningJob, postJob, ticksFor } from "./jobBoard";
import { inAE } from "./patients";
import { bedCover, nurseStations, stationsSeeing } from "./monitoring";

const CHECK_EVERY = 30 * TICKS_PER_MINUTE;
/** An ambulance handover over this long is a breach. */
const HANDOVER_BREACH_MINS = 30;
/** The same warning repeats at most every 3 hours. */
const COOLDOWN = 180 * TICKS_PER_MINUTE;

export function updateAlerts(state: SimState): void {
  if (state.tick % CHECK_EVERY !== 0) return;
  tidy(state);

  const patients = Object.values(state.patients);
  const count = (pred: (p: (typeof patients)[number]) => boolean) => patients.filter(pred).length;
  const hasStaff = (role: StaffRoleId) => Object.values(state.staff).some((s) => s.role === role);
  const hasRoom = (type: string) => state.rooms.some((r) => r.valid && r.typeId === type);
  const plural = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

  const queueing = count((p) => p.stage === "queueing" || p.stage === "booking");
  if (queueing > 0 && !hasStaff("receptionist")) {
    warn(
      state,
      "no_receptionist",
      COOLDOWN,
      `${plural(queueing, "patient is", "patients are")} queueing at reception, but there's no receptionist to book them in.`,
      "bad",
    );
  } else if (queueing > 0 && receptionDesks(state).length === 0) {
    warn(
      state,
      "no_desk",
      COOLDOWN,
      "Patients are queueing, but A&E Reception isn't working. Check its checklist.",
      "bad",
    );
  }

  const forTriage = count((p) => p.stage === "waiting_triage");
  if (forTriage > 0 && !hasStaff("nurse")) {
    warn(
      state,
      "no_nurse",
      COOLDOWN,
      `${plural(forTriage, "patient is", "patients are")} waiting for triage, but you have no nurses.`,
      "bad",
    );
  } else if (forTriage > 0 && !hasRoom("triage_room")) {
    warn(
      state,
      "no_triage_room",
      COOLDOWN,
      "Patients are waiting for triage, but there's no working Triage Room.",
      "bad",
    );
  }

  // Treatment steps nobody on staff is allowed to do, e.g. illnesses with only
  // nurse practitioners and no doctor.
  const unstaffed = new Map<string, { step: string; roles: StaffRoleId[]; n: number }>();
  for (const job of Object.values(state.jobs)) {
    if (job.kind !== "treat" || job.state !== "open" || job.roles.some(hasStaff)) continue;
    const p = job.patientId === null ? undefined : state.patients[job.patientId];
    const step = p && conditionById.get(p.conditionId)!.pathway[job.step];
    if (!step) continue;
    const key = `${step.name}|${job.roles.join(",")}`;
    const entry = unstaffed.get(key) ?? { step: step.name, roles: job.roles, n: 0 };
    entry.n++;
    unstaffed.set(key, entry);
  }
  for (const { step, roles, n } of unstaffed.values()) {
    warn(
      state,
      `no_staff_${roles.join("_")}`,
      COOLDOWN,
      `${plural(n, "patient is", "patients are")} waiting for ${step.toLowerCase()}, but you have no ${roleNames(roles, true)}.`,
      "bad",
    );
  }

  const forTreatment = count((p) => p.stage === "waiting_treatment");
  if (forTreatment > 0 && !hasRoom("minors_cubicle")) {
    warn(
      state,
      "no_cubicle",
      COOLDOWN,
      "Patients are waiting for treatment, but there's no working Minors Cubicle.",
      "bad",
    );
  }

  // Ambulances stacking up (GAME_DESIGN §4.1, §5.1).
  const outside = ambulancesWaiting(state);
  if (outside > 0) {
    warn(
      state,
      "ambulances_waiting",
      COOLDOWN / 3,
      `${plural(outside, "ambulance is", "ambulances are")} waiting outside with nowhere to park. Free up the Ambulance Bay or add more spaces.`,
    );
  }
  const slow = patients.filter(
    (p) =>
      p.stage === "awaiting_handover" &&
      state.tick - p.times.arrived > HANDOVER_BREACH_MINS * TICKS_PER_MINUTE,
  );
  if (slow.length > 0) {
    // Why: a room missing the right equipment, or simply no free trolley.
    const why = new Set<string>();
    for (const p of slow.filter(needsTrolley)) {
      const first = conditionById.get(p.conditionId)!.pathway[0]!;
      why.add(
        missingRoom(state, first.room, first.capabilities) ??
          "Majors and Resus have no free trolley",
      );
    }
    const reasons = [...why].map((r) => r.charAt(0).toLowerCase() + r.slice(1));
    warn(
      state,
      "handover_delay",
      COOLDOWN / 3,
      `${plural(slow.length, "ambulance crew has", "ambulance crews have")} waited over ${HANDOVER_BREACH_MINS} minutes to hand over${
        reasons.length > 0 ? `: ${reasons.join("; ")}` : ""
      }.`,
    );
  }

  // After deaths: the mortuary and Medical Examiner.
  const awaitingReview = count((p) => p.stage === "in_mortuary" && p.death?.meReviewed === null);
  if (awaitingReview > 0 && !hasStaff("medical_examiner")) {
    warn(
      state,
      "no_medical_examiner",
      COOLDOWN,
      `${plural(awaitingReview, "death is", "deaths are")} waiting for review, but you have no Medical Examiner. Nobody can be released from the mortuary.`,
      "bad",
    );
  }
  const awaitingPorter = count((p) => p.stage === "deceased" && p.death?.lastOffices != null);
  if (awaitingPorter > 0 && !hasStaff("porter")) {
    warn(
      state,
      "no_porter_mortuary",
      COOLDOWN,
      "A deceased patient is waiting to go to the mortuary, but you have no porters. The bay stays closed.",
      "bad",
    );
  }

  // Exit block: admitted patients stuck on A&E trolleys.
  const forBed = patients.filter((p) => p.stage === "awaiting_bed");
  if (forBed.length > 0 && !hasStaff("porter")) {
    warn(
      state,
      "no_porter",
      COOLDOWN,
      `${plural(forBed.length, "admitted patient is", "admitted patients are")} waiting on A&E trolleys, but you have no porters to take them to a ward.`,
      "bad",
    );
  }
  const longWaits = forBed.filter(
    (p) => p.times.decided !== null && state.tick - p.times.decided > 4 * 60 * TICKS_PER_MINUTE,
  ).length;
  if (longWaits > 0) {
    warn(
      state,
      "exit_block",
      COOLDOWN,
      `${plural(longWaits, "admitted patient has", "admitted patients have")} waited over 4 hours on an A&E trolley for a ward bed. More ward beds (or faster discharges) would free up A&E.`,
    );
  }

  // Majors patients nobody can see (GAME_DESIGN §7).
  const watchable = stationsSeeing(state);
  const unwatched = count(
    (p) =>
      p.stage === "in_cubicle" &&
      p.bed !== null &&
      watchable.has(p.bed) &&
      bedCover(state, p.bed) !== "watched",
  );
  if (unwatched > 0) {
    warn(
      state,
      "unwatched",
      COOLDOWN,
      nurseStations(state).length === 0
        ? `${plural(unwatched, "patient is", "patients are")} on a Majors trolley with no nurse station to watch them. Place a Nurse Station with the trolleys in sight.`
        : `${plural(unwatched, "patient is", "patients are")} on a trolley out of sight of a staffed nurse station. Press O to see coverage.`,
    );
  }

  const dirtyCouches = Object.keys(state.dirt).filter((id) => {
    const obj = state.objects[Number(id)];
    return obj && isCouch(obj.defId);
  }).length;
  if (dirtyCouches > 0 && !hasStaff("cleaner")) {
    warn(
      state,
      "no_cleaner",
      COOLDOWN,
      `${plural(dirtyCouches, "cubicle needs", "cubicles need")} cleaning before the next patient, but you have no cleaners.`,
      "bad",
    );
  }

  const waiting = patients.filter(
    (p) => p.stage === "waiting_triage" || p.stage === "waiting_treatment",
  );
  const standing = waiting.filter((p) => p.seat === null && !p.toilet).length;
  if (standing > 0) {
    const { total } = seatCount(state);
    const text =
      total === 0
        ? `${plural(standing, "patient is", "patients are")} standing: there's no working Waiting Area with seats.`
        : `The waiting area is full: ${plural(standing, "patient is", "patients are")} standing.`;
    warn(state, "standing", COOLDOWN, text);
  }

  const desperate = count((p) => p.bladder >= 90 && !p.toilet && inAE(p));
  if (desperate > 0 && !freeToilet(state, { x: 0, y: 0 })) {
    warn(
      state,
      "no_toilet",
      COOLDOWN,
      `${plural(desperate, "patient urgently needs", "patients urgently need")} a toilet, but none is free and usable.`,
    );
  }

  const breaching = count(
    (p) => inAE(p) && state.tick - p.times.arrived > FOUR_HOUR_MINS * TICKS_PER_MINUTE,
  );
  if (breaching > 0) {
    warn(
      state,
      "breach",
      COOLDOWN / 3,
      `${plural(breaching, "patient has", "patients have")} been in A&E for over 4 hours.`,
      "warn",
    );
  }
}

/** Drops reservations and dirt for items that no longer exist; re-posts lost cleaning jobs. */
function tidy(state: SimState): void {
  for (const key of Object.keys(state.reserved)) {
    const id = Number(key.slice(0, key.indexOf(":")));
    const agent = state.reserved[key]!;
    if (!state.objects[id] || (!state.patients[agent] && !state.staff[agent])) {
      delete state.reserved[key];
    }
  }
  for (const key of Object.keys(state.dirt)) {
    const id = Number(key);
    const obj = state.objects[id];
    if (!obj) {
      delete state.dirt[id];
      continue;
    }
    if (hasCleaningJob(state, id)) continue;
    const isToilet = obj.defId === "toilet";
    if (isToilet && state.dirt[id]! < TOILET_USES_BEFORE_CLEAN) continue;
    postJob(state, {
      kind: isToilet ? "clean_toilet" : "clean_cubicle",
      roles: ["cleaner"],
      objectId: id,
      roomType: roomOfObject(state, id)?.typeId ?? (isToilet ? "toilets" : "minors_cubicle"),
      dueTick: state.tick,
      durationTicks: ticksFor(state.rng, isToilet ? TOILET_CLEAN_MINS : CUBICLE_CLEAN_MINS),
    });
  }
}
