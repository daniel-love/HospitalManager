/**
 * Plain-English views of the simulation for the UI: what a patient or member
 * of staff is doing, the staff roster, and the daily report. Pure functions
 * of SimState, so they're easy to test.
 */
import {
  conditionById,
  roleNames,
  roomById,
  specialtyById,
  staffRoleById,
  staffRoleSections,
} from "@data/catalogue";
import { specialtyIds } from "@data/schema";
import { FOUR_HOUR_MINS, TRIAGE_CATEGORIES, TRIAGE_TARGET_MINS } from "@data/patients";
import {
  onSite,
  type Job,
  type Patient,
  type PatientStage,
  type Point,
  type Staff,
} from "@sim/agents";
import {
  couchStatus,
  freeCouches,
  missingRoom,
  receptionDesks,
  seatCount,
  staffedDesks,
} from "@sim/places";
import type { SimState } from "@sim/state";
import { onTrolley, trolleyStop } from "@sim/systems/admissions";
import { ambulancesWaiting, parkingSpaces } from "@sim/systems/ambulances";
import {
  deathStatus,
  deathSteps,
  deathStepStatus,
  mortuarySpaces,
  type DeathStep,
} from "@sim/systems/deaths";
import { inCare } from "@sim/systems/curtains";
import { bedCover, obsInterval, stationsSeeing } from "@sim/systems/monitoring";
import { annualCost } from "@sim/systems/finance";
import { formatWait, inAE } from "@sim/systems/patients";
import { canDo, staffTitle } from "@sim/systems/staffing";
import { analysers, pendingResults } from "@sim/systems/diagnostics";
import { clockFromTick, TICKS_PER_MINUTE } from "@sim/time";
import { FloorType, isPublic, tileIndex } from "@sim/world/grid";
import { roomAt, roomOfObject } from "@sim/world/rooms";
import type {
  AgentInfo,
  DeathChecklistItem,
  PatientRow,
  PatientTable,
  ReportData,
  RosterData,
  StaffRow,
  StaffTable,
} from "@ui/store";

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

const STAGE_LABELS: Record<PatientStage, string> = {
  awaiting_handover: "Waiting for ambulance handover",
  queueing: "Queueing at reception",
  booking: "Booking in",
  waiting_triage: "Waiting for triage",
  called_triage: "Going to triage",
  triage: "Being triaged",
  waiting_treatment: "Waiting for treatment",
  called_treatment: "Going to a cubicle or bay",
  in_cubicle: "In a cubicle or bay",
  collapsed: "Cardiac arrest: crash team",
  awaiting_bed: "Admitted: waiting for a ward bed",
  transferring: "Being taken to the ward",
  on_ward: "On a ward",
  deceased: "Died",
  to_mortuary: "Being taken to the mortuary",
  in_mortuary: "In the mortuary",
  leaving: "Leaving",
};

const OUTCOME_LABELS: Record<NonNullable<Patient["outcome"]>, string> = {
  discharged: "Discharged home",
  lwbs: "Left without being seen",
  transferred: "Transferred to intensive care",
  transferred_out: "Transferred to another hospital",
  died: "Died",
};

