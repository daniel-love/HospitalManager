/**
 * Money (GAME_DESIGN §8.1). Tariff income arrives as each patient is
 * discharged. Salaries and equipment upkeep are charged every in-game hour,
 * so the balance moves smoothly. At midnight the day's takings and patient
 * flow are filed as a daily report (the P&L).
 */
import { equipmentById, staffRoleById } from "@data/catalogue";
import { DAYS_PER_MONTH } from "@data/economy";
import { emptyLedger, emptyStats, net, type DayReport } from "../agents";
import { emit } from "../events";
import type { SimState } from "../state";
import { clockFromTick, MINUTES_PER_DAY, START_MINUTE_OF_DAY, TICKS_PER_MINUTE } from "../time";

const TICKS_PER_HOUR = TICKS_PER_MINUTE * 60;
/** Daily reports kept for the reports screen. */
export const HISTORY_DAYS = 60;

export function earn(state: SimState, amount: number): void {
  state.money += amount;
  state.today.ledger.tariff += amount;
}

/** Staff costs per hour, £. */
export function hourlySalaries(state: SimState): number {
  let annual = 0;
  for (const s of Object.values(state.staff)) annual += staffRoleById.get(s.role)!.annualCost;
  return annual / 365 / 24;
}

/** Equipment upkeep per hour, £. */
export function hourlyUpkeep(state: SimState): number {
  let monthly = 0;
  for (const o of Object.values(state.objects)) monthly += equipmentById.get(o.defId)?.upkeep ?? 0;
  return monthly / DAYS_PER_MONTH / 24;
}

export function updateFinance(state: SimState): void {
  if (state.tick % TICKS_PER_HOUR !== 0) return;
  const ledger = state.today.ledger;
  const salaries = hourlySalaries(state);
  const upkeep = hourlyUpkeep(state);
  ledger.salaries += salaries;
  ledger.upkeep += upkeep;
  state.money -= salaries + upkeep;

  const minuteOfDay = (state.tick / TICKS_PER_MINUTE + START_MINUTE_OF_DAY) % MINUTES_PER_DAY;
  if (minuteOfDay === 0) closeDay(state);
}

/** Files today's report (it's just turned midnight) and starts a new day. */
function closeDay(state: SimState): void {
  const report: DayReport = {
    day: clockFromTick(state.tick - 1).day,
    ledger: state.today.ledger,
    stats: state.today.stats,
  };
  state.history.push(report);
  if (state.history.length > HISTORY_DAYS) state.history.shift();
  state.today = { ledger: emptyLedger(), stats: emptyStats() };

  const n = net(report.ledger);
  const money = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  });
  const s = report.stats;
  const fourHour =
    s.departures > 0 ? ` · 4-hour ${Math.round((100 * s.within4h) / s.departures)}%` : "";
  emit(
    state,
    `Day ${report.day} closed: ${n >= 0 ? "surplus" : "deficit"} ${money.format(Math.abs(n))} · ` +
      `${s.discharged} treated, ${s.lwbs} left unseen${fourHour}`,
    n >= 0 ? "info" : "warn",
  );
}
