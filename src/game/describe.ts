/**
 * Plain-English views of the simulation for the UI: what a patient or member
 * of staff is doing, the staff roster, and the daily report. Pure functions
 * of SimState, so they're easy to test.
 */
import { delayedDischarge } from "@sim/systems/discharge";
import { symptomatic } from "@sim/systems/outbreaks";
import {
  conditionById,
  equipmentById,
  roleNames,
  roomById,
  specialtyById,
  staffRoleSections,
} from "@data/catalogue";
import { specialtyIds } from "@data/schema";
import { FOUR_HOUR_MINS, TRIAGE_CATEGORIES, TRIAGE_TARGET_MINS } from "@data/patients";
import {
  onDuty,
  onSite,
  type Job,
  type Outpatient,
  type Patient,
  type PatientStage,
  type MonthReport,
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
import { ambulancesWaiting, parkingSpaces, withAmbulanceCrew } from "@sim/systems/ambulances";
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
import {
  canDo,
  MAX_WEEK_SESSIONS,
  operates,
  roleTitle,
  runsClinics,
  staffTitle,
} from "@sim/systems/staffing";
import { describeJobPlan, jobPlan } from "@sim/systems/clinics";
import { MAX_CLINIC_SESSIONS, MAX_FIXED_SESSIONS, MAX_THEATRE_SESSIONS } from "@data/outpatients";
import { analysers, pendingResults } from "@sim/systems/diagnostics";
import {
  clockFromTick,
  dateOf,
  firstDayOf,
  formatDate,
  monthName,
  TICKS_PER_DAY,
  TICKS_PER_MINUTE,
} from "@sim/time";
import { dailyBlock } from "@sim/systems/funding";
import { reputationFactor } from "@sim/systems/reputation";
import { PRIVATE } from "@data/economy";
import { NURSE_BANDS, SHIFTS } from "@data/staff";
import { inClinic, liveSessions } from "@sim/systems/outpatients";
import { describeRota, nextShift, rotaSummary } from "@sim/systems/rota";
import { emergencyOpOf, inTheatre } from "@sim/systems/theatres";
import { privateIncomeShare, waitingLists } from "@sim/systems/referrals";
import { FloorType, isPublic, tileIndex } from "@sim/world/grid";
import { roomAt, roomOfObject } from "@sim/world/rooms";
import { porterJob } from "@sim/systems/escorts";
import type {
  AgentInfo,
  DeathChecklistItem,
  PatientRow,
  PatientTable,
  ReportData,
  StatementMonth,
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
  with_funeral_director: "Being collected by the funeral director",
  pre_op: "In the Day Surgery Unit for an operation",
  to_theatre: "Going to theatre",
  in_theatre: "In theatre: being operated on",
  in_recovery: "In Recovery",
  post_op: "Back in the Day Surgery Unit after an operation",
  discharge_lounge: "In the discharge lounge, waiting to go home",
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
    return s ? `${roleTitle(s)} ${s.name} is on the way` : null;
  }
  if (p.toilet) return "At the toilet, so the next patient is called instead";
  const results = resultsReason(state, p, job);
  if (results) return results;

  const reasons: string[] = [];
  const able = Object.values(state.staff).filter((s) => canDo(state, s, job));
  const qualified = able.filter(onDuty);
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
        : able.length > 0
          ? `No ${roleNames(job.roles, true)} on duty`
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

/** A trolley patient going to a scan or back with a porter (and maybe a nurse). */
function escortStatus(state: SimState, p: Patient, porter: Job): string {
  const nurse = Object.values(state.jobs).find(
    (j) => j.patientId === p.id && j.kind === "escort" && j.roles.includes("nurse"),
  );
  const scanner = porter.step === 0 ? porter.objectId : p.bed;
  const room = scanner === null ? undefined : roomOfObject(state, scanner);
  const scanRoom = room ? (roomById.get(room.typeId)?.name ?? "scan room") : "scan room";
  if (porter.state === "working") {
    const where = porter.step === 0 ? `to the ${scanRoom}` : "back to their bay";
    return `Being wheeled ${where}${nurse ? " with a nurse" : ""}`;
  }
  const where = porter.step === 0 ? `to the ${scanRoom}` : `back from the ${scanRoom}`;
  if (porter.staffId === null) return `Waiting for a porter to take them ${where}`;
  if (nurse && nurse.state !== "working") return `Waiting for a nurse to go with them ${where}`;
  return `A porter is coming to take them ${where}`;
}

/** Someone in for an outpatient appointment, for the inspector. */
export function describeOutpatient(state: SimState, o: Outpatient): AgentInfo {
  const r = state.referrals[o.referralId];
  const specialty = specialtyById.get(o.specialty)?.name ?? "Outpatients";
  const kind = r?.kind === "follow_up" ? "follow-up" : "first appointment";
  const clinician = state.staff[o.staffId];
  const c = clockFromTick(o.appointment);
  const time = `${String(c.hour).padStart(2, "0")}:${String(c.minute).padStart(2, "0")}`;
  const waited =
    r?.clockStart != null
      ? `On the 18-week clock for ${Math.floor((state.tick - r.clockStart) / TICKS_PER_DAY / 7)} weeks`
      : null;
  const late = state.tick > o.appointment && o.stage === "waiting";
  const status = {
    arriving: "Arriving: heading for Outpatients Reception",
    booking: "Booking in at Outpatients Reception",
    waiting: late
      ? `Waiting to be called (the clinic is running ${formatWait(Math.ceil((state.tick - o.appointment) / TICKS_PER_MINUTE))} late)`
      : "Waiting to be called",
    called: "Called in: going to the clinic room",
    in_clinic: "In their appointment",
    leaving: "Going home",
  }[o.stage];
  return {
    kind: "outpatient",
    id: o.id,
    name: o.name,
    visit: `${specialty}: ${kind}${r?.urgent && r.kind === "first" ? " (urgent)" : ""}`,
    status,
    appointment: clinician ? `${time} with ${clinician.name}` : time,
    rtt: waited,
  };
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
  if (p.stage === "called_treatment" && withAmbulanceCrew(p)) {
    status = `Being wheeled in to a ${roomName} by the ambulance crew`;
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

  const e = p.emergencyOp;
  if (e && !e.done && !p.death && (p.stage === "on_ward" || p.stage === "awaiting_bed")) {
    const op = emergencyOpOf(p)?.name ?? "An operation";
    const mins = Math.round((e.due - state.tick) / TICKS_PER_MINUTE);
    status =
      mins >= 0
        ? `Waiting for emergency surgery (${op.toLowerCase()}): due within ${formatWait(mins)}`
        : `Waiting for emergency surgery (${op.toLowerCase()}): ${formatWait(-mins)} overdue`;
  }
  const porter = p.death ? undefined : porterJob(state, p);
  if (porter && p.stage !== "collapsed") status = escortStatus(state, p, porter);

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
  if (p.retriaged) {
    const now = `${p.category} ${TRIAGE_CATEGORIES[p.category]!.name}`;
    timeline.push({ label: `Re-triaged: ${now}`, at: clockAt(p.retriaged.tick) });
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
            note: p.retriaged
              ? `re-triaged from ${p.retriaged.from} ${TRIAGE_CATEGORIES[p.retriaged.from]!.name} at ${clockAt(p.retriaged.tick)}`
              : `to be seen ${cat.targetMins === 0 ? "immediately" : `within ${formatWait(cat.targetMins)}`}`,
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
  else if (withAmbulanceCrew(p)) watch = "The ambulance crew is monitoring them";
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
  if (s.duty === "off" && !s.onCall && s.sickUntil !== null && state.tick < s.sickUntil) {
    return { status: "off_site", activity: "Off sick", ...none };
  }
  if (s.duty === "off" && !s.onCall) {
    const next = nextShift(state, s);
    return {
      status: "off_site",
      activity: next ? `Off duty: next at work ${next}` : "Off duty",
      ...none,
    };
  }
  if (s.duty === "leaving" && s.jobId === null && !inClinic(state, s) && !inTheatre(state, s)) {
    return { status: "on_the_way", activity: "Going home: end of their shift", ...none };
  }
  const theatre = theatreActivity(state, s);
  if (theatre && s.jobId === null) return theatre;
  const clinic = liveSessions(state).get(s.id);
  if (clinic && s.jobId === null) {
    const name = specialtyById.get(s.specialty!)?.name ?? "Outpatient";
    if (walking)
      return { status: "on_the_way", activity: `Going to their ${name} clinic`, ...none };
    const seeing = Object.values(state.outpatients).find(
      (o) => o.staffId === s.id && (o.stage === "called" || o.stage === "in_clinic"),
    );
    return seeing
      ? {
          status: "working",
          activity: `${name} clinic: seeing ${seeing.name}`,
          progress: null,
          patientId: null,
        }
      : { status: "at_desk", activity: `${name} clinic: waiting for the next patient`, ...none };
  }
  if (s.role === "receptionist") {
    if (s.desk === null) return { status: "no_desk", activity: "No free reception desk", ...none };
    if (walking) return { status: "on_the_way", activity: "Going to the reception desk", ...none };
    const outpatient = Object.values(state.outpatients).find(
      (o) => o.stage === "booking" && o.desk === s.desk,
    );
    if (outpatient) {
      return {
        status: "working",
        activity: `Booking in ${outpatient.name} for clinic`,
        progress: null,
        patientId: null,
      };
    }
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
  if (!job) {
    const mins = Math.floor((state.tick - s.lastActiveTick) / TICKS_PER_MINUTE);
    const activity = mins < 1 ? "Free" : `Free for ${formatWait(mins)}`;
    return { status: "free", activity, ...none };
  }
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
    case "discharge_planning":
      what = `Arranging social care for ${who} to go home`;
      break;
    case "isolate":
      what = `Moving ${who} to a side room: norovirus`;
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
    case "release_body":
      what = `Releasing ${who} to the funeral director`;
      break;
    case "pre_op_check":
      what = `Admitting ${who} for their operation`;
      break;
    case "recovery":
      what = `Looking after ${who} in Recovery`;
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
    case "return_kit":
      what = `Taking the ${kitName(state, job.objectId)} back`;
      break;
    case "escort": {
      const room = job.objectId === null ? undefined : roomOfObject(state, job.objectId);
      const to = room ? (roomById.get(room.typeId)?.name ?? "their scan") : "their scan";
      if (job.roles.includes("nurse")) what = `Escorting ${who} to the ${to} and back`;
      else what = job.step === 0 ? `Taking ${who} to the ${to}` : `Taking ${who} back to their bay`;
      break;
    }
  }
  const patientId = patient?.id ?? null;
  if (job.kit?.at === "store" && job.kind !== "return_kit") {
    return {
      status: "on_the_way",
      activity: `${what} (fetching the ${kitName(state, job.kit.objectId)})`,
      progress: null,
      patientId,
    };
  }
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

/** What a member of a theatre team is doing, if they're in theatre. */
function theatreActivity(state: SimState, s: Staff): StaffState | null {
  const none = { progress: null, patientId: null };
  const op = Object.values(state.operations).find(
    (o) => o.surgeonId === s.id || o.anaesthetistId === s.id || o.practitionerIds.includes(s.id),
  );
  if (op && !(op.phase === "to_recovery" && !op.practitionerIds.includes(s.id))) {
    const p = state.patients[op.patientId];
    const who = p?.name ?? "a patient";
    if (op.phase === "to_recovery") {
      return {
        status: "working",
        activity: `Wheeling ${who} to Recovery`,
        progress: null,
        patientId: p?.id ?? null,
      };
    }
    const doing =
      op.surgeonId === s.id
        ? `Operating on ${who}`
        : op.anaesthetistId === s.id
          ? `Anaesthetising ${who}`
          : `Scrubbed for ${who}'s operation`;
    return op.phase === "gathering"
      ? { status: "on_the_way", activity: `${doing} (getting ready)`, ...none }
      : { status: "working", activity: doing, progress: null, patientId: p?.id ?? null };
  }
  if (inTheatre(state, s)) {
    return { status: "at_desk", activity: "Theatre list: waiting for the next patient", ...none };
  }
  return null;
}

/** "ECG (12-lead)": a piece of shared kit, for activity lines. */
function kitName(state: SimState, objectId: number | null): string {
  const obj = objectId === null ? undefined : state.objects[objectId];
  return (obj && equipmentById.get(obj.defId)?.name) ?? "equipment";
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

/** Off sick or working their notice, for the inspector. */
function staffNotice(state: SimState, s: Staff): string | null {
  if (s.leavesAt !== null) {
    const days = Math.max(1, Math.ceil((s.leavesAt - state.tick) / TICKS_PER_DAY));
    return `Has handed in their notice: leaves in ${days} ${days === 1 ? "day" : "days"}`;
  }
  if (s.sickUntil !== null && state.tick < s.sickUntil) return "Off sick";
  return null;
}

export function describeStaff(state: SimState, s: Staff): AgentInfo {
  return {
    kind: "staff",
    id: s.id,
    name: s.name,
    role: staffTitle(s),
    activity: staffActivity(state, s),
    annualCost: annualCost(s),
    rota: describeRota(state, s),
    morale: Math.round(s.morale),
    skill: Math.round(s.skill),
    fatigue: state.settings.rotas ? Math.round(s.fatigue) : null,
    notice: staffNotice(state, s),
    ...(s.role === "consultant" && s.contract === "resident" ? { meDuty: s.meDuty } : {}),
    ...(runsClinics(s) ? { clinics: clinicPlan(state, s) } : {}),
    ...(operates(s) ? { theatre: theatrePlan(state, s) } : {}),
    ...privatePlans(state, s),
  };
}

/** Their clinic sessions, for the inspector. */
function clinicPlan(state: SimState, s: Staff) {
  const when = jobPlan(state, s).filter((p) => p.kind === "clinic");
  return {
    sessions: s.clinicSessions,
    max: Math.min(MAX_CLINIC_SESSIONS, MAX_FIXED_SESSIONS - (operates(s) ? s.theatreSessions : 0)),
    note:
      when.length > 0
        ? `${describeJobPlan(when)}. In clinic they see booked outpatients and aren't free for other work.`
        : "Each session is a morning (09:00 to 13:00) or afternoon (13:30 to 17:30) seeing booked outpatients, in a clinic room for their specialty.",
  };
}

/** Their theatre lists, for the inspector. */
function theatrePlan(state: SimState, s: Staff) {
  const when = jobPlan(state, s).filter((p) => p.kind === "theatre");
  const anaesthetist = s.specialty === "anaesthetics";
  const note = anaesthetist
    ? "Each list needs an anaesthetist: they're paired with surgeons' lists each week, on the half-days they're needed."
    : when.length > 0
      ? `${describeJobPlan(when)}. On a list they operate on booked patients, with an anaesthetist and two theatre practitioners.`
      : "Each list is a morning (09:00 to 13:00) or afternoon (13:30 to 17:30) in theatre, operating on patients from their waiting list.";
  return {
    sessions: s.theatreSessions,
    max: Math.min(
      MAX_THEATRE_SESSIONS,
      MAX_FIXED_SESSIONS - (runsClinics(s) ? s.clinicSessions : 0),
    ),
    note,
  };
}

/** A Hybrid trust's employed consultants: their private sessions, on top of their NHS job plan. */
function privatePlans(state: SimState, s: Staff) {
  if (state.funding !== "hybrid" || s.role !== "consultant" || s.contract !== "resident") return {};
  const nhs = (runsClinics(s) ? s.clinicSessions : 0) + (operates(s) ? s.theatreSessions : 0);
  const free = MAX_WEEK_SESSIONS - nhs;
  const slots = jobPlan(state, s).filter((p) => p.private);
  const when = (kind: "clinic" | "theatre") => {
    const mine = slots.filter((p) => p.kind === kind);
    return mine.length > 0 ? `${describeJobPlan(mine)}. ` : "";
  };
  return {
    ...(runsClinics(s)
      ? {
          privateClinics: {
            sessions: s.privateClinicSessions,
            max: free - s.privateTheatreSessions,
            note: `${when("clinic")}Private patients, in a Private Patient Unit clinic room: the hospital earns the facility fee and they bill their own. Outside their NHS job plan, but they can't be in two places at once.`,
          },
        }
      : {}),
    ...(operates(s)
      ? {
          privateTheatre: {
            sessions: s.privateTheatreSessions,
            max: free - s.privateClinicSessions,
            note: `${when("theatre")}Private operations, in a Private Patient Unit theatre${s.specialty === "anaesthetics" ? ", paired with surgeons' private lists" : ""}.`,
          },
        }
      : {}),
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
        atWork: staff.filter((s) => s.role === r.id && onSite(s)).length,
        bands:
          r.id === "nurse"
            ? NURSE_BANDS.map((b) => ({
                band: b.band,
                title: b.title,
                annualCost: b.annualCost,
                count: staff.filter((s) => s.role === "nurse" && s.band === b.band).length,
              }))
            : null,
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
    rotas: state.settings.rotas,
    funding: state.funding,
    gapFill: state.policies.gapFill,
    temps: {
      bank: staff.filter((s) => s.contract === "bank").length,
      agency: staff.filter((s) => s.contract === "agency").length,
    },
    rota: rotaSummary(state).map((g) => {
      const days = g.filled.filter((_, i) => i % 2 === 0);
      const nights = g.filled.filter((_, i) => i % 2 === 1);
      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
      const cover = g.cover ?? { day: 0, night: 0 };
      return {
        key: g.key,
        name: g.name,
        people: g.people,
        cover,
        avgDay: sum(days) / 7,
        avgNight: sum(nights) / 7,
        minDay: Math.min(...days),
        minNight: Math.min(...nights),
        filled: g.filled,
        gaps: g.gaps,
        needed: Math.ceil(((cover.day + cover.night) * 7) / SHIFTS.perWeek),
        onNow: g.onNow,
      };
    }),
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
  const statement = (m: MonthReport): StatementMonth => ({
    name: monthName(dateOf(firstDayOf(m.monthIndex))),
    days: m.days,
    ledger: m.ledger,
    flows: m.flows,
    openingCash: m.openingCash,
    closingCash: m.closingCash,
  });
  const last = state.months[state.months.length - 1];
  return {
    today: state.today,
    history: state.history,
    blockDue: dailyBlock(state),
    funding: state.funding,
    reputation: state.reputation,
    reputationFactor: reputationFactor(state),
    privateShare: privateIncomeShare(state),
    privateCap: PRIVATE.incomeCap,
    month: statement(state.month),
    lastMonth: last ? statement(last) : null,
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
    waitingLists: waitingLists(state).map(({ specialty: _id, ...rest }) => rest),
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
          when: `${formatDate(c.day)} ${clockAt(i.tick)}`,
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

// ---------- Patients dialog and Staff screen ----------

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
  with_funeral_director: "leaving",
  pre_op: "waiting",
  to_theatre: "treatment",
  in_theatre: "treatment",
  in_recovery: "treatment",
  post_op: "treatment",
  discharge_lounge: "leaving",
  leaving: "leaving",
};

/** Observations this late are flagged; a few minutes either way is normal. */
const OBS_LATE_MINS = 15;
/** How long a ward patient fit to go home waits before it's a delayed discharge. */
const DISCHARGE_DELAY_MINS = 120;

/**
 * What a patient needs done now, most critical first, each naming the
 * intervention. History (a 4-hour breach in A&E before they were admitted)
 * isn't listed. Deterioration is shown from the sim's truth, as on the map.
 */
function patientAlerts(state: SimState, p: Patient): string[] {
  const alerts: string[] = [];
  // Norovirus: only once it shows.
  if (p.infection && state.tick >= p.infection.symptoms) {
    alerts.push(
      symptomatic(state, p)
        ? `Norovirus: has symptoms${p.infection.acquired ? " (caught here)" : ""}`
        : "Norovirus: recovering, not to go home until 48 hours symptom-free",
    );
  }
  const d = p.deterioration;
  if (p.stage === "collapsed") {
    alerts.push("Cardiac arrest: needs resuscitation");
  } else if (d && state.tick >= d.onset && p.stage !== "leaving") {
    const condition = conditionById.get(p.conditionId)!;
    const fix = condition.pathway.find((s, i) => s.stabilises && i >= p.step);
    const needs = fix ? fix.name.toLowerCase() : "an urgent doctor review";
    alerts.push(
      d.noticed !== null
        ? `Getting worse: escalated, needs ${needs}`
        : `Getting worse, not yet noticed: needs ${needs}`,
    );
  }
  const every = obsInterval(p);
  const last = p.obs?.tick ?? p.times.triaged;
  if (every !== null && last !== null && p.stage !== "collapsed" && p.stage !== "transferring") {
    const over = minsSince(state, last) - every;
    if (over > OBS_LATE_MINS) alerts.push(`Observations overdue by ${formatWait(over)}`);
  }
  const plan = p.discharge;
  if (p.stage === "on_ward" && plan?.fit != null) {
    if (delayedDischarge(state, p)) {
      alerts.push(
        plan.careReady === null
          ? `Fit to go, but waiting for social care: ${plan.planned === null ? "nobody has asked for it yet" : "being arranged"} (a delayed discharge)`
          : `Fit to go, waiting for social care: about ${formatLongWait(Math.ceil((plan.careReady - state.tick) / TICKS_PER_MINUTE))} more (a delayed discharge)`,
      );
    }
  } else if (p.stage === "on_ward" && p.stayUntil !== null && !p.endOfLife) {
    const over = minsSince(state, p.stayUntil);
    if (over > DISCHARGE_DELAY_MINS)
      alerts.push(`Fit to go home: discharge review overdue by ${formatWait(over)}`);
  }
  return alerts;
}

/** A wait in hours and minutes, or in days once it's over two. */
function formatLongWait(mins: number): string {
  return mins >= 48 * 60 ? `${Math.round(mins / (24 * 60))} days` : formatWait(mins);
}

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
      ? p.discharge?.fit != null
        ? delayedDischarge(state, p)
          ? { text: "Fit to go: waiting for social care", overdue: true }
          : { text: "Going home: medicines and transport", overdue: false }
        : {
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
      alerts: patientAlerts(state, p),
      admittedTo: onWard && p.specialty ? specialtyById.get(p.specialty)!.name : null,
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
      breached: rows.filter((r) => r.breached && r.group !== "ward").length,
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
      where: onSite(s) ? whereIs(state, s) : s.onCall ? "On call at home" : "At home",
      atWork: onSite(s) && s.duty !== "leaving",
      morale: Math.round(s.morale),
      skill: Math.round(s.skill),
      fatigue: state.settings.rotas ? Math.round(s.fatigue) : null,
      flags: staffFlags(state, s),
      attention: needsAttention(state, s),
    };
  });
  const atWork = rows.filter((r) => r.atWork);
  const busy = atWork.filter(
    (r) => r.status !== "free" && r.status !== "at_desk" && r.status !== "off_site",
  ).length;
  const staff = Object.values(state.staff);
  return {
    rows,
    busy,
    free: atWork.length - busy,
    atWork: atWork.length,
    sick: staff.filter((s) => isOffSick(state, s)).length,
    notice: staff.filter((s) => s.leavesAt !== null).length,
    bank: staff.filter((s) => s.contract === "bank").length,
    agency: staff.filter((s) => s.contract === "agency").length,
    lowMorale: staff.filter((s) => s.morale < LOW_MORALE).length,
  };
}

/** Morale below this is flagged in the Team tab. */
const LOW_MORALE = 40;
/** Fatigue above this is flagged in the Team tab. */
const VERY_TIRED = 75;

const isOffSick = (state: SimState, s: Staff) => s.sickUntil !== null && state.tick < s.sickUntil;

function needsAttention(state: SimState, s: Staff): boolean {
  return (
    isOffSick(state, s) ||
    s.leavesAt !== null ||
    s.morale < LOW_MORALE ||
    (state.settings.rotas && s.fatigue > VERY_TIRED)
  );
}

/** Short labels for the Team tab: contract, sickness, notice. */
function staffFlags(state: SimState, s: Staff): StaffRow["flags"] {
  const flags: StaffRow["flags"] = [];
  if (s.contract === "bank") flags.push({ label: "Bank", tone: "info" });
  if (s.contract === "agency") flags.push({ label: "Agency", tone: "warn" });
  if (s.contract === "on_call") flags.push({ label: "On call", tone: "info" });
  if (isOffSick(state, s)) flags.push({ label: "Off sick", tone: "warn" });
  if (s.leavesAt !== null) {
    const days = Math.max(1, Math.ceil((s.leavesAt - state.tick) / TICKS_PER_DAY));
    flags.push({ label: `Leaving in ${days}d`, tone: "bad" });
  }
  return flags;
}
