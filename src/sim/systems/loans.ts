/**
 * Borrowing and ratings (GAME_DESIGN §8.1).
 *
 * PHS and Hybrid trusts borrow from the Department of Health and Social
 * Care at the National Loans Fund rate: capital loans the player takes for
 * building, and revenue support loans that arrive by themselves at midnight
 * when cash has run out, bringing it back up to a floor. A trust doesn't go
 * bust; instead its PHS oversight segment, reviewed each month from the
 * finances, falls: segment 3 can't take new capital loans, and segment 4
 * (the Recovery Support Programme) is financial special measures, with no
 * agency staff and building capped each month.
 *
 * A Private Hospital borrows from a bank at a rate set by its credit
 * rating, also reviewed monthly. An instalment it can't pay is missed, and
 * the rating falls further; with too many missed, or a month overdrawn,
 * it goes into administration.
 *
 * Loans are repaid in equal monthly instalments at the start of each month:
 * the interest is a running cost; the principal, like the loan itself, is
 * cash that the monthly statement shows apart from income and costs.
 */
import { CREDIT_RATINGS, ADMINISTRATION_MISSES, LOANS, OVERSIGHT } from "@data/finance";
import { costs, income, net, type Loan, type MonthReport } from "../agents";
import { emit } from "../events";
import type { SimState } from "../state";
import { TICKS_PER_DAY } from "../time";
import { book } from "./serviceLines";

/** A Private Hospital overdrawn this many days in a row goes into administration. */
const OVERDRAWN_DAYS = 30;

/** The monthly instalment that repays `principal` over `months` at `rate` a year. */
export function instalment(principal: number, rate: number, months: number): number {
  const r = rate / 12;
  if (r === 0) return principal / months;
  return (principal * r) / (1 - (1 + r) ** -months);
}

/** The bank's rate for a Private Hospital at its credit rating. */
export function bankRate(state: SimState): number {
  return LOANS.bank.base + CREDIT_RATINGS[state.rating.credit]!.spread;
}

const owed = (state: SimState, kind: Loan["kind"]) =>
  state.loans.filter((l) => l.kind === kind).reduce((n, l) => n + l.balance, 0);

/** The most a Private Hospital's bank will lend now, on top of what it owes. */
export function bankLimit(state: SimState): number {
  const last = state.months[state.months.length - 1];
  const monthly = last && last.days > 0 ? (income(last.ledger) * 30) / last.days : 0;
  const limit = Math.max(LOANS.bank.floor, monthly * LOANS.bank.incomeMonths);
  return Math.max(0, limit - owed(state, "bank"));
}

/** The most a PHS trust can borrow for building now, on top of what it owes. */
export function capitalLimit(state: SimState): number {
  return Math.max(0, LOANS.capital.maxOutstanding - owed(state, "capital"));
}

/** Why the hospital can't take this loan, or null. */
export function cantBorrow(
  state: SimState,
  kind: "capital" | "bank",
  amount: number,
  years: number,
): string | null {
  if (kind === "capital") {
    if (state.funding === "private") return "A private hospital borrows from a bank, not the DHSC";
    if (state.rating.segment >= 3) {
      return `In PHS oversight segment ${state.rating.segment}, the trust can't take new capital loans`;
    }
    const [lo, hi] = LOANS.capital.termYears;
    if (years < lo || years > hi) return `Capital loans run ${lo} to ${hi} years`;
    if (amount < LOANS.capital.min) return "That's too small to borrow";
    if (amount > capitalLimit(state)) return "That's more than the DHSC will lend";
    return null;
  }
  if (state.funding !== "private") return "A PHS trust borrows from the DHSC, not a bank";
  if (state.rating.administration !== null) return "The hospital is in administration";
  const [lo, hi] = LOANS.bank.termYears;
  if (years < lo || years > hi) return `Bank loans run ${lo} to ${hi} years`;
  if (amount < LOANS.bank.min) return "That's too small to borrow";
  if (amount > bankLimit(state)) return "That's more than the bank will lend";
  return null;
}

/** Takes out a loan: the cash arrives at once. */
export function borrow(state: SimState, kind: Loan["kind"], amount: number, years: number): Loan {
  const rate = kind === "bank" ? bankRate(state) : LOANS.dhscRate;
  const months = Math.round(years * 12);
  const loan: Loan = {
    id: state.nextLoanId++,
    kind,
    principal: amount,
    balance: amount,
    rate,
    months,
    payment: instalment(amount, rate, months),
    taken: state.tick,
    missed: 0,
  };
  state.loans.push(loan);
  state.money += amount;
  state.month.flows.borrowed += amount;
  return loan;
}

/** Pays a loan off early from cash, if there's enough. */
export function repayEarly(state: SimState, id: number): string | null {
  const loan = state.loans.find((l) => l.id === id);
  if (!loan) return "No such loan";
  if (state.money < loan.balance) return "Not enough cash to pay it off";
  state.money -= loan.balance;
  state.month.flows.repaid += loan.balance;
  state.loans = state.loans.filter((l) => l !== loan);
  return null;
}

