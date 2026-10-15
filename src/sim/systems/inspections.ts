/**
 * CQC inspections and ratings (GAME_DESIGN §10), and VIP visits.
 *
 * Inspections are unannounced. The first comes in the hospital's first few
 * months; after that, sooner the worse it's rated (CQC.nextAfterDays), and
 * early if concerns pile up (unexpected deaths, complaints, incidents). On
 * the day, a team walks round from 09:00 to 17:00, seeing patient areas and
 * noting what's good and what isn't: cleanliness, broken kit, crowding and
 * corridor care, patients' mood, isolation, the heat. Each of CQC's five key
 * questions gets a score from the last three months' data blended with what
 * they saw, and a rating; the overall rating follows CQC's aggregation
 * rules. The report is published a week later: reputation moves, and an
 * Inadequate overall rating puts an NHS trust in special measures (NHS
 * oversight segment 4: no agency staff, building capped) until it's
 * re-rated better.
 *
 * VIP and media visits (an event) tour one department for an hour or so;
 * what they see moves reputation on the day.
 */
import { roomById } from "@data/catalogue";
import {
  CQC,
  KEY_QUESTIONS,
  RATINGS,
  RATING_NAMES,
  VIP,
  type CqcRating,
  type KeyQuestion,
} from "@data/cqc";
import { pressureEventById } from "@data/pressure";
import { addInto, emptyStats, type FlowStats, type TourAgent } from "../agents";
import { emit } from "../events";
import { fallbackEntrance, siteEntrance } from "../places";
import { nextFloat, nextInt, pick } from "../rng";
import type { CqcFinding, CqcReport, Room, SimState } from "../state";
import { clockFromTick, formatDate, TICKS_PER_DAY, TICKS_PER_MINUTE, tickAt } from "../time";
import { isStandable } from "../world/objects";
import { roomAt } from "../world/rooms";
import { isBroken } from "../world/service";
import { patientsInEscalation } from "./escalation";
import { headTo } from "./movement";
import { inAE } from "./patients";
import { heat, isCooled } from "./pressure";
import { symptomatic } from "./outbreaks";

const TICKS_PER_HOUR = 60 * TICKS_PER_MINUTE;

/** Rooms patients spend time in, which inspectors and visitors walk round. */
const PATIENT_AREAS = new Set([
  "waiting_area",
  "triage_room",
  "minors_cubicle",
  "majors_bay",
  "resus_bay",
  "ward",
  "side_room",
  "outpatient_clinic",
  "outpatients_reception",
  "recovery",
  "day_surgery_unit",
  "xray_room",
  "ct_room",
  "discharge_lounge",
  "toilets",
]);

const roomName = (room: Room) => roomById.get(room.typeId)?.name ?? room.typeId;
const keyOf = (room: Room) => `${room.floor}:${room.tiles[0]!}`;

function roomByKey(state: SimState, key: string): Room | undefined {
  const [floor, tile] = key.split(":").map(Number);
  const id = state.floors[floor!]?.roomId[tile!] ?? 0;
  return id === 0 ? undefined : state.rooms[id - 1];
}

/** A clear tile near the middle of a room, to stand in. */
function standIn(state: SimState, room: Room): { x: number; y: number } | null {
  const grid = state.floors[room.floor]!;
  const tiles = room.tiles
    .map((i) => ({ x: i % grid.width, y: Math.floor(i / grid.width) }))
    .filter((t) => isStandable(grid, t.x, t.y));
  if (tiles.length === 0) return null;
  const cx = room.bounds.x + room.bounds.w / 2;
  const cy = room.bounds.y + room.bounds.h / 2;
  return tiles.reduce((a, b) =>
    Math.abs(b.x - cx) + Math.abs(b.y - cy) < Math.abs(a.x - cx) + Math.abs(a.y - cy) ? b : a,
  );
}

// ---------- What they see ----------

