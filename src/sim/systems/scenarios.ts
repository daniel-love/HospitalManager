/**
 * Scenarios and fail states (GAME_DESIGN §9, §10). A scenario sets off its
 * scripted events, checks its objectives (each met or failed by its
 * deadline), unlocks rooms and equipment as conditions are met, and ends
 * the game won (every objective met) or lost (one failed, or a fail
 * state). A sandbox game with fail states on can be lost the same ways:
 * an NHS trust three months in oversight segment 4, a Private Hospital in
 * administration, or two Inadequate CQC ratings in a row. After the end,
 * play can carry on as a sandbox.
 */
import { RATINGS } from "@data/cqc";
import { pressureEventById } from "@data/pressure";
import {
  FAIL,
  scenarioById,
  type ObjectiveDef,
  type ScenarioDef,
  type TutorialCheck,
} from "@data/scenarios";
import { emit } from "../events";
import type { Goals, SimState } from "../state";
import { clockFromTick, formatDate, TICKS_PER_DAY, TICKS_PER_MINUTE, tickAt } from "../time";
import { hasRoomWith, roomsPatientsCantReach, siteEntrance } from "../places";
import { tilesByLine } from "./serviceLines";
import { parkingSpaces } from "./ambulances";
import { announce } from "./pressure";

const TICKS_PER_HOUR = 60 * TICKS_PER_MINUTE;

export function scenarioOf(state: SimState): ScenarioDef | undefined {
  return state.goals.scenario ? scenarioById.get(state.goals.scenario) : undefined;
}

/** A new scenario's goals, all pending. */
export function startScenario(state: SimState, def: ScenarioDef): void {
  state.goals = {
    scenario: def.id,
    objectives: Object.fromEntries(
      def.objectives.map((o) => [o.id, { status: "pending", n: 0, d: 0 }]),
    ),
    unlocked: [],
    outcome: null,
    segment4Since: null,
    inadequateRun: 0,
  };
  // Anything due to be announced by the first day (whose midnight has passed) is announced now.
  const today = clockFromTick(state.tick).day;
  for (const s of def.script) {
    if (s.announceDay > today) continue;
    announce(state, pressureEventById.get(s.event)!, undefined, tickAt(s.startDay, s.startHour));
  }
}

/** Whether a room type or piece of equipment is locked in this scenario, and why. */
export function lockReason(state: SimState, id: string): string | null {
  const def = scenarioOf(state);
  if (!def || state.goals.outcome) return null;
  for (const lock of def.locks) {
    if (lock.items.includes(id) && !state.goals.unlocked.includes(lock.id)) return lock.reason;
  }
  return null;
}

/** Each tick, cheaply; at midnight the script and the day's tallies; hourly, objectives and fail states. */
export function updateScenarios(state: SimState): void {
  const g = state.goals;
  if (g.outcome) return;
  const def = scenarioOf(state);
  if (!def && !state.settings.failStates) return;
  const c = clockFromTick(state.tick);
  const midnight = c.hour === 0 && c.minute === 0 && state.tick % TICKS_PER_MINUTE === 0;
  if (def && midnight) {
    for (const s of def.script) {
      if (s.announceDay !== c.day) continue;
      announce(state, pressureEventById.get(s.event)!, undefined, tickAt(s.startDay, s.startHour));
    }
  }
  if (state.tick % TICKS_PER_HOUR !== 0) return;
  if (def) {
    for (const o of def.objectives) check(state, o, midnight);
    unlock(state, def);
    const statuses = def.objectives.map((o) => g.objectives[o.id]!.status);
    const failed = def.objectives.find((o) => g.objectives[o.id]!.status === "failed");
    if (failed) return end(state, false, `Objective missed: ${failed.text}.`);
    if (statuses.every((s) => s === "met")) return end(state, true, "Every objective met.");
    if (c.day >= def.endDay)
      return end(state, false, "Time ran out before every objective was met.");
  }
  failStates(state);
}

/** The day just finished (it's midnight). */
const yesterday = (state: SimState) => clockFromTick(state.tick - 1).day;

