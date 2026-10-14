/**
 * Money (GAME_DESIGN §8.1). Tariff income arrives as each patient is
 * discharged. Salaries and equipment upkeep are charged every in-game hour,
 * so the balance moves smoothly. At midnight the day's takings and patient
 * flow are filed as a daily report (the P&L).
 */
import { equipmentById, staffRoleById } from "@data/catalogue";
import { DAYS_PER_MONTH, NHS_FUNDING, PRIVATE, RUNNING_COSTS } from "@data/economy";
import { MAJOR_INCIDENT } from "@data/pressure";
import { AGENCY, BANK, NURSE_BANDS, ON_CALL, UNSOCIAL } from "@data/staff";
import { RTT_TARGET_DAYS } from "@data/outpatients";
import {
  SERVICE_LINES,
  addInto,
  addServices,
  costs,
  emptyLedger,
  emptyServices,
  emptyStats,
  income,
  net,
  onSite,
  type DayReport,
  type MonthEnd,
  type Payer,
  type Staff,
} from "../agents";
import { emit } from "../events";
import { emptyMonth, type SimState } from "../state";
import { patientsInEscalation, wardBedUse } from "./escalation";
import { dailyBlock, emergencyValueByLine } from "./funding";
import { updateGrants } from "./grants";
import { checkCash, repayLoans, reviewRating } from "./loans";
import { overPrivateCap } from "./referrals";
import { updateReputation } from "./reputation";
import { isCalledIn } from "./majorIncident";
import { actingDownPay, isStriking } from "./strikes";
import {
  book,
  objectLine,
  plannedWhere,
  staffWhere,
  tilesByLine,
  type Where,
} from "./serviceLines";
import {
  clockFromTick,
  dateOf,
  firstDayOf,
  formatDate,
  monthName,
  MINUTES_PER_DAY,
  START_MINUTE_OF_DAY,
  TICKS_PER_DAY,
  TICKS_PER_MINUTE,
} from "../time";

const TICKS_PER_HOUR = TICKS_PER_MINUTE * 60;
/** Daily reports kept for the reports screen. */
export const HISTORY_DAYS = 60;

/**
 * An emergency patient's tariff (an A&E attendance, an emergency admission
 * or operation): paid at the marginal rate on top of the block contract.
 */
export function earnEmergency(state: SimState, tariff: number, where: Where): void {
  book(state, "tariff", tariff * (1 - NHS_FUNDING.blockShare), where);
  state.money += tariff * (1 - NHS_FUNDING.blockShare);
  useSupplies(state, tariff * RUNNING_COSTS.suppliesShare, where);
}

/** A planned operation's tariff, paid in full. */
export function earnElective(state: SimState, tariff: number, where: Where): void {
  state.money += tariff;
  book(state, "elective", tariff, where);
  useSupplies(state, tariff * RUNNING_COSTS.suppliesShare, where);
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
  where: Where,
  outpatient = false,
): void {
  const factor =
    payer === "insured" ? PRIVATE.insurerFactor : PRIVATE.selfPayFactor * state.policies.priceLevel;
  const fee = nhsTariff * factor * (outpatient ? PRIVATE.outpatientFacilityShare : 1);
  state.money += fee;
  book(state, "private", fee, where);
  useSupplies(
    state,
    nhsTariff * (outpatient ? RUNNING_COSTS.outpatientSuppliesShare : RUNNING_COSTS.suppliesShare),
    where,
  );
}

/** An outpatient appointment's tariff, paid in full. */
export function earnOutpatient(state: SimState, tariff: number): void {
  state.money += tariff;
  book(state, "outpatients", tariff, "outpatients");
  useSupplies(state, tariff * RUNNING_COSTS.outpatientSuppliesShare, "outpatients");
}

/**
 * A planned operation's income: tariff for the NHS, a facility fee for a
 * private patient. A day case's is all Theatres'; an inpatient's is shared
 * with Wards for their stay.
 */
export function earnPlanned(state: SimState, tariff: number, payer: Payer, dayCase: boolean): void {
  const where = plannedWhere(dayCase);
  if (payer === "nhs") earnElective(state, tariff, where);
  else earnPrivate(state, tariff, payer, where);
}

/** Drugs and clinical supplies used in a treatment. */
function useSupplies(state: SimState, cost: number, where: Where): void {
  state.money -= cost;
  book(state, "supplies", cost, where);
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
  const pay: HourlyPay = { salaries: 0, bank: 0, agency: 0 };
  const rate = unsocialRateNow(state);
  for (const s of Object.values(state.staff)) addInto(pay, staffHour(state, s, rate));
  return pay;
}

/** The unsocial hours rate for the hour just gone. */
function unsocialRateNow(state: SimState): number {
  const c = clockFromTick(Math.max(0, state.tick - 1));
  return unsocialRate(c.weekday, c.hour);
}