function clockAt(tick: number): string {
  const { hour, minute } = clockFromTick(tick);
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function minsSince(state: SimState, tick: number): number {
  return Math.floor((state.tick - tick) / TICKS_PER_MINUTE);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Why a patient isn't moving on right now, in plain English: what they're
 * waiting for and what's holding it up. Null when nothing is (they're being
 * seen, or walking somewhere).
 */
export function waitReason(state: SimState, p: Patient): string | null {
  if (p.stage === "queueing") return queueReason(state, p);
  if (p.stage === "booking") {
    const desk = p.desk === null ? undefined : state.objects[p.desk];
    const staffed = desk && staffedDesks(state).some((d) => d.id === desk.id);
    return staffed || p.path.length > 0 ? null : "Waiting for the receptionist to return";
  }
  if (p.stage === "collapsed") {
    const lead = Object.values(state.jobs).find(
      (j) => j.patientId === p.id && j.kind === "resus" && j.step === 0,
    );
    if (lead?.state === "working") return null;
    const doctors = Object.values(state.staff).filter((s) => s.role === "junior_doctor");
    return doctors.length === 0
      ? "No doctor on staff: waiting for the hospital's arrest team"
      : "Waiting for a doctor to reach them";
  }
  const job = Object.values(state.jobs).find(
    (j) =>
      j.patientId === p.id &&
      [
        "triage",
        "treat",
        "handover",
        "referral",
        "arrange_transfer",
        "transfer",
        "ward_discharge",
      ].includes(j.kind),
  );
  if (!job || job.state === "working") return null;
  if (job.state === "assigned") {
    const s = job.staffId === null ? undefined : state.staff[job.staffId];
    return s ? `${staffRoleById.get(s.role)!.name} ${s.name} is on the way` : null;
  }
  if (p.toilet) return "At the toilet, so the next patient is called instead";
  const results = resultsReason(state, p, job);
  if (results) return results;

  const reasons: string[] = [];
  const able = Object.values(state.staff).filter((s) => canDo(s, job));
  const qualified = able.filter(onSite);
  const team = job.specialty ? specialtyById.get(job.specialty)! : null;
  const coming = able.find((s) => s.onCall?.state === "called");
  if (coming) {
    const mins = Math.max(1, Math.ceil((coming.onCall!.at - state.tick) / TICKS_PER_MINUTE));
    reasons.push(
      `${coming.name}, the on-call ${team?.name ?? ""} consultant, is ${formatWait(mins)} away`,
    );
  } else if (qualified.length === 0) {
    reasons.push(
      team
        ? `Nobody from ${team.team} in the hospital`
        : `No ${roleNames(job.roles, true)} on staff`,
    );
  }
  if (job.objectId === null) {
    const room = roomById.get(job.roomType)?.name ?? job.roomType;
    const c = couchStatus(state, job.roomType, job.capabilities);
    const what = job.kind === "transfer" ? "ward bed" : room;
    if (c.total === 0) {
      reasons.push(missingRoom(state, job.roomType, job.capabilities) ?? `No working ${room}`);
    } else if (c.free === 0) {
      const dirty = c.dirty > 0 ? `, ${c.dirty} waiting to be cleaned` : "";
      reasons.push(`No free ${what} (${c.inUse} of ${c.total} in use${dirty})`);
    } else if (job.kind === "transfer" && !hasBedRoute(state, p, job)) {
      reasons.push(
        "No bed-width route to a free ward bed: beds need double doors and corridors 2 tiles wide",
      );
    }
  }
  if (qualified.length > 0 && qualified.every((s) => s.jobId !== null)) {
    const who = team ? `${team.name} doctor` : roleNames(job.roles);
    const whoPlural = team ? `${team.name} doctors` : roleNames(job.roles, true);
    reasons.push(
      qualified.length === 1
        ? `The only ${who} in the hospital is busy`
        : `All ${qualified.length} ${whoPlural} are busy`,
    );
  }
  // Open jobs this one competes with that come first (earlier due).
  const ahead = Object.values(state.jobs).filter(
    (j) =>
      j !== job &&
      j.state === "open" &&
      j.roomType === job.roomType &&
      j.specialty === job.specialty &&
      j.roles.some((r) => job.roles.includes(r)) &&
      (j.dueTick < job.dueTick || (j.dueTick === job.dueTick && j.id < job.id)),
  ).length;
  if (ahead > 0) {
    reasons.push(
      job.kind === "referral"
        ? `${plural(ahead, "patient")} referred earlier first`
        : `${plural(ahead, "more urgent patient")} first`,
    );
  }
  return reasons.length > 0 ? reasons.join(" · ") : "About to be called";
}

/**
 * For a step that needs results: what they're waiting for, e.g. "Waiting for
 * blood results: the sample is on the analyser, back in about 20 min".
 */
function resultsReason(state: SimState, p: Patient, job: Job): string | null {
  if (job.kind !== "treat") return null;
  const step = conditionById.get(p.conditionId)!.pathway[job.step];
  if (!step?.needsResults) return null;
  const pending = pendingResults(state, p);
  if (pending.length === 0) return null;
  const parts = pending.map((i) => {
    if (i.test === "bloods") {
      if (i.done === null) {
        const carry = Object.values(state.jobs).find(
          (j) => j.patientId === p.id && j.kind === "carry_sample",
        );
        if (analysers(state).length === 0) return "blood results: there's no working Pathology Lab";
        if (carry?.state === "open") {
          return Object.values(state.staff).some((s) => s.role === "porter")
            ? "blood results: the sample is waiting for a free porter"
            : "blood results: no porter on staff to take the sample to the lab";
        }
        return "blood results: a porter is taking the sample to the lab";
      }
      if (i.ready === null) {
        return Object.values(state.staff).some((s) => s.role === "biomedical_scientist")
          ? "blood results: the sample is waiting for a biomedical scientist"
          : "blood results: no biomedical scientist on staff to process the sample";
      }
      return `blood results, back in about ${formatWait(Math.max(1, Math.ceil((i.ready - state.tick) / TICKS_PER_MINUTE)))}`;
    }
    const mins = Math.max(1, Math.ceil((i.ready! - state.tick) / TICKS_PER_MINUTE));
    return `the CT report, in about ${formatWait(mins)}`;
  });
  return `Waiting for ${parts.join(", and ")}`;
}

/** Whether any free ward bed can be reached by bed from where the patient is. */
function hasBedRoute(state: SimState, p: Patient, job: Job): boolean {
  const from = { x: Math.round(p.x), y: Math.round(p.y) };
  if (!onTrolley(state, p)) return true;
  return freeCouches(state, job.roomType, job.capabilities, from).some(
    (b) => trolleyStop(state, from, b) !== null,
  );
}

function queueReason(state: SimState, p: Patient): string {
  const reasons: string[] = [];
  if (staffedDesks(state).length === 0) {
    const receptionists = Object.values(state.staff).filter((s) => s.role === "receptionist");
    if (receptionDesks(state).length === 0) reasons.push("A&E Reception isn't working");
    else if (receptionists.length === 0) reasons.push("No receptionist on staff");
    else reasons.push("The receptionist isn't at the desk yet");
  }
  const ahead = Object.values(state.patients).filter(
    (q) =>
      q.stage === "queueing" &&
      (q.times.arrived < p.times.arrived || (q.times.arrived === p.times.arrived && q.id < p.id)),
  ).length;
  reasons.push(ahead > 0 ? `${ahead} ahead in the queue` : "Next to be booked in");
  return reasons.join(" · ");
}

export function describePatient(state: SimState, p: Patient): AgentInfo {
  const condition = conditionById.get(p.conditionId)!;
  const cat = p.category > 0 ? TRIAGE_CATEGORIES[p.category] : null;
  const working = Object.values(state.jobs).find(
    (j) => j.patientId === p.id && j.state === "working",
  );
  let status = STAGE_LABELS[p.stage];
  const step = condition.pathway[p.step];
  const roomName = step ? (roomById.get(step.room)?.name ?? "cubicle") : "cubicle";
  if ((p.stage === "waiting_treatment" || p.stage === "called_treatment") && step) {
    status = `${p.stage === "waiting_treatment" ? "Waiting for" : `Going to a ${roomName} for`} ${step.name.toLowerCase()}`;
  }
  if (p.stage === "in_cubicle") {
    const bedRoom = p.bed === null ? undefined : roomOfObject(state, p.bed);
    const here = bedRoom ? (roomById.get(bedRoom.typeId)?.name ?? roomName) : roomName;
    const label =
      working?.kind === "obs"
        ? "Observations"
        : working?.kind === "handover"
          ? "Being handed over by the ambulance crew"
          : step?.name;
    status = step
      ? working
        ? `${label} (step ${p.step + 1} of ${condition.pathway.length})`
        : here === roomName
          ? `Waiting in ${here} for: ${step.name}`
          : `In ${here}, waiting for a ${roomName} for: ${step.name}`
      : status;
    if (working?.kind === "handover") status = label!;
    const referral = Object.values(state.jobs).find(
      (j) => j.patientId === p.id && j.kind === "referral",
    );
    if (referral && p.specialty) {
      const team = specialtyById.get(p.specialty)!.team;
      status =
        referral.state === "working"
          ? `Being reviewed by ${team}`
          : `Referred to ${team}: waiting for their review`;
    }
  } else if (p.toilet) {
    status = "Using the toilet";
  } else if (p.stage === "leaving") {
    status = OUTCOME_LABELS[p.outcome ?? "discharged"];
  } else if (working?.kind === "obs") {
    status = "Having observations taken";
  } else if (p.stage === "collapsed" && working) {
    status = "Cardiac arrest: being resuscitated";
  }

  let reason = waitReason(state, p);
  const transfer = p.transfer;
  if (transfer && p.stage !== "leaving" && !p.death && p.stage !== "collapsed") {
    const arranging = Object.values(state.jobs).find(
      (j) => j.patientId === p.id && j.kind === "arrange_transfer",
    );
    if (transfer.ambulanceAt !== null) {
      const mins = Math.max(1, Math.ceil((transfer.ambulanceAt - state.tick) / TICKS_PER_MINUTE));
      status = `Waiting for the transfer ambulance: due in about ${formatWait(mins)}`;
    } else {
      status =
        arranging?.state === "working"
          ? "A doctor is arranging their transfer to another hospital"
          : "To be transferred: waiting for a doctor to arrange it";
    }
    reason = [transfer.reason, transfer.ambulanceAt === null ? reason : null]
      .filter(Boolean)
      .join(" · ");
  }

  const needs: string[] = [];
  if (p.stage.startsWith("waiting") && !p.toilet) {
    needs.push(p.seat ? "Has a seat" : "Standing: no free seat");
  }
  // Ward toilet needs aren't modelled yet (left to the ward team), so a
  // bladder carried up from A&E isn't shown once they're on the ward.
  if (p.stage !== "on_ward" && !p.toilet) {
    if (p.bladder >= 90) needs.push("Desperate for the toilet");
    else if (p.bladder >= 70) needs.push("Needs the toilet");
  }

  const t = p.times;
  const byAmbulance = p.ambulanceId !== null;
  const timeline: { label: string; at: string }[] = [
    { label: byAmbulance ? "Arrived by ambulance" : "Arrived", at: clockAt(t.arrived) },
  ];
  if (byAmbulance && t.triaged !== null) {
    const mins = Math.round((t.triaged - t.arrived) / TICKS_PER_MINUTE);
    timeline.push({ label: `Handed over (after ${formatWait(mins)})`, at: clockAt(t.triaged) });
  } else {
    if (t.booked !== null) timeline.push({ label: "Booked in", at: clockAt(t.booked) });
    if (t.triaged !== null) timeline.push({ label: "Triaged", at: clockAt(t.triaged) });
  }
  if (t.seen !== null) timeline.push({ label: "Seen by a clinician", at: clockAt(t.seen) });
  const d = p.deterioration;
  if (d?.noticed != null)
    timeline.push({ label: "Escalated: getting worse", at: clockAt(d.noticed) });
  if (d && p.stage === "collapsed")
    timeline.push({ label: "Cardiac arrest", at: clockAt(d.crash) });
  for (const i of p.investigations) {
    const what = i.test === "bloods" ? "Bloods" : i.test === "xray" ? "X-ray" : "CT scan";
    if (i.test === "bloods") timeline.push({ label: "Bloods sent", at: clockAt(i.requested) });
    else if (i.done !== null) timeline.push({ label: what, at: clockAt(i.done) });
    if (i.ready !== null && i.ready <= state.tick && i.test !== "xray") {
      timeline.push({
        label: i.test === "ct" ? "CT reported" : "Blood results back",
        at: clockAt(i.ready),
      });
    }
  }
  if (t.referred !== null && p.specialty) {
    const name = specialtyById.get(p.specialty)!.name;
    timeline.push({ label: `Referred to ${name}`, at: clockAt(t.referred) });
  }
  if (t.decided !== null) timeline.push({ label: "Decision to admit", at: clockAt(t.decided) });
  if (transfer) {
    timeline.push({ label: "Decision to transfer", at: clockAt(transfer.decided) });
    if (transfer.arranged !== null) {
      timeline.push({ label: "Transfer arranged", at: clockAt(transfer.arranged) });
    }
  }
  if (t.admitted !== null) timeline.push({ label: "Arrived on the ward", at: clockAt(t.admitted) });
  if (t.left !== null) {
    timeline.push({ label: OUTCOME_LABELS[p.outcome ?? "discharged"], at: clockAt(t.left) });
  }
  const leftAE = t.admitted ?? t.left;
  const inDept = minsSince(state, t.arrived) - (leftAE === null ? 0 : minsSince(state, leftAE));
  return {
    kind: "patient",
    id: p.id,
    name: p.name,
    condition: condition.name,
    ...(cat
      ? {
          category: {
            label: `${p.category} ${cat.name}`,
            colour: hex(cat.colour),
            target: cat.targetMins === 0 ? "immediately" : `within ${formatWait(cat.targetMins)}`,
          },
        }
      : {}),
    status,
    reason,
    inDept: formatWait(inDept),
    breached: inDept > FOUR_HOUR_MINS,
    mood: Math.round(p.mood),
    needs,
    timeline,
    ...monitoringInfo(state, p),
    ...(p.death
      ? { afterDeath: afterDeathSteps(state, p), deathStatus: deathStatus(state, p) }
      : {}),
  };
}

const DEATH_STEP_LABELS: Record<DeathStep, string> = {
  verify: "Death verified",
  family: "Family told",
  last_offices: "Last offices",
  to_mortuary: "Taken to the mortuary",
  me_review: "Medical Examiner review",
  release: "Released to the funeral director",
};

/**
 * The process after a death (GAME_DESIGN §5.6), as a checklist: when each
 * step was done, and how the steps in hand are going (the family is told
 * alongside last offices, so that step says who's doing it or what's in the way).
 */
function afterDeathSteps(state: SimState, p: Patient): DeathChecklistItem[] {
  const d = p.death!;
  const current = deathStatus(state, p).step;
  const done: Partial<Record<DeathStep, number | null>> = {
    verify: d.verified,
    family: d.familyTold,
    last_offices: d.lastOffices,
    to_mortuary: d.inMortuary,
    me_review: d.meReviewed,
  };
  const items: DeathChecklistItem[] = [];
  for (const step of deathSteps(p)) {
    const label = DEATH_STEP_LABELS[step];
    const t = done[step] ?? null;
    if (t !== null) items.push({ label, done: true, detail: clockAt(t) });
    // The family are told alongside last offices, so it has its own status.
    // The step in hand's reason is shown above the list, so only its colour here.
    else if (step === current) {
      items.push({ label, done: false, progress: deathStepStatus(state, p, step).progress });
    } else if (step === "family" && d.verified !== null) {
      const s = deathStepStatus(state, p, step);
      items.push({ label, done: false, detail: s.reason, progress: s.progress });
    } else items.push({ label, done: false });
    // The Medical Examiner decides whether the coroner needs to know.
    if (step === "me_review" && d.coroner && d.meReviewed !== null) {
      items.push({ label: "Referred to the coroner", done: true });
    }
  }
  return items;
}

/** Observations and who's watching, for patients whose condition needs monitoring. */
function monitoringInfo(
  state: SimState,
  p: Patient,
): Pick<Extract<AgentInfo, { kind: "patient" }>, "monitoring"> {
  const every = obsInterval(p);
  if (every === null || p.stage === "leaving") return {};
  const obs = p.obs
    ? {
        news: p.obs.news,
        text: `Last obs ${formatWait(minsSince(state, p.obs.tick))} ago (every ${every} min)`,
        overdue: minsSince(state, p.obs.tick) > every,
      }
    : null;
  let watch: string;
  const onBed = p.bed !== null && p.stage === "in_cubicle";
  if (p.stage === "collapsed") watch = "Crash call made";
  else if (p.stage === "awaiting_handover") watch = "The ambulance crew is monitoring them";
  else if (!onBed) watch = "Not on a monitored trolley: only checked at observations";
  else {
    const needsWatch = stationsSeeing(state).has(p.bed!);
    const cover = needsWatch ? bedCover(state, p.bed!) : "blind";
    watch =
      cover === "watched"
        ? "Watched from a staffed nurse station"
        : cover === "remote"
          ? "Covered by a staffed central monitor"
          : cover === "curtained"
            ? inCare(state, p.id)
              ? "Curtains drawn while staff are with them"
              : "Curtains drawn: hidden from the nurse station"
            : cover === "unstaffed"
              ? "In sight of a nurse station, but nobody is at it"
              : "Not visible from any nurse station";
  }
  const d = p.deterioration;
  const flag =
    p.stage === "collapsed"
      ? "Cardiac arrest"
      : d && d.noticed !== null
        ? "Escalated: getting worse, needs urgent review"
        : null;
  return { monitoring: { obs, watch, flag } };
}

export type StaffStatus =
  "free" | "on_the_way" | "waiting" | "working" | "at_desk" | "no_desk" | "off_site";

export interface StaffState {
  status: StaffStatus;
  activity: string;
  /** Share of the current task done (0–1), while working on a job. */
  progress: number | null;
  /** The patient they're working with, if any. */
  patientId: number | null;
}

/** What a member of staff is doing right now. */
export function staffState(state: SimState, s: Staff): StaffState {
  const walking = s.path.length > 0;
  const none = { progress: null, patientId: null };
  if (s.onCall?.state === "home") {
    return { status: "off_site", activity: "On call at home", ...none };
  }
  if (s.onCall?.state === "called") {
    const mins = Math.max(1, Math.ceil((s.onCall.at - state.tick) / TICKS_PER_MINUTE));
    return { status: "off_site", activity: `Called in: arriving in ${formatWait(mins)}`, ...none };
  }
  if (s.onCall?.state === "leaving" && s.jobId === null) {
    return { status: "on_the_way", activity: "Going home: nothing more for them", ...none };
  }
  if (s.role === "receptionist") {
    if (s.desk === null) return { status: "no_desk", activity: "No free reception desk", ...none };
    if (walking) return { status: "on_the_way", activity: "Going to the reception desk", ...none };
    const booking = Object.values(state.patients).find(
      (p) => p.stage === "booking" && p.desk === s.desk && p.path.length === 0,
    );
    return booking
      ? {
          status: "working",
          activity: `Booking in ${booking.name}`,
          progress: null,
          patientId: booking.id,
        }
      : { status: "at_desk", activity: "At the reception desk, waiting for patients", ...none };
  }
  const job = s.jobId === null ? undefined : state.jobs[s.jobId];
  if (!job && s.desk !== null) {
    return walking
      ? { status: "on_the_way", activity: "Going to the nurse station", ...none }
      : { status: "at_desk", activity: "At the nurse station, watching the beds", ...none };
  }
  if (!job) return { status: "free", activity: "Free", ...none };
  const patient = job.patientId === null ? undefined : state.patients[job.patientId];
  const who = patient?.name ?? "a patient";
  let what: string;
  switch (job.kind) {
    case "triage":
      what = `Triage: ${who}`;
      break;
    case "treat": {
      const step = patient && conditionById.get(patient.conditionId)!.pathway[job.step];
      what = `${step?.name ?? "Treatment"}: ${who}`;
      break;
    }
    case "handover":
      what = `Ambulance handover: ${who}`;
      break;
    case "referral":
      what = `Specialty review in A&E: ${who}`;
      break;
    case "arrange_transfer":
      what = `Arranging a transfer to another hospital: ${who}`;
      break;
    case "carry_sample":
      what = `Taking ${who}'s blood sample to the lab`;
      break;
    case "lab_test":
      what = `Processing ${who}'s blood sample`;
      break;
    case "transfer":
      what = `Taking ${who} to the ward`;
      break;
    case "ward_discharge":
      what = `Discharge review on the ward: ${who}`;
      break;
    case "verify_death":
      what = `Verifying the death of ${who}`;
      break;
    case "break_news":
      what = `Speaking with ${who}'s family`;
      break;
    case "last_offices":
      what = `Last offices for ${who}`;
      break;
    case "to_mortuary":
      what = `Taking ${who} to the mortuary`;
      break;
    case "me_review":
      what = `Medical Examiner review: ${who}`;
      break;
    case "debrief":
      what = "Debrief after a resuscitation";
      break;
    case "obs":
      what = `Observations: ${who}`;
      break;
    case "resus":
      what = `Crash call: resuscitating ${who}`;
      break;
    case "clean_cubicle":
      what = "Cleaning a cubicle";
      break;
    case "clean_toilet":
      what = "Cleaning a toilet";
      break;
  }
  const patientId = patient?.id ?? null;
  if (job.state === "working") {
    return {
      status: "working",
      activity: what,
      progress: job.progress / job.durationTicks,
      patientId,
    };
  }
  return walking
    ? { status: "on_the_way", activity: `${what} (on the way)`, progress: null, patientId }
    : {
        status: "waiting",
        activity: `${what} (waiting for the patient)`,
        progress: null,
        patientId,
      };
}

export function staffActivity(state: SimState, s: Staff): string {
  return staffState(state, s).activity;
}

/** Name of the room someone is standing in, or a plain description. */
export function whereIs(state: SimState, a: Point): string {
  const grid = state.floors[0]!;
  const x = Math.round(a.x);
  const y = Math.round(a.y);
  if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return "Outside";
  const room = roomAt(state, 0, x, y);
  if (room) return roomById.get(room.typeId)?.name ?? "—";
  const i = tileIndex(grid, x, y);
  if (grid.door[i] !== 0) return "Doorway";
  switch (grid.floorType[i]) {
    case FloorType.Grass:
      return "Outside";
    case FloorType.Path:
      return isPublic(grid, i) ? "Pavement" : "Footpath";
    case FloorType.Road:
      return isPublic(grid, i) ? "Road" : "Access road";
    default:
      return "Unzoned area";
  }
}

export function describeStaff(state: SimState, s: Staff): AgentInfo {
  return {
    kind: "staff",
    id: s.id,
    name: s.name,
    role: staffTitle(s),
    activity: staffActivity(state, s),
    annualCost: annualCost(s),
    morale: Math.round(s.morale),
    ...(s.role === "consultant" && !s.onCall ? { meDuty: s.meDuty } : {}),
  };
}

export function describeRoster(state: SimState): RosterData {
  const staff = Object.values(state.staff);
  return {
    groups: staffRoleSections().map((section) => ({
      name: section.name,
      roles: section.items.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        annualCost: r.annualCost,
        count: staff.filter((s) => s.role === r.id).length,
        specialist: r.specialist,
        bySpecialty: r.specialist
          ? Object.fromEntries(
              specialtyIds.map((sp) => [
                sp,
                staff.filter((s) => s.role === r.id && s.specialty === sp).length,
              ]),
            )
          : null,
      })),
    })),
    specialties: specialtyIds.map((id) => {
      const sp = specialtyById.get(id)!;
      return { id, name: sp.name, description: sp.description };
    }),
    staff: staff.map((s) => ({
      id: s.id,
      name: s.name,
      role: staffTitle(s),
      activity: staffActivity(state, s),
    })),
    payroll: staff.reduce((sum, s) => sum + annualCost(s), 0),
  };
}