function check(state: SimState, o: ObjectiveDef, midnight: boolean): void {
  const p = state.goals.objectives[o.id]!;
  if (p.status !== "pending") return;
  const day = clockFromTick(state.tick).day;
  switch (o.kind) {
    case "ae_open": {
      const week = state.history.slice(-7).reduce((n, d) => n + d.stats.departures, 0);
      const rooms = o.rooms.every((r) =>
        r === "ambulance_bay" ? parkingSpaces(state).length > 0 : hasRoomWith(state, r, []),
      );
      p.n = week;
      p.d = o.departures7d;
      if (rooms && week >= o.departures7d) p.status = "met";
      else if (day > o.by) p.status = "failed";
      return;
    }
    case "four_hour":
    case "no_unexpected_deaths": {
      if (midnight) {
        const d = yesterday(state);
        if (d >= o.from && d <= o.to) {
          const s = state.history[state.history.length - 1]?.stats;
          if (s) {
            if (o.kind === "four_hour") {
              p.n += s.within4h;
              p.d += s.departures;
            } else p.n += s.unexpectedDeaths;
          }
        }
      }
      if (o.kind === "no_unexpected_deaths" && p.n > 0) p.status = "failed";
      if (day > o.to) {
        if (o.kind === "no_unexpected_deaths") p.status = "met";
        else p.status = p.d > 0 && p.n / p.d >= o.atLeast ? "met" : "failed";
      }
      return;
    }
    case "monthly_surplus": {
      const best = Math.max(
        0,
        ...state.months.map((m) => {
          const l = m.ledger;
          return (
            l.block +
            l.tariff +
            l.elective +
            l.outpatients +
            l.private -
            (l.salaries +
              l.bank +
              l.agency +
              l.upkeep +
              l.supplies +
              l.estates +
              l.interest +
              l.transfers)
          );
        }),
      );
      p.n = Math.round(best);
      p.d = o.atLeast;
      if (best >= o.atLeast) p.status = "met";
      else if (day > o.by) p.status = "failed";
      return;
    }
    case "reputation": {
      p.n = Math.round(state.reputation);
      p.d = o.atLeast;
      if (state.reputation >= o.atLeast) p.status = "met";
      else if (day > o.by) p.status = "failed";
      return;
    }
    case "tutorial": {
      // One step at a time: only once the steps before are done.
      const def = scenarioOf(state)!;
      const i = def.objectives.findIndex((x) => x.id === o.id);
      if (def.objectives.slice(0, i).some((x) => state.goals.objectives[x.id]!.status !== "met")) {
        return;
      }
      if (tutorialDone(state, o.step)) {
        p.status = "met";
        const next = def.objectives[i + 1];
        emit(state, next ? `Done! Next: ${next.text.toLowerCase()}.` : "Done!", "info");
      }
      return;
    }
    case "no_casualty_deaths": {
      // Counted as they die (casualtyDied).
      if (p.n > 0) p.status = "failed";
      else if (day > o.to) p.status = "met";
      return;
    }
    case "trauma_transfers": {
      // Late: counted as they leave (traumaTransferred), or still here past the limit.
      const late = Object.values(state.patients).some(
        (q) =>
          q.conditionId === "major_trauma" &&
          q.stage !== "leaving" &&
          !q.death &&
          state.tick - q.times.arrived > o.withinHours * TICKS_PER_HOUR,
      );
      if (late) p.n++;
      if (p.n > 0) p.status = "failed";
      else if (day > o.to) p.status = "met";
      return;
    }
  }
}

function unlock(state: SimState, def: ScenarioDef): void {
  const g = state.goals;
  for (const lock of def.locks) {
    if (g.unlocked.includes(lock.id)) continue;
    const u = lock.unlock;
    const ok =
      "objective" in u
        ? g.objectives[u.objective]?.status === "met"
        : state.cqc.overall !== null &&
          RATINGS.indexOf(state.cqc.overall) >= RATINGS.indexOf(u.cqcAtLeast);
    if (!ok) continue;
    g.unlocked.push(lock.id);
    emit(state, `Unlocked: ${lock.reason.replace(/^./, (c) => c.toLowerCase())}.`, "info");
  }
}

/** Ways to lose: segment 4 too long, administration, Inadequate twice running. */
function failStates(state: SimState): void {
  const g = state.goals;
  if (state.rating.administration !== null)
    return end(state, false, "The hospital went into administration.");
  if (state.funding !== "private" && state.rating.segment === 4) {
    g.segment4Since ??= state.tick;
    if (state.tick - g.segment4Since >= FAIL.segment4Days * TICKS_PER_DAY) {
      return end(
        state,
        false,
        `${FAIL.segment4Days} days in NHS oversight segment 4: the trust has been taken over.`,
      );
    }
  } else g.segment4Since = null;
  const reports = state.cqc.reports.slice(-FAIL.inadequateInARow);
  g.inadequateRun =
    reports.length === FAIL.inadequateInARow && reports.every((r) => r.overall === "inadequate")
      ? reports.length
      : 0;
  if (g.inadequateRun >= FAIL.inadequateInARow) {
    return end(
      state,
      false,
      "Rated Inadequate twice in a row: the hospital has been closed by the regulator.",
    );
  }
}

