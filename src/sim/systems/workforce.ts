/**
 * Staff as people (GAME_DESIGN §6.2, §6.3): skill, fatigue and morale, and
 * what they lead to. How quickly someone works depends on their skill, how
 * tired they are, their morale, and whether a Band 7 nurse in charge is on
 * duty. Hard shifts wear morale down; low morale and tiredness bring
 * sickness, and low morale resignations. Rota gaps (against the cover, after
 * sickness) can be filled at the start of each shift from the staff bank or
 * an agency, as the hospital's policy allows.
 */
import { specialtyById } from "@data/catalogue";
import type { SpecialtyId, StaffRoleId } from "@data/schema";
import {
  AGENCY,
  BANK,
  FATIGUE,
  MORALE,
  NURSE_BANDS,
  NURSE_IN_CHARGE,
  RESIGNATION,
  SICKNESS,
  SKILL,
  type NurseBand,
} from "@data/staff";
import { onDuty, onSite, type Staff } from "../agents";
import { emit } from "../events";
import { chance, nextInt } from "../rng";
import type { SimState } from "../state";
import { MINUTES_PER_DAY, START_MINUTE_OF_DAY, TICKS_PER_MINUTE } from "../time";
import { inClinic } from "./outpatients";
import { coverFor, groupName, groupOf, slotName, type ShiftTime } from "./rota";
import { createStaff, removeStaff, staffTitle } from "./staffing";
import { inTheatre } from "./theatres";

const TICKS_PER_HOUR = TICKS_PER_MINUTE * 60;

/** A random starting skill for a new member of staff. */
export function startingSkill(
  state: SimState,
  role: StaffRoleId,
  band: NurseBand | null,
  contract: Staff["contract"],
): number {
  const range =
    contract === "agency"
      ? AGENCY.skill
      : role === "nurse"
        ? NURSE_BANDS.find((b) => b.band === (band ?? 5))!.skill
        : SKILL.range;
  return nextInt(state.rng, range[0], range[1]);
}

const inChargeCache = new WeakMap<SimState, { tick: number; on: boolean }>();

/** Whether a Band 7 nurse is on duty now: the shift has a nurse in charge. */
export function hasNurseInCharge(state: SimState): boolean {
  const hit = inChargeCache.get(state);
  if (hit && hit.tick === state.tick) return hit.on;
  const on = Object.values(state.staff).some(
    (s) => s.role === "nurse" && s.band === 7 && onDuty(s),
  );
  inChargeCache.set(state, { tick: state.tick, on });
  return on;
}

/**
 * How much of a job someone gets done each tick (1 = the job's standard
 * pace): skill, tiredness, morale, an agency worker's unfamiliarity with the
 * hospital, and for nurses, a nurse in charge.
 */
export function workRate(state: SimState, s: Staff): number {
  let rate = SKILL.slowest + ((SKILL.fastest - SKILL.slowest) * s.skill) / 100;
  if (s.fatigue > FATIGUE.slowFrom) {
    const over = (s.fatigue - FATIGUE.slowFrom) / (100 - FATIGUE.slowFrom);
    rate *= 1 - over * (1 - FATIGUE.slowest);
  }
  if (s.morale < MORALE.lowFrom) {
    rate *= 1 - ((MORALE.lowFrom - s.morale) / MORALE.lowFrom) * (1 - MORALE.lowSlowest);
  }
  if (s.contract === "agency") rate *= AGENCY.unfamiliar;
  if (s.role === "nurse" && hasNurseInCharge(state)) rate *= 1 + NURSE_IN_CHARGE.speedUp;
  return rate;
}

/** Busy with patients: a job, a clinic or an operation. */
function busy(state: SimState, s: Staff): boolean {
  return s.jobId !== null || inClinic(state, s) || inTheatre(state, s);
}

/** Every tick: fatigue, shift workload, skill, morale and resignations. */
export function updateWorkforce(state: SimState): void {
  if (state.tick % TICKS_PER_MINUTE !== 0) return;
  const hourly = state.tick % TICKS_PER_HOUR === 0;
  const minuteOfDay = (state.tick / TICKS_PER_MINUTE + START_MINUTE_OF_DAY) % MINUTES_PER_DAY;
  for (const s of Object.values(state.staff)) {
    const here = onSite(s);
    const working = here && busy(state, s);
    if (state.settings.rotas) {
      const delta = here
        ? (FATIGUE.perHourOnShift + (working ? FATIGUE.perHourBusy : 0)) / 60
        : -FATIGUE.recoveryPerHour / 60;
      s.fatigue = clamp(s.fatigue + delta);
    }
    if (s.shiftLoad && here) {
      s.shiftLoad.mins++;
      if (working) s.shiftLoad.busy++;
    }
    if (hourly) {
      if (here && s.duty === "on") s.skill = Math.min(SKILL.max, s.skill + SKILL.growthPerHour);
      if (s.morale < MORALE.start) {
        s.morale = Math.min(MORALE.start, s.morale + MORALE.recoveryPerHour);
      } else if (s.morale > MORALE.start) {
        s.morale = Math.max(MORALE.start, s.morale - MORALE.recoveryPerHour);
      }
      if (s.fatigue > FATIGUE.moraleFrom) s.morale = clamp(s.morale - FATIGUE.moralePerHour);
    }
    if (s.leavesAt !== null && state.tick >= s.leavesAt && !here) leave(state, s);
  }
  if (minuteOfDay === 0) resignations(state);
}