/** What an inspector or VIP notices in a room. */
function observe(state: SimState, room: Room, found: CqcFinding[]): void {
  const name = roomName(room);
  // "an Outpatient Clinic Room", "an X-ray Room", "a Ward".
  const a = /^([AEIOU]|X-ray)/.test(name) ? "an" : "a";
  const A = a === "an" ? "An" : "A";
  const add = (question: KeyQuestion, good: boolean, text: string) => {
    if (!found.some((f) => f.text === text)) found.push({ question, good, text });
  };
  let problems = 0;
  const dirty = room.objectIds.filter((id) => (state.dirt[id] ?? 0) > 0).length;
  if (dirty > 0) {
    add("safe", false, `In ${a} ${name}, beds or trolleys were waiting to be cleaned`);
    problems++;
  }
  if (room.objectIds.some((id) => isBroken(state, id))) {
    add("safe", false, `Broken equipment in ${a} ${name} was out of service`);
    problems++;
  }
  if (!room.valid) {
    add("safe", false, `${A} ${name} couldn't be used as it should`);
    problems++;
  }
  const here = Object.values(state.patients).filter(
    (p) =>
      !p.death &&
      p.stage !== "leaving" &&
      roomAt(state, 0, Math.round(p.x), Math.round(p.y))?.id === room.id,
  );
  if (here.length > 0) {
    const mood = here.reduce((n, p) => n + p.mood, 0) / here.length;
    if (mood < 40) {
      add("caring", false, `Patients in ${a} ${name} told us they were unhappy with their care`);
      problems++;
    } else if (mood >= 70 && here.length >= 2) {
      add("caring", true, `Patients in ${a} ${name} spoke well of the staff`);
    }
  }
  if (room.typeId === "waiting_area" && here.filter((p) => p.standing).length >= 3) {
    add("responsive", false, "The A&E waiting area was so crowded that patients were standing");
    problems++;
  }
  if (room.typeId === "ward") {
    const cases = here.filter((p) => symptomatic(state, p)).length;
    if (cases > 0) {
      add("safe", false, `Patients with norovirus on ${a} ${name} weren't isolated`);
      problems++;
    }
  }
  if (heat(state) > 0 && !isCooled(state, room) && here.length > 0) {
    add("caring", false, `${A} ${name} was uncomfortably hot, with no cooling`);
    problems++;
  }
  if (problems === 0 && here.length > 0) {
    add("safe", true, `${A} ${name} was clean, calm and well equipped`);
  }
}

/** What they notice about the hospital as a whole, on arrival. */
function observeHospital(state: SimState, found: CqcFinding[]): void {
  const add = (question: KeyQuestion, good: boolean, text: string) =>
    found.push({ question, good, text });
  if (patientsInEscalation(state) > 0) {
    add("caring", false, "Patients were being cared for on trolleys in corridors");
  }
  const longWaits = Object.values(state.patients).filter(
    (p) => inAE(p) && state.tick - p.times.arrived > 12 * TICKS_PER_HOUR,
  ).length;
  if (longWaits > 0)
    add("responsive", false, `${longWaits} patients had been in A&E over 12 hours`);
  if (state.today.stats.unfilledShifts > 0) {
    add("well_led", false, "Shifts were short of staff, and the gaps hadn't been filled");
  }
  const staff = Object.values(state.staff).filter(
    (s) => s.contract !== "bank" && s.contract !== "agency" && s.contract !== "privileges",
  );
  if (staff.length > 0) {
    const morale = staff.reduce((n, s) => n + s.morale, 0) / staff.length;
    if (morale < 45) add("well_led", false, "Staff told us morale was low");
    else if (morale >= 70) add("well_led", true, "Staff told us they felt supported and valued");
  }
}

// ---------- The data ----------

/** The last few months' activity, summed. */
function recentStats(state: SimState): { stats: FlowStats; net: number; income: number } {
  const months = [...state.months.slice(-2), state.month];
  const stats = emptyStats();
  let net = 0;
  let income = 0;
  for (const m of months) {
    addInto(stats, m.stats);
    const l = m.ledger;
    const inc = l.block + l.tariff + l.elective + l.outpatients + l.private;
    income += inc;
    net +=
      inc -
      (l.salaries +
        l.bank +
        l.agency +
        l.upkeep +
        l.supplies +
        l.estates +
        l.interest +
        l.transfers);
  }
  return { stats, net, income };
}

/** 0 at `bad`, 100 at `good` (either way round), straight in between. */
function lin(v: number, bad: number, good: number): number {
  const t = (v - bad) / (good - bad);
  return Math.round(100 * Math.max(0, Math.min(1, t)));
}

interface Measure {
  score: number;
  /** What it says, for the report. */
  text: string;
}

