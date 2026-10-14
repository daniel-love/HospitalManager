/**
 * Money (GAME_DESIGN §8.1). Tariff income arrives as each patient is
 * discharged. Salaries and equipment upkeep are charged every in-game hour,
 * so the balance moves smoothly. At midnight the day's takings and patient
 * flow are filed as a daily report (the P&L).
 */
import { equipmentById, staffRoleById } from "@data/catalogue";
import { DAYS_PER_MONTH, NHS_FUNDING, PRIVATE, RUNNING_COSTS } from "@data/economy";
import { FloorType } from "../world/grid";
import { AGENCY, BANK, NURSE_BANDS, ON_CALL, UNSOCIAL } from "@data/staff";
import {
  addInto,
  costs,
  emptyLedger,
  emptyStats,
  income,
  net,
  onSite,
  type DayReport,
  type Payer,
  type Staff,
} from "../agents";
import { emit } from "../events";
import { emptyMonth, type SimState } from "../state";
import { dailyBlock } from "./funding";
import { overPrivateCap } from "./referrals";
import { updateReputation } from "./reputation";
import {
  clockFromTick,
  dateOf,
  firstDayOf,
  formatDate,
  monthName,
  MINUTES_PER_DAY,
  START_MINUTE_OF_DAY,
  TICKS_PER_MINUTE,
} from "../time";

const TICKS_PER_HOUR = TICKS_PER_MINUTE * 60;
/** Daily reports kept for the reports screen. */
export const HISTORY_DAYS = 60;

/**
 * An emergency patient's tariff (an A&E attendance, an emergency admission
 * or operation): paid at the marginal rate on top of the block contract.
 */
export function earnEmergency(state: SimState, tariff: number): void {
  const amount = tariff * (1 - NHS_FUNDING.blockShare);
  state.money += amount;
  state.today.ledger.tariff += amount;
  useSupplies(state, tariff * RUNNING_COSTS.suppliesShare);
}

/** A planned operation's tariff, paid in full. */
export function earnElective(state: SimState, tariff: number): void {
  state.money += tariff;
  state.today.ledger.elective += tariff;
  useSupplies(state, tariff * RUNNING_COSTS.suppliesShare);
}

/**
 * A private patient's facility fee (the consultant bills their own fee):
 * a multiple of the NHS tariff for the same care, at insurers' rates or the
 * hospital's self-pay prices. Supplies are as for the NHS care.
 */
export function earnPrivate(
  state: SimState,
  nhsTariff: number,
  payer: Exclude<Payer, "nhs">,
  outpatient = false,
): void {
  const factor =
    payer === "insured" ? PRIVATE.insurerFactor : PRIVATE.selfPayFactor * state.policies.priceLevel;
  const fee = nhsTariff * factor * (outpatient ? PRIVATE.outpatientFacilityShare : 1);
  state.money += fee;
  state.today.ledger.private += fee;
  useSupplies(
    state,
    nhsTariff *
      (outpatient ? RUNNING_COSTS.outpatientSuppliesShare : RUNNING_COSTS.suppliesShare),
  );
}

/** An outpatient appointment's tariff, paid in full. */
export function earnOutpatient(state: SimState, tariff: number): void {
  state.money += tariff;
  state.today.ledger.outpatients += tariff;
  useSupplies(state, tariff * RUNNING_COSTS.outpatientSuppliesShare);
}

/** A planned operation's income: tariff for the NHS, a facility fee for a private patient. */
export function earnPlanned(state: SimState, tariff: number, payer: Payer): void {
  if (payer === "nhs") earnElective(state, tariff);
  else earnPrivate(state, tariff, payer);
}

/** Drugs and clinical supplies used in a treatment. */
function useSupplies(state: SimState, cost: number): void {
  state.money -= cost;
  state.today.ledger.supplies += cost;
}

const floorCache = new WeakMap<SimState, { version: number; tiles: number }>();

/** Tiles of floor built (foundations), on every floor. */
export function floorTiles(state: SimState): number {
  const hit = floorCache.get(state);
  if (hit && hit.version === state.layoutVersion) return hit.tiles;
  let tiles = 0;
  for (const g of state.floors) for (const t of g.floorType) if (t === FloorType.Floor) tiles++;
  floorCache.set(state, { version: state.layoutVersion, tiles });
  return tiles;
}

/** Estates and utilities per hour, £. */
export function hourlyEstates(state: SimState): number {
  return (floorTiles(state) * RUNNING_COSTS.estatesPerTileYear) / 365 / 24;
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
  // Paid by the hour, or (practising privileges) by their own patients.
  if (s.contract === "bank" || s.contract === "agency" || s.contract === "privileges") return 0;
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
  const estates = hourlyEstates(state);
  ledger.estates += estates;
  state.money -= estates;
  ledger.salaries += pay.salaries;
  ledger.bank += pay.bank;
  ledger.agency += pay.agency;
  ledger.upkeep += upkeep;
  state.money -= pay.salaries + pay.bank + pay.agency + upkeep;

  const minuteOfDay = (state.tick / TICKS_PER_MINUTE + START_MINUTE_OF_DAY) % MINUTES_PER_DAY;
  if (minuteOfDay === 0) {
    // The day's share of the block contract, for what the hospital can do now.
    const block = dailyBlock(state);
    ledger.block += block;
    state.money += block;
    closeDay(state);
  }
}

/** Files today's report (it's just turned midnight) and starts a new day. */
function closeDay(state: SimState): void {
  updateReputation(state, state.today.stats);
  const report: DayReport = {
    day: clockFromTick(state.tick - 1).day,
    ledger: state.today.ledger,
    stats: state.today.stats,
    reputation: state.reputation,
  };
  state.history.push(report);
  if (state.history.length > HISTORY_DAYS) state.history.shift();
  state.today = { ledger: emptyLedger(), stats: emptyStats() };

  if (overPrivateCap(state)) {
    emit(
      state,
      `Private income is over ${Math.round(PRIVATE.incomeCap * 100)}% of all income: the regulator won't let an NHS trust's private work outgrow its NHS work, so the Private Patient Unit takes no new referrals until it's back under`,
      "warn",
    );
  }

  const month = state.month;
  addInto(month.ledger, report.ledger);
  addInto(month.stats, report.stats);
  month.days++;
  month.closingCash = state.money;
  const next = dateOf(report.day + 1);
  if (next.monthIndex !== month.monthIndex) closeMonth(state, next.monthIndex);

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
    `${formatDate(report.day)} closed: ${n >= 0 ? "surplus" : "deficit"} ${money.format(Math.abs(n))} · ` +
      `${s.discharged} treated, ${s.lwbs} left unseen${fourHour}${clinics}`,
    n >= 0 ? "info" : "warn",
  );
}

/** Months of statements kept. */
export const HISTORY_MONTHS = 24;

/** Files the month's statement (it's just turned the 1st) and starts the next. */
function closeMonth(state: SimState, nextIndex: number): void {
  const m = state.month;
  state.months.push(m);
  if (state.months.length > HISTORY_MONTHS) state.months.shift();
  state.month = emptyMonth(nextIndex, state.money);
  const n = net(m.ledger);
  const money = new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  });
  emit(
    state,
    `${monthName(dateOf(firstDayOf(m.monthIndex)))} statement: income ${money.format(income(m.ledger))}, ` +
      `costs ${money.format(costs(m.ledger))}, ${n >= 0 ? "surplus" : "deficit"} ${money.format(Math.abs(n))}. ` +
      `Cash ${money.format(m.closingCash)}. See Reports.`,
    n >= 0 ? "info" : "warn",
  );
}