const clamp = (n: number) => Math.max(0, Math.min(100, n));

/** Once a day: unhappy staff may hand in their notice. */
function resignations(state: SimState): void {
  for (const s of Object.values(state.staff)) {
    if (s.leavesAt !== null || s.contract === "bank" || s.contract === "agency") continue;
    if (s.morale >= RESIGNATION.fromMorale) continue;
    const p =
      (RESIGNATION.dailyChance * (RESIGNATION.fromMorale - s.morale)) / RESIGNATION.fromMorale;
    if (!chance(state.rng, p)) continue;
    s.leavesAt = state.tick + RESIGNATION.noticeDays * MINUTES_PER_DAY * TICKS_PER_MINUTE;
    state.today.stats.resignations++;
    emit(
      state,
      `${s.name}, ${staffTitle(s)}, has handed in their notice: low morale. They leave in ${RESIGNATION.noticeDays / 7} weeks.`,
      "warn",
      undefined,
      { tab: "team", id: s.id },
    );
  }
}

/** Their notice is up (or their bank or agency shift is over): gone. */
export function leave(state: SimState, s: Staff): void {
  if (s.leavesAt !== null) {
    emit(state, `${s.name}, ${staffTitle(s)}, has left the hospital`, "warn", undefined, {
      tab: "rota",
    });
  }
  removeStaff(state, s);
}

/**
 * At the start of a shift: whether someone calls in sick for it. Likelier
 * with low morale and when tired.
 */
export function callsInSick(state: SimState, s: Staff): boolean {
  let p = SICKNESS.base;
  if (s.morale < SICKNESS.fromMorale) {
    p *=
      1 + ((SICKNESS.lowMoraleFactor - 1) * (SICKNESS.fromMorale - s.morale)) / SICKNESS.fromMorale;
  }
  if (s.fatigue > SICKNESS.tiredFrom) p *= SICKNESS.tiredFactor;
  return chance(state.rng, p);
}

/** At the end of a shift: how hard it was moves their morale. */
export function endOfShift(s: Staff): void {
  const load = s.shiftLoad;
  s.shiftLoad = null;
  if (!load || load.mins === 0) return;
  const share = load.busy / load.mins;
  let delta = 0;
  if (share > MORALE.busyShare) delta -= MORALE.busyHit;
  else if (share < MORALE.quietShare) delta += MORALE.quietLift;
  if (load.short) delta -= MORALE.shortHit;
  s.morale = clamp(s.morale + delta);
}

/** The role, band and specialty a rota group's members have. */
function groupMember(key: string): {
  role: StaffRoleId;
  band: NurseBand | null;
  specialty: SpecialtyId | null;
} {
  const [role, rest] = key.split(":") as [StaffRoleId, string | undefined];
  if (role === "nurse") {
    return { role, band: Number(rest?.replace("band", "") || 5) as NurseBand, specialty: null };
  }
  const specialty = rest && specialtyById.get(rest as SpecialtyId) ? (rest as SpecialtyId) : null;
  return { role, band: null, specialty };
}

/**
 * At the start of a shift: each rota group's gaps against its cover (people
 * not rostered, or off sick) go to the bank, then an agency, as the policy
 * allows. Those at work on a short shift feel it.
 */
export function fillGaps(state: SimState, shift: ShiftTime): void {
  const night = shift.slot % 2 === 1;
  const groups = new Set<string>(Object.keys(state.cover));
  const notes: string[] = [];
  for (const key of groups) {
    const cover = coverFor(state, key);
    if (!cover) continue;
    const want = night ? cover.night : cover.day;
    const present = Object.values(state.staff).filter(
      (s) => groupOf(s) === key && s.duty === "on" && onSite(s) && s.shiftEnd === shift.end,
    );
    const short = want - present.length;
    if (short <= 0) continue;
    let bank = 0;
    let agency = 0;
    for (let i = 0; i < short; i++) {
      if (state.policies.gapFill === "none") break;
      if (chance(state.rng, BANK.fillChance)) bank++;
      else if (state.policies.gapFill === "bank_agency") agency++;
    }
    const member = groupMember(key);
    for (let i = 0; i < bank + agency; i++) {
      const s = createStaff(state, { ...member, contract: i < bank ? "bank" : "agency" });
      s.duty = "on";
      s.shiftEnd = shift.end;
      s.shiftLoad = { mins: 0, busy: 0, short: false };
    }
    const unfilled = short - bank - agency;
    state.today.stats.unfilledShifts += unfilled;
    if (unfilled > 0) for (const s of present) if (s.shiftLoad) s.shiftLoad.short = true;
    const name = groupName(key);
    const parts = [
      bank > 0 ? `${bank} from the bank` : "",
      agency > 0 ? `${agency} from an agency` : "",
      unfilled > 0 ? `${unfilled} short` : "",
    ].filter(Boolean);
    notes.push(`${name}: ${parts.join(", ")}`);
  }
  if (notes.length > 0) {
    emit(state, `${slotName(shift.slot)} shift gaps · ${notes.join(" · ")}`, "warn", undefined, {
      tab: "rota",
    });
  }
}