const share = (n: number, d: number) => (d === 0 ? null : n / d);
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Each key question's measures from the data, where there's enough to judge. */
function measures(state: SimState): Record<KeyQuestion, Measure[]> {
  const { stats: s, net, income } = recentStats(state);
  const out: Record<KeyQuestion, Measure[]> = {
    safe: [],
    effective: [],
    caring: [],
    responsive: [],
    well_led: [],
  };
  const m = (
    q: KeyQuestion,
    v: number | null,
    bad: number,
    good: number,
    text: (v: number) => string,
  ) => {
    if (v === null) return;
    out[q].push({ score: lin(v, bad, good), text: text(v) });
  };
  const patients = s.departures + s.admissions + s.electiveOps + s.firstAppointments;
  const bedDays = s.bedHours / 24;
  m(
    "safe",
    share(s.incidents * 100, patients),
    5,
    0.5,
    (v) => `${v.toFixed(1)} safety incidents per 100 patients`,
  );
  m(
    "safe",
    share(s.unexpectedDeaths * 1000, patients),
    3,
    0.3,
    (v) => `${v.toFixed(1)} unexpected deaths per 1,000 patients`,
  );
  m(
    "safe",
    bedDays < 30 ? null : (s.hospitalInfections * 1000) / bedDays,
    10,
    0,
    (v) => `${v.toFixed(1)} hospital-acquired infections per 1,000 bed days`,
  );
  m(
    "safe",
    share(s.unfilledShifts, s.shifts + s.unfilledShifts),
    0.15,
    0,
    (v) => `${pct(v)} of shifts' places left unfilled`,
  );
  m(
    "safe",
    bedDays < 30 ? null : (s.corridorNights * 1000) / bedDays,
    50,
    0,
    (v) => `${v.toFixed(0)} nights of corridor care per 1,000 bed days`,
  );
  m(
    "effective",
    share(s.emergencyOnTime, s.emergencyOps),
    0.5,
    0.95,
    (v) => `${pct(v)} of emergency operations on time`,
  );
  m(
    "effective",
    share(s.urgentWithin2w, s.urgentSeen),
    0.6,
    0.95,
    (v) => `${pct(v)} of urgent referrals seen within two weeks`,
  );
  m(
    "effective",
    share(s.ctWithinTarget, s.ctScans),
    0.5,
    0.9,
    (v) => `${pct(v)} of CT scans within an hour of being asked for`,
  );
  m(
    "effective",
    share(s.outliers, s.admissions),
    0.3,
    0,
    (v) => `${pct(v)} of admissions on another specialty's ward`,
  );
  m(
    "effective",
    share(s.delayedBedHours, s.bedHours),
    0.25,
    0.03,
    (v) => `${pct(v)} of bed time held by delayed discharges`,
  );
  m("caring", state.reputation, 30, 85, (v) => `Reputation ${Math.round(v)} out of 100`);
  m(
    "caring",
    share(s.complaints * 1000, patients),
    5,
    0,
    (v) => `${v.toFixed(1)} complaints per 1,000 patients`,
  );
  m(
    "responsive",
    share(s.within4h, s.departures),
    0.6,
    0.95,
    (v) => `${pct(v)} leaving A&E within 4 hours`,
  );
  m(
    "responsive",
    share(s.bedWaitsOver12h * 1000, s.departures),
    20,
    0,
    (v) => `${v.toFixed(1)} 12-hour trolley waits per 1,000 attendances`,
  );
  m(
    "responsive",
    share(s.handoverMins, s.handovers),
    60,
    15,
    (v) => `Ambulance handovers taking ${Math.round(v)} minutes on average`,
  );
  m(
    "responsive",
    share(s.lwbs, s.departures),
    0.1,
    0.02,
    (v) => `${pct(v)} leaving A&E without being seen`,
  );
  m(
    "responsive",
    share(s.cancelledOnDay, s.electiveOps + s.cancelledOnDay),
    0.05,
    0.01,
    (v) => `${pct(v)} of planned operations cancelled on the day`,
  );
  {
    let waiting = 0;
    let within = 0;
    for (const r of Object.values(state.referrals)) {
      if (r.clockStart === null || r.payer !== "nhs") continue;
      waiting++;
      if (state.tick - r.clockStart < 126 * TICKS_PER_DAY) within++;
    }
    m("responsive", share(within, waiting), 0.6, 0.92, (v) => `${pct(v)} waiting under 18 weeks`);
  }
  m("well_led", income === 0 ? null : net / income, -0.1, 0, (v) =>
    v >= 0 ? "Living within its means" : `A deficit of ${pct(-v)} of income`,
  );
  m(
    "well_led",
    state.funding === "private" ? null : state.rating.segment,
    4,
    1,
    (v) => `NHS oversight segment ${v}`,
  );
  const own = Object.values(state.staff).filter(
    (st) => st.contract !== "bank" && st.contract !== "agency" && st.contract !== "privileges",
  );
  if (own.length > 0) {
    m(
      "well_led",
      own.reduce((n, st) => n + st.morale, 0) / own.length,
      30,
      80,
      (v) => `Staff morale ${Math.round(v)} out of 100`,
    );
  }
  m(
    "well_led",
    share(s.sickShifts, s.shifts + s.sickShifts),
    0.08,
    0.03,
    (v) => `${pct(v)} of shifts lost to sickness`,
  );
  return out;
}