export function describeReport(state: SimState): ReportData {
  const wardBeds = couchStatus(state, "ward", ["inpatient_bed"]);
  const counts = new Map<string, number>();
  for (const p of Object.values(state.patients)) {
    if (!inAE(p)) continue;
    const label = STAGE_LABELS[p.stage];
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const order = Object.values(STAGE_LABELS);
  return {
    today: state.today,
    history: state.history,
    now: [...counts]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label)),
    waitingSeats: seatCount(state),
    fourHourWeek: fourHourShare(
      state.history.slice(-7).reduce(
        (sum, d) => ({
          within4h: sum.within4h + d.stats.within4h,
          departures: sum.departures + d.stats.departures,
        }),
        { within4h: 0, departures: 0 },
      ),
    ),
    mortuary: {
      ...mortuarySpaces(state),
      awaitingReview: Object.values(state.patients).filter(
        (p) => p.death && p.death.meReviewed === null,
      ).length,
    },
    wardBeds: {
      total: wardBeds.total,
      inUse: wardBeds.inUse,
      waiting: Object.values(state.patients).filter((p) => p.stage === "awaiting_bed").length,
    },
    ambulances: {
      parked: Object.values(state.ambulances).filter((a) => a.phase === "parked").length,
      waiting: ambulancesWaiting(state),
      spaces: parkingSpaces(state).length,
    },
    incidents: state.incidents
      .slice(-10)
      .reverse()
      .map((i) => {
        const c = clockFromTick(i.tick);
        return {
          id: i.id,
          when: `Day ${c.day} ${clockAt(i.tick)}`,
          summary: i.summary,
          patient: `${i.patientName} (${conditionById.get(i.conditionId)?.name ?? "unknown"})`,
          where: i.where,
          at: i.at,
          causes: i.causes,
        };
      }),
  };
}