/** At the start of each month: every loan's instalment, interest and principal. */
export function repayLoans(state: SimState): void {
  for (const loan of [...state.loans]) {
    const interest = (loan.balance * loan.rate) / 12;
    const principal = Math.min(loan.balance, loan.payment - interest);
    const due = interest + principal;
    if (state.funding === "private" && state.money < due) {
      loan.missed++;
      state.rating.credit = Math.min(CREDIT_RATINGS.length - 1, state.rating.credit + 2);
      emit(
        state,
        `Missed a loan repayment of ${pounds(due)}: not enough cash. The bank has cut the hospital's credit rating to ${CREDIT_RATINGS[state.rating.credit]!.id}.`,
        "bad",
        undefined,
        undefined,
        "loans",
      );
      continue;
    }
    state.money -= due;
    book(state, "interest", interest, "support");
    state.month.flows.repaid += principal;
    loan.balance -= principal;
    loan.missed = 0;
    if (loan.balance < 1) state.loans = state.loans.filter((l) => l !== loan);
  }
  const missed = state.loans.reduce((n, l) => n + l.missed, 0);
  if (state.funding === "private" && missed >= ADMINISTRATION_MISSES) enterAdministration(state);
}

/**
 * At midnight: a PHS trust out of cash gets a revenue support loan back up
 * to the floor; a Private Hospital overdrawn too long goes into administration.
 */
export function checkCash(state: SimState): void {
  if (state.money >= 0) {
    state.rating.overdrawnSince = null;
    return;
  }
  if (state.funding !== "private") {
    const need = LOANS.revenueSupport.floor - state.money;
    const amount = Math.ceil(need / 50_000) * 50_000;
    borrow(state, "revenue_support", amount, LOANS.revenueSupport.termYears);
    state.rating.segment = Math.max(state.rating.segment, 3);
    emit(
      state,
      `The trust ran out of cash: the DHSC has lent ${pounds(amount)} in revenue support, repayable over ${LOANS.revenueSupport.termYears} years. That puts it in PHS oversight segment ${state.rating.segment}: no new capital loans until it recovers.`,
      "bad",
      undefined,
      undefined,
      "loans",
    );
    return;
  }
  state.rating.overdrawnSince ??= state.tick;
  if (state.tick - state.rating.overdrawnSince >= OVERDRAWN_DAYS * TICKS_PER_DAY) {
    enterAdministration(state);
  }
}

function enterAdministration(state: SimState): void {
  if (state.rating.administration !== null) return;
  state.rating.administration = state.tick;
  emit(
    state,
    "The hospital has gone into administration: it couldn't pay its debts. Administrators have taken control.",
    "bad",
    undefined,
    undefined,
    "loans",
  );
}

/**
 * At the end of each month, from its statement: a PHS trust's oversight
 * segment (it improves at most one step a month), or a Private Hospital's
 * credit rating.
 */
export function reviewRating(state: SimState, m: MonthReport): void {
  const income_ = income(m.ledger);
  const surplus = net(m.ledger);
  const dailyCosts = m.days > 0 ? costs(m.ledger) / m.days : 0;
  const cashDays = dailyCosts > 0 ? m.closingCash / dailyCosts : Infinity;
  if (state.funding === "private") {
    const before = state.rating.credit;
    const missed = state.loans.some((l) => l.missed > 0);
    const debt = owed(state, "bank");
    let credit = before;
    if (missed) credit = Math.min(CREDIT_RATINGS.length - 1, credit + 1);
    else if (surplus < 0) credit = Math.min(CREDIT_RATINGS.length - 1, credit + 1);
    else if (surplus > 0.05 * income_ && debt < 6 * income_) credit = Math.max(0, credit - 1);
    state.rating.credit = credit;
    if (credit !== before) {
      emit(
        state,
        `The hospital's credit rating is now ${CREDIT_RATINGS[credit]!.id} (was ${CREDIT_RATINGS[before]!.id}): bank loans now cost ${(bankRate(state) * 100).toFixed(1)}% a year.`,
        credit > before ? "warn" : "info",
        undefined,
        undefined,
        "loans",
      );
    }
    return;
  }
  const before = state.rating.segment;
  const support = state.loans.some((l) => l.kind === "revenue_support");
  const [deficit2, deficit4] = OVERSIGHT.deficitShare;
  let segment: number;
  if (surplus >= 0 && cashDays >= OVERSIGHT.cashDays[0] && !support) segment = 1;
  else if ((surplus >= -deficit2 * income_ || cashDays >= OVERSIGHT.cashDays[1]) && !support) {
    segment = 2;
  } else segment = 3;
  if (segment === 3 && before >= 3 && surplus < -deficit4 * income_) segment = 4;
  // Confidence comes back slowly: one step a month.
  segment = Math.max(segment, before - 1);
  // In special measures after an Inadequate CSI rating: segment 4 until re-rated.
  if (state.csi.specialMeasures) segment = 4;
  state.rating.segment = segment;
  if (segment === 4 && state.policies.gapFill === "bank_agency") state.policies.gapFill = "bank";
  if (segment !== before) {
    emit(
      state,
      segment === 4
        ? "The trust is in PHS oversight segment 4: financial special measures. No agency staff, and building is capped at " +
            `${pounds(OVERSIGHT.specialMeasuresCapitalCap)} a month, until the finances recover.`
        : `The trust is now in PHS oversight segment ${segment} (was ${before})${segment >= 3 ? ": no new capital loans" : ""}.`,
      segment > before ? "warn" : "info",
      undefined,
      undefined,
      "loans",
    );
  }
}

/** Financial special measures: why building this would break the monthly cap, or null. */
export function capitalCapError(state: SimState, cost: number): string | null {
  if (cost <= 0 || state.funding === "private" || state.rating.segment < 4) return null;
  const cap = OVERSIGHT.specialMeasuresCapitalCap;
  if (state.month.flows.building + cost <= cap) return null;
  return `Financial special measures: building is capped at ${pounds(cap)} a month (${pounds(Math.max(0, cap - state.month.flows.building))} left this month)`;
}

const pounds = (n: number) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(n);