function ratingFor(score: number): CqcRating {
  const t = CQC.thresholds;
  return score >= t.outstanding
    ? "outstanding"
    : score >= t.good
      ? "good"
      : score >= t.requires_improvement
        ? "requires_improvement"
        : "inadequate";
}

/**
 * CQC's aggregation: Inadequate overall with two or more Inadequate key
 * questions; Requires Improvement with one Inadequate or two or more
 * Requires Improvement; Outstanding with two or more Outstanding and the
 * rest Good; otherwise Good.
 */
export function aggregate(ratings: CqcRating[]): CqcRating {
  const count = (r: CqcRating) => ratings.filter((x) => x === r).length;
  if (count("inadequate") >= 2) return "inadequate";
  if (count("inadequate") === 1 || count("requires_improvement") >= 2)
    return "requires_improvement";
  if (count("outstanding") >= 2 && count("requires_improvement") === 0) return "outstanding";
  return "good";
}

/** Scores and rates the five key questions from the data and what they saw. */
export function assess(state: SimState, found: CqcFinding[], visited: number): CqcReport {
  const data = measures(state);
  const questions = {} as CqcReport["questions"];
  for (const q of KEY_QUESTIONS) {
    const ms = data[q];
    const dataScore = ms.length === 0 ? 60 : ms.reduce((n, x) => n + x.score, 0) / ms.length;
    const seen = found.filter((f) => f.question === q);
    const seenScore = Math.max(
      0,
      Math.min(
        100,
        75 - 10 * seen.filter((f) => !f.good).length + 5 * seen.filter((f) => f.good).length,
      ),
    );
    const score = Math.round(CQC.dataWeight * dataScore + (1 - CQC.dataWeight) * seenScore);
    const sorted = [...ms].sort((a, b) => a.score - b.score);
    const evidence = [
      ...sorted
        .slice(0, 2)
        .filter((x) => x.score < 60)
        .map((x) => `Concern: ${x.text}`),
      ...sorted
        .slice(-2)
        .filter((x) => x.score >= 80)
        .map((x) => `Strength: ${x.text}`),
      ...seen.map((f) => (f.good ? `Seen: ${f.text}` : `Seen: ${f.text}`)),
    ];
    questions[q] = { rating: ratingFor(score), score, evidence };
  }
  const overall = aggregate(KEY_QUESTIONS.map((q) => questions[q].rating));
  return {
    visited,
    published: visited + CQC.reportDays * TICKS_PER_DAY,
    overall,
    questions,
    findings: found,
  };
}

// ---------- The visit ----------

/** The next weekday morning from `from`, at 09:00. */
function nextWeekdayMorning(from: number): number {
  let day = clockFromTick(from).day;
  for (;;) {
    const at = tickAt(day, CQC.fromHour);
    if (at >= from && (day - 1) % 7 < 5) return at;
    day++;
  }
}