/** One person's pay for the hour just gone, by ledger line. */
function staffHour(state: SimState, s: Staff, rate: number): HourlyPay {
  // No pay while on strike.
  const striking = isStriking(state, s) && !onSite(s);
  const pay: HourlyPay = {
    salaries: striking ? 0 : annualCost(s) / 365 / 24,
    bank: 0,
    agency: 0,
  };
  const hour = rolePay(s) / UNSOCIAL.hoursPerYear;
  const unsocial = onShift(state, s) ? rate * hour : 0;
  if (s.contract === "on_call") {
    if (onSite(s)) pay.salaries += ON_CALL.hourly;
  } else if (s.contract === "bank") {
    if (onSite(s)) pay.bank += hour * BANK.payFactor + unsocial;
  } else if (s.contract === "agency") {
    if (onSite(s)) pay.agency += (hour + unsocial) * AGENCY.payFactor;
  } else pay.salaries += unsocial;
  // Called in for a major incident: overtime on top.
  if (onSite(s) && isCalledIn(state, s)) pay.salaries += hour * MAJOR_INCIDENT.overtimeRate;
  // A consultant covering a resident doctors' strike, at the rate card.
  pay.salaries += actingDownPay(state, s);
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

export function updateFinance(state: SimState): void {
  if (state.tick % TICKS_PER_HOUR !== 0) return;
  const rate = unsocialRateNow(state);
  for (const s of Object.values(state.staff)) {
    const pay = staffHour(state, s, rate);
    const where = staffWhere(state, s);
    book(state, "salaries", pay.salaries, where);
    book(state, "bank", pay.bank, where);
    book(state, "agency", pay.agency, where);
    state.money -= pay.salaries + pay.bank + pay.agency;
  }
  for (const o of Object.values(state.objects)) {
    const upkeep = (equipmentById.get(o.defId)?.upkeep ?? 0) / DAYS_PER_MONTH / 24;
    book(state, "upkeep", upkeep, objectLine(state, o.id));
    state.money -= upkeep;
  }
  const tiles = tilesByLine(state);
  for (const line of SERVICE_LINES) {
    const estates = (tiles[line] * RUNNING_COSTS.estatesPerTileYear) / 365 / 24;
    book(state, "estates", estates, line);
    state.money -= estates;
  }
  sampleBeds(state);

  const minuteOfDay = (state.tick / TICKS_PER_MINUTE + START_MINUTE_OF_DAY) % MINUTES_PER_DAY;
  if (minuteOfDay === 0) {
    // The day's share of the block contract, for what the hospital can do now,
    // split between departments as it was sized.
    const block = dailyBlock(state);
    book(state, "block", block, blockWhere(state));
    state.money += block;
    closeDay(state);
  }
}

/** How the block contract splits between departments: as the emergency care it pays for. */
function blockWhere(state: SimState): Where {
  const parts = emergencyValueByLine(state);
  const total = parts.ae + parts.wards + parts.theatres;
  if (total === 0) return "ae";
  return { ae: parts.ae / total, wards: parts.wards / total, theatres: parts.theatres / total };
}

/** Each hour: inpatient beds, and how many are occupied (for bed occupancy). */
function sampleBeds(state: SimState): void {
  const { beds, used } = wardBedUse(state);
  state.today.stats.bedHours += beds;
  state.today.stats.occupiedBedHours += used;
}

/** Files today's report (it's just turned midnight) and starts a new day. */
function closeDay(state: SimState): void {
  state.today.stats.corridorNights += patientsInEscalation(state);
  updateReputation(state, state.today.stats);
  const report: DayReport = {
    day: clockFromTick(state.tick - 1).day,
    ledger: state.today.ledger,
    stats: state.today.stats,
    reputation: state.reputation,
  };
  state.history.push(report);
  if (state.history.length > HISTORY_DAYS) state.history.shift();
  const services = state.today.services;
  state.today = { ledger: emptyLedger(), stats: emptyStats(), services: emptyServices() };

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
  addServices(month.services, services);
  month.days++;
  month.closingCash = state.money;
  month.end = monthEnd(state);
  const next = dateOf(report.day + 1);
  if (next.monthIndex !== month.monthIndex) closeMonth(state, next.monthIndex);
  checkCash(state);
  updateGrants(state);

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
      (state.funding === "private"
        ? `${seen} seen in clinic · ${plural(s.electiveOps, "operation")}`
        : `${s.discharged} treated, ${s.lwbs} left unseen${fourHour}${clinics}`),
    n >= 0 ? "info" : "warn",
  );
}

/** The KPIs' snapshot figures, as things stand now. */
export function monthEnd(state: SimState): MonthEnd {
  let rttWaiting = 0;
  let rttWithin18w = 0;
  for (const r of Object.values(state.referrals)) {
    if (r.clockStart === null || r.payer !== "nhs") continue;
    rttWaiting++;
    if (state.tick - r.clockStart < RTT_TARGET_DAYS * TICKS_PER_DAY) rttWithin18w++;
  }
  const headcount = Object.values(state.staff).filter(
    (s) => s.contract !== "bank" && s.contract !== "agency",
  ).length;
  return { reputation: state.reputation, rttWaiting, rttWithin18w, headcount };
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
      `Cash ${money.format(m.closingCash)}. See Finance.`,
    n >= 0 ? "info" : "warn",
    undefined,
    undefined,
    "statement",
  );
  reviewRating(state, m);
  repayLoans(state);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
