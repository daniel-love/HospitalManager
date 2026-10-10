/**
 * Money (GAME_DESIGN §8.1). Tariff income arrives as each patient is
 * discharged. Salaries and equipment upkeep are charged every in-game hour,
 * so the balance moves smoothly. At midnight the day's takings and patient
 * flow are filed as a daily report (the P&L).
 */
import { equipmentById, staffRoleById } from "@data/catalogue";
import { DAYS_PER_MONTH } from "@data/economy";
import { AGENCY, BANK, NURSE_BANDS, ON_CALL, UNSOCIAL } from "@data/staff";
import { emptyLedger, emptyStats, net, onSite, type DayReport, type Staff } from "../agents";
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

/** A role's annual pay with on-costs, by band for nurses. */
export function rolePay(s: Staff): number {
  const band = s.band === null ? undefined : NURSE_BANDS.find((b) => b.band === s.band);
  return band ? band.annualCost : staffRoleById.get(s.role)!.annualCost;
}

/**
 * What someone costs a year: their pay, or an on-call consultant's
 * retainer. Bank and agency staff are paid by the hour instead (0 here).
 */
export function annualCost(s: Staff): number {
  if (s.contract === "on_call") return ON_CALL.retainer;
  if (s.contract === "bank" || s.contract === "agency") return 0;
  return rolePay(s);
}

/**
 * The unsocial hours enhancement for an hour's work starting at `hour` on
 * `weekday` (0 Monday): a share of basic pay.
 */
export function unsocialRate(weekday: number, hour: number): number {
  if (weekday === 6) return UNSOCIAL.sunday;
  if (weekday === 5) return Math.max(UNSOCIAL.saturday, UNSOCIAL.night);
  return hour >= UNSOCIAL.nightFrom || hour < UNSOCIAL.nightTo ? UNSOCIAL.night : 0;
}

/** Staff costs for the hour just gone, £, by ledger line. */
export interface HourlyPay {
  salaries: number;
  bank: number;
  agency: number;
}

/**
 * Staff costs for the hour just gone: salaries, plus on-call consultants'
 * hours in the hospital and unsocial hours pay for anyone at work on a
 * shift; and bank and agency staff by the hour (with unsocial hours too).
 */
export function hourlyPay(state: SimState): HourlyPay {
  let annual = 0;
  const pay: HourlyPay = { salaries: 0, bank: 0, agency: 0 };
  const c = clockFromTick(Math.max(0, state.tick - 1));
  const rate = unsocialRate(c.weekday, c.hour);
  for (const s of Object.values(state.staff)) {
    annual += annualCost(s);
    const hour = rolePay(s) / UNSOCIAL.hoursPerYear;
    const unsocial = onShift(state, s) ? rate * hour : 0;
    if (s.contract === "on_call") {
      if (onSite(s)) pay.salaries += ON_CALL.hourly;
    } else if (s.contract === "bank") {
      if (onSite(s)) pay.bank += hour * BANK.payFactor + unsocial;
    } else if (s.contract === "agency") {
      if (onSite(s)) pay.agency += (hour + unsocial) * AGENCY.payFactor;
    } else pay.salaries += unsocial;
  }
  pay.salaries += annual / 365 / 24;
  return pay;
}

/** All staff costs for the hour just gone, £. */
export function hourlySalaries(state: SimState): number {
  const p = hourlyPay(state);
  return p.salaries + p.bank + p.agency;
}

/** At work on a shift (or staying on after one): what earns unsocial hours pay. */
function onShift(state: SimState, s: Staff): boolean {
  return state.settings.rotas && s.role !== "consultant" && onSite(s) && s.onCall === null;
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
  const pay = hourlyPay(state);
  const upkeep = hourlyUpkeep(state);
  ledger.salaries += pay.salaries;
  ledger.bank += pay.bank;
  ledger.agency += pay.agency;
  ledger.upkeep += upkeep;
  state.money -= pay.salaries + pay.bank + pay.agency + upkeep;

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
  const seen = s.firstAppointments + s.followUps;
  const ops = s.electiveOps + s.emergencyOps;
  const clinics =
    (seen > 0 ? ` · ${seen} seen in clinic` : "") +
    (ops > 0 ? ` · ${ops} ${ops === 1 ? "operation" : "operations"}` : "");
  const fourHour =
    s.departures > 0 ? ` · 4-hour ${Math.round((100 * s.within4h) / s.departures)}%` : "";
  emit(
    state,
    `Day ${report.day} closed: ${n >= 0 ? "surplus" : "deficit"} ${money.format(Math.abs(n))} · ` +
      `${s.discharged} treated, ${s.lwbs} left unseen${fourHour}${clinics}`,
    n >= 0 ? "info" : "warn",
  );
}