/** Share of departures within 4 hours of arrival (0–1), or null with none yet. */
export function fourHourShare(stats: { within4h: number; departures: number }): number | null {
  return stats.departures === 0 ? null : stats.within4h / stats.departures;
}

/** Patients still in A&E (not on their way out, or admitted to a ward). */
export function patientsInDept(state: SimState): number {
  let n = 0;
  for (const p of Object.values(state.patients)) {
    if (inAE(p)) n++;
  }
  return n;
}

// ---------- People dialog ----------

const STAGE_GROUPS: Record<PatientStage, PatientRow["group"]> = {
  awaiting_handover: "arriving",
  queueing: "arriving",
  booking: "arriving",
  waiting_triage: "waiting",
  called_triage: "treatment",
  triage: "treatment",
  waiting_treatment: "waiting",
  called_treatment: "treatment",
  in_cubicle: "treatment",
  collapsed: "treatment",
  awaiting_bed: "treatment",
  transferring: "treatment",
  on_ward: "ward",
  deceased: "leaving",
  to_mortuary: "leaving",
  in_mortuary: "leaving",
  leaving: "leaving",
};

/** One row per patient still in A&E, most urgent first. */
export function describePatientTable(state: SimState): PatientTable {
  const rows: PatientRow[] = [];
  for (const p of Object.values(state.patients)) {
    // A&E and ward patients (the deceased are shown on the map, not listed).
    if (p.stage === "leaving" || p.death) continue;
    const info = describePatient(state, p);
    if (info.kind !== "patient") continue;
    const onWard = p.stage === "on_ward";
    const inDeptMins = minsSince(state, p.times.arrived);
    // Seen-by targets: triage within 15 min, then the triage category's target.
    const targetMins =
      p.category === 0 ? TRIAGE_TARGET_MINS : TRIAGE_CATEGORIES[p.category]!.targetMins;
    const done = p.category === 0 ? p.times.triaged !== null : p.times.seen !== null;
    const left = targetMins - inDeptMins;
    const homeIn =
      p.stayUntil === null ? 0 : Math.ceil((p.stayUntil - state.tick) / TICKS_PER_MINUTE);
    const target = onWard
      ? {
          text: homeIn > 0 ? `Home in about ${formatWait(homeIn)}` : "Ready to go home",
          overdue: false,
        }
      : p.stage === "awaiting_bed" && p.times.decided !== null
        ? {
            text: `Waiting ${formatWait(minsSince(state, p.times.decided))} for a ward bed`,
            overdue: minsSince(state, p.times.decided) > 4 * 60,
          }
        : done
          ? { text: "Seen", overdue: false }
          : left >= 0
            ? {
                text:
                  p.category === 0
                    ? `Triage due in ${formatWait(left)}`
                    : `To be seen in ${formatWait(left)}`,
                overdue: false,
              }
            : {
                text:
                  p.category === 0
                    ? `Triage overdue ${formatWait(-left)}`
                    : `Should have been seen ${formatWait(-left)} ago`,
                overdue: true,
              };
    const short: string[] = [];
    if (STAGE_GROUPS[p.stage] === "waiting" && !p.seat && !p.toilet) short.push("Standing");
    if (p.toilet) short.push("At the toilet");
    else if (p.stage !== "on_ward") {
      // Ward toilet needs aren't modelled yet.
      if (p.bladder >= 90) short.push("Desperate for the toilet");
      else if (p.bladder >= 70) short.push("Needs the toilet");
    }
    rows.push({
      id: p.id,
      name: p.name,
      condition: info.condition,
      ...(info.category ? { category: { n: p.category, ...info.category } } : {}),
      status: info.status,
      reason: info.reason,
      group: STAGE_GROUPS[p.stage],
      where: whereIs(state, p),
      inDeptMins,
      inDept: info.inDept,
      breached: info.breached,
      target: target.text,
      overdue: target.overdue,
      dueIn: done || onWard ? Infinity : left,
      mood: info.mood,
      needs: short,
    });
  }
  rows.sort((a, b) => a.dueIn - b.dueIn || b.inDeptMins - a.inDeptMins || a.id - b.id);
  const waits = rows.filter((r) => r.group !== "ward").map((r) => r.inDeptMins);
  return {
    rows,
    counts: {
      total: rows.filter((r) => r.group !== "ward").length,
      ward: rows.filter((r) => r.group === "ward").length,
      arriving: rows.filter((r) => r.group === "arriving").length,
      waiting: rows.filter((r) => r.group === "waiting").length,
      treatment: rows.filter((r) => r.group === "treatment").length,
      breached: rows.filter((r) => r.breached).length,
    },
    longestWait: waits.length > 0 ? formatWait(Math.max(...waits)) : null,
  };
}

/** One row per member of staff. */
export function describeStaffTable(state: SimState): StaffTable {
  const rows: StaffRow[] = Object.values(state.staff).map((s) => {
    const st = staffState(state, s);
    const patient = st.patientId === null ? undefined : state.patients[st.patientId];
    return {
      id: s.id,
      name: s.name,
      roleId: s.role,
      role: staffTitle(s),
      status: st.status,
      activity: st.activity,
      progress: st.progress,
      patient: patient ? { id: patient.id, name: patient.name } : null,
      where: onSite(s) ? whereIs(state, s) : "Away from the hospital",
    };
  });
  const busy = rows.filter(
    (r) => r.status !== "free" && r.status !== "at_desk" && r.status !== "off_site",
  ).length;
  return { rows, busy, free: rows.length - busy };
}