/** Sends a tour round: inspectors over many patient areas, or a VIP party round a few. */
function startTour(
  state: SimState,
  kind: TourAgent["kind"],
  rooms: Room[],
  people: number,
  each: number,
): void {
  const at = siteEntrance(state) ?? fallbackEntrance(state);
  const keys = rooms.map(keyOf);
  for (let i = 0; i < people; i++) {
    // Inspectors split the rooms between them; a VIP party keeps together.
    const mine =
      kind === "inspector"
        ? keys.filter((_, j) => j % people === i).slice(0, each)
        : keys.slice(0, each);
    const a: TourAgent = {
      id: state.nextAgentId++,
      name: kind === "inspector" ? "CQC inspector" : "VIP visitor",
      x: at.x,
      y: at.y,
      prevX: at.x,
      prevY: at.y,
      path: [],
      dest: null,
      pathVersion: state.layoutVersion,
      kind,
      rooms: mine,
      until: null,
      stage: "touring",
    };
    state.tours[a.id] = a;
  }
}

function shuffled<T>(state: SimState, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(nextFloat(state.rng) * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function startInspection(state: SimState): void {
  const rooms = shuffled(
    state,
    state.rooms.filter((r) => PATIENT_AREAS.has(r.typeId)),
  );
  const findings: CqcFinding[] = [];
  observeHospital(state, findings);
  state.cqc.visit = { started: state.tick, findings };
  startTour(state, "inspector", rooms, CQC.team, CQC.roomsEach);
  emit(
    state,
    "CQC inspectors have arrived, unannounced. They'll spend the day walking round patient areas and looking at your data (Hospital → Inspections).",
    "warn",
    undefined,
    undefined,
    undefined,
    "inspections",
  );
}

/** At the end of the day: they leave, and the report is written. */
function endInspection(state: SimState): void {
  const visit = state.cqc.visit!;
  state.cqc.visit = null;
  for (const a of Object.values(state.tours)) if (a.kind === "inspector") a.stage = "leaving";
  state.cqc.pending = assess(state, visit.findings, visit.started);
  emit(
    state,
    `The CQC inspectors have left. Their report will be published on ${formatDate(clockFromTick(state.cqc.pending.published).day)}.`,
    "info",
    undefined,
    undefined,
    undefined,
    "inspections",
  );
}

/** The report is out: ratings change, reputation moves, special measures start or end. */
function publish(state: SimState, report: CqcReport): void {
  const c = state.cqc;
  c.pending = null;
  c.reports.push(report);
  if (c.reports.length > 10) c.reports.shift();
  c.overall = report.overall;
  c.questions = Object.fromEntries(
    KEY_QUESTIONS.map((q) => [q, report.questions[q].rating]),
  ) as Record<KeyQuestion, CqcRating>;
  c.next = report.published + CQC.nextAfterDays[report.overall] * TICKS_PER_DAY;
  state.reputation = Math.max(0, Math.min(100, state.reputation + CQC.reputation[report.overall]));
  const wasIn = c.specialMeasures;
  const inadequate =
    report.overall === "inadequate" || report.questions.well_led.rating === "inadequate";
  c.specialMeasures = inadequate && state.funding !== "private";
  if (c.specialMeasures) {
    state.rating.segment = 4;
    if (state.policies.gapFill === "bank_agency") state.policies.gapFill = "bank";
  }
  emit(
    state,
    `CQC report published: ${RATING_NAMES[report.overall]} overall.` +
      (c.specialMeasures && !wasIn
        ? " The trust is placed in special measures: NHS oversight segment 4, with no agency staff and building capped, until it's re-inspected and rated better."
        : wasIn && !c.specialMeasures
          ? " The trust comes out of special measures."
          : ""),
    RATINGS.indexOf(report.overall) >= 2 ? "info" : "bad",
    undefined,
    undefined,
    undefined,
    "inspections",
  );
}

/** Concerns pile up: inspectors come early. */
function checkConcerns(state: SimState): void {
  const c = state.cqc;
  if (c.visit || c.pending) return;
  if (c.concernsAt !== null && state.tick - c.concernsAt < 60 * TICKS_PER_DAY) return;
  const days = state.history.slice(-30);
  const sum = (k: keyof FlowStats) => days.reduce((n, d) => n + d.stats[k], 0);
  const t = CQC.concerns;
  if (
    sum("unexpectedDeaths") < t.unexpectedDeaths &&
    sum("complaints") < t.complaints &&
    sum("incidents") < t.incidents
  ) {
    return;
  }
  const soon =
    state.tick + nextInt(state.rng, CQC.responsiveDays[0], CQC.responsiveDays[1]) * TICKS_PER_DAY;
  if (soon < c.next) {
    c.next = soon;
    c.concernsAt = state.tick;
  }
}

/** Each tick: inspections and VIP visits start and end, tours move, reports are published. */
export function updateInspections(state: SimState): void {
  const c = state.cqc;
  if (c.pending && state.tick >= c.pending.published) publish(state, c.pending);
  const clock = clockFromTick(state.tick);
  // Inspections only in a game with events (not test fixtures).
  if (state.settings.eventFrequency !== "off") {
    if (
      !c.visit &&
      !c.pending &&
      state.tick >= c.next &&
      state.tick === nextWeekdayMorning(state.tick)
    ) {
      startInspection(state);
    }
    if (clock.hour === 0 && clock.minute === 0 && state.tick % TICKS_PER_MINUTE === 0)
      checkConcerns(state);
  }
  if (c.visit && clock.hour >= CQC.toHour) endInspection(state);
  updateVip(state);
  for (const a of Object.values(state.tours)) moveTour(state, a);
}

function moveTour(state: SimState, a: TourAgent): void {
  if (a.stage === "leaving" || a.rooms.length === 0) {
    a.stage = "leaving";
    const exit = siteEntrance(state) ?? fallbackEntrance(state);
    const arrival = headTo(state, a, exit);
    if (arrival === "arrived" || arrival === "no_route") delete state.tours[a.id];
    return;
  }
  const room = roomByKey(state, a.rooms[0]!);
  const spot = room && standIn(state, room);
  if (!room || !spot) {
    a.rooms.shift();
    return;
  }
  if (a.until !== null) {
    if (state.tick >= a.until) {
      a.rooms.shift();
      a.until = null;
    }
    return;
  }
  const arrival = headTo(state, a, spot);
  if (arrival === "no_route") {
    a.rooms.shift();
    return;
  }
  if (arrival !== "arrived") return;
  const [lo, hi] = a.kind === "inspector" ? CQC.dwellMins : VIP.dwellMins;
  a.until = state.tick + nextInt(state.rng, lo, hi) * TICKS_PER_MINUTE;
  const found = a.kind === "inspector" ? state.cqc.visit?.findings : state.cqc.vip?.findings;
  if (found) observe(state, room, found);
}

// ---------- VIP visits ----------

/** A VIP visit starts with its event; at its end, what they saw moves reputation. */
function updateVip(state: SimState): void {
  const c = state.cqc;
  for (const e of state.pressure.active) {
    if (!pressureEventById.get(e.defId)!.vip || c.vip || state.tick < e.start) continue;
    // One department: A&E if there is one, else the wards, else wherever patients are.
    const areas = state.rooms.filter((r) => PATIENT_AREAS.has(r.typeId));
    const ae = areas.filter((r) =>
      ["waiting_area", "majors_bay", "minors_cubicle", "resus_bay"].includes(r.typeId),
    );
    const wards = areas.filter((r) => r.typeId === "ward" || r.typeId === "side_room");
    const rooms = shuffled(state, ae.length > 0 ? ae : wards.length > 0 ? wards : areas);
    if (rooms.length === 0) continue;
    c.vip = { eventId: e.id, who: pick(state.rng, VIP.visitors), findings: [] };
    startTour(state, "vip", rooms, 3, VIP.rooms);
    emit(
      state,
      `${c.vip.who} has arrived for a visit, and is being shown round.`,
      "info",
      undefined,
      undefined,
      undefined,
      "events",
    );
  }
  if (c.vip && !state.pressure.active.some((e) => e.id === c.vip!.eventId)) {
    const problems = c.vip.findings.filter((f) => !f.good);
    const delta =
      problems.length === 0
        ? VIP.goodVisit
        : Math.max(VIP.worst, -VIP.perProblem * problems.length);
    state.reputation = Math.max(0, Math.min(100, state.reputation + delta));
    emit(
      state,
      problems.length === 0
        ? `${c.vip.who}'s visit went well: everything they saw was clean, calm and well run. Reputation +${delta}.`
        : `${c.vip.who}'s visit made the news for the wrong reasons: ${problems.map((p) => p.text.toLowerCase()).join("; ")}. Reputation ${delta}.`,
      problems.length === 0 ? "info" : "bad",
      undefined,
      undefined,
      undefined,
      "events",
    );
    c.vip = null;
    for (const a of Object.values(state.tours)) if (a.kind === "vip") a.stage = "leaving";
  }
}