function end(state: SimState, won: boolean, text: string): void {
  state.goals.outcome = { won, text, tick: state.tick };
  emit(
    state,
    `${won ? "Scenario complete" : scenarioOf(state) ? "Scenario failed" : "Game over"}: ${text}`,
    won ? "info" : "bad",
  );
}

/** A major incident casualty has died (for the no_casualty_deaths objective). */
export function casualtyDied(state: SimState): void {
  const def = scenarioOf(state);
  if (!def) return;
  for (const o of def.objectives) {
    if (o.kind === "no_casualty_deaths") state.goals.objectives[o.id]!.n++;
  }
}

/** A major trauma casualty decided for transfer too late (for the trauma_transfers objective). */
export function traumaTransferred(state: SimState, arrivedTick: number): void {
  const def = scenarioOf(state);
  if (!def) return;
  for (const o of def.objectives) {
    if (o.kind !== "trauma_transfers") continue;
    if (state.tick - arrivedTick > o.withinHours * TICKS_PER_HOUR)
      state.goals.objectives[o.id]!.n++;
  }
}

/** For the objectives panel: each objective, its status and progress. */
export function describeGoals(state: SimState): {
  name: string;
  outcome: Goals["outcome"];
  objectives: { text: string; status: string; progress: string | null }[];
  ends: string;
  /** A tutorial: the step under way, its instructions, and the button to light up. */
  tutorial: {
    step: number;
    of: number;
    text: string;
    hint: string;
    highlight: string | null;
  } | null;
} | null {
  const def = scenarioOf(state);
  if (!def) return null;
  const current = def.objectives.findIndex((o) => state.goals.objectives[o.id]!.status !== "met");
  const step = current >= 0 ? def.objectives[current]! : null;
  return {
    name: def.name,
    outcome: state.goals.outcome,
    ends: formatDate(def.endDay),
    tutorial:
      def.tutorial && step && !state.goals.outcome
        ? {
            step: current + 1,
            of: def.objectives.length,
            text: step.text,
            hint: step.hint ?? "",
            highlight: step.highlight ?? null,
          }
        : null,
    objectives: def.objectives.map((o) => {
      const p = state.goals.objectives[o.id]!;
      let progress: string | null = null;
      if (p.status === "pending") {
        if (o.kind === "ae_open")
          progress = `${p.n} of ${o.departures7d} patients in the last week`;
        else if (o.kind === "four_hour" && p.d > 0)
          progress = `${Math.round((100 * p.n) / p.d)}% so far`;
        else if (o.kind === "monthly_surplus")
          progress = `Best month so far: £${p.n.toLocaleString("en-GB")}`;
        else if (o.kind === "reputation") progress = `Now ${p.n}`;
      }
      return { text: o.text, status: p.status, progress };
    }),
  };
}

const validRoom = (state: SimState, type: string) =>
  state.rooms.some((r) => r.valid && r.typeId === type);

/** Whether a tutorial step's check passes. */
export function tutorialDone(state: SimState, step: TutorialCheck): boolean {
  switch (step) {
    case "foundations":
      return Object.values(tilesByLine(state)).reduce((n, t) => n + t, 0) >= 80;
    case "reception":
      return validRoom(state, "ae_reception") && validRoom(state, "waiting_area");
    case "triage":
      return validRoom(state, "triage_room");
    case "cubicle":
      return validRoom(state, "minors_cubicle");
    case "toilets":
      return validRoom(state, "toilets");
    case "entrance":
      return siteEntrance(state) !== null && roomsPatientsCantReach(state).length === 0;
    case "staff": {
      const roles = new Set(Object.values(state.staff).map((s) => s.role));
      return ["receptionist", "nurse", "junior_doctor", "cleaner"].every((r) =>
        roles.has(r as never),
      );
    }
    case "patients": {
      const discharged =
        state.today.stats.discharged + state.history.reduce((n, d) => n + d.stats.discharged, 0);
      return discharged >= 5;
    }
  }
}

/**
 * A tutorial's steps, checked straight after the player builds or hires
 * (the tutorial is played paused, so the hourly check isn't enough).
 */
export function advanceTutorial(state: SimState): void {
  const def = scenarioOf(state);
  if (!def?.tutorial || state.goals.outcome) return;
  for (const o of def.objectives) check(state, o, false);
}
