/**
 * What the Finance dialog shows: the monthly statement over several months
 * and the year to date, income and costs by department (service-line
 * reporting, systems/serviceLines.ts), ratings, loans and the borrowing on
 * offer, and grants (systems/loans.ts, systems/grants.ts).
 */
import { CREDIT_RATINGS, GRANT_OFFERS, LOANS } from "@data/finance";
import {
  SERVICE_LINES,
  addInto,
  addServices,
  costs,
  emptyFlows,
  emptyLedger,
  emptyServices,
  emptyStats,
  income,
  type Ledger,
  type MonthReport,
  type ServiceLine,
} from "@sim/agents";
import type { SimState } from "@sim/state";
import { grantById, progress } from "@sim/systems/grants";
import { bankLimit, bankRate, capitalLimit } from "@sim/systems/loans";
import { dateOf, firstDayOf, formatDate, monthName, TICKS_PER_DAY, clockFromTick } from "@sim/time";
import type { StatementMonth } from "@ui/store";

/** Months in the Statement tab before the year to date: this one so far and the ones before. */
const STATEMENT_MONTHS = 6;

const SEGMENT_NOTES = [
  "",
  "Segment 1: no concerns. The trust can borrow for building.",
  "Segment 2: some concerns, watched closely. The trust can still borrow for building.",
  "Segment 3: significant financial concerns, or on revenue support. No new capital loans.",
  "Segment 4: the Recovery Support Programme, under financial special measures. No new capital loans, no agency staff, and building capped each month.",
];

/** A department's income, direct costs and what's left, over a period. */
export interface DepartmentRow {
  line: ServiceLine;
  name: string;
  /** What it's for, for a tooltip. */
  title: string;
  ledger: Ledger;
  income: number;
  pay: number;
  /** Supplies, upkeep, estates, transfers and interest. */
  other: number;
  /** Income less direct costs: its contribution (shared services: their cost, negative). */
  net: number;
  /** Patients or tests it saw, and the direct cost of each. */
  activity: { count: number; unit: string; costEach: number } | null;
}

export interface DepartmentPeriod {
  id: "month" | "last" | "year";
  name: string;
  days: number;
  /** The departments that see patients, and the shared services below the line. */
  patientFacing: DepartmentRow[];
  shared: DepartmentRow[];
  /** Income and costs from before departments were recorded (an older save). */
  unattributed: number;
  surplus: number;
}

export interface FinanceData {
  funding: SimState["funding"];
  /** This month so far, earlier months, then the financial year to date. */
  statement: StatementMonth[];
  departments: DepartmentPeriod[];
  cash: number;
  rating: { label: string; note: string; bad: boolean };
  administration: boolean;
  debt: number;
  monthlyRepayments: number;
  loans: {
    id: number;
    kind: string;
    principal: number;
    balance: number;
    rate: number;
    payment: number;
    monthsLeft: number;
    missed: number;
  }[];
  /** The loan the hospital can take out, and why not if it can't. */
  borrow: {
    kind: "capital" | "bank";
    name: string;
    rate: number;
    limit: number;
    min: number;
    terms: readonly [number, number];
    blocked: string | null;
  };
  grants: {
    offer: {
      name: string;
      funder: string;
      amount: number;
      description: string;
      weeks: number;
      closesIn: number;
      canAccept: boolean;
    } | null;
    active: {
      name: string;
      funder: string;
      amount: number;
      description: string;
      share: number;
      progress: string;
      daysLeft: number;
    }[];
    done: { name: string; met: boolean; when: string }[];
    maxActive: number;
  };
}

/** Months left on an annuity loan with this balance. */
function monthsLeft(balance: number, payment: number, rate: number): number {
  const r = rate / 12;
  if (balance <= 0) return 0;
  if (r === 0) return Math.ceil(balance / payment);
  const x = 1 - (r * balance) / payment;
  return x <= 0 ? Infinity : Math.ceil(-Math.log(x) / Math.log(1 + r));
}

const LOAN_NAMES = {
  capital: "DHSC capital loan",
  revenue_support: "DHSC revenue support",
  bank: "Bank loan",
};

export function describeFinance(state: SimState): FinanceData {
  const privateHospital = state.funding === "private";
  const r = state.rating;
  const rating = privateHospital
    ? {
        label: `Credit rating ${CREDIT_RATINGS[r.credit]!.id}`,
        note:
          r.administration !== null
            ? "In administration."
            : `Banks lend at ${(bankRate(state) * 100).toFixed(1)}% a year. Missed repayments and deficits lower the rating; healthy surpluses raise it.`,
        bad: r.credit >= 4 || r.administration !== null,
      }
    : {
        label: `NHS oversight segment ${r.segment}`,
        note: SEGMENT_NOTES[r.segment]!,
        bad: r.segment >= 3,
      };
  const kind = privateHospital ? "bank" : "capital";
  const blocked = privateHospital
    ? r.administration !== null
      ? "The hospital is in administration"
      : bankLimit(state) < LOANS.bank.min
        ? "The bank won't lend any more"
        : null
    : r.segment >= 3
      ? `In NHS oversight segment ${r.segment}, the trust can't take new capital loans`
      : capitalLimit(state) < LOANS.capital.min
        ? "The trust has borrowed as much as the DHSC will lend"
        : null;
  const g = state.grants;
  const offer = g.offer && grantById.get(g.offer.defId)!;
  return {
    funding: state.funding,
    statement: statement(state),
    departments: departments(state),
    cash: state.money,
    rating,
    administration: r.administration !== null,
    debt: state.loans.reduce((n, l) => n + l.balance, 0),
    monthlyRepayments: state.loans.reduce((n, l) => n + l.payment, 0),
    loans: state.loans.map((l) => ({
      id: l.id,
      kind: LOAN_NAMES[l.kind],
      principal: l.principal,
      balance: l.balance,
      rate: l.rate,
      payment: l.payment,
      monthsLeft: monthsLeft(l.balance, l.payment, l.rate),
      missed: l.missed,
    })),
    borrow: {
      kind,
      name: LOAN_NAMES[kind],
      rate: privateHospital ? bankRate(state) : LOANS.dhscRate,
      limit: privateHospital ? bankLimit(state) : capitalLimit(state),
      min: privateHospital ? LOANS.bank.min : LOANS.capital.min,
      terms: privateHospital ? LOANS.bank.termYears : LOANS.capital.termYears,
      blocked,
    },
    grants: {
      offer:
        offer && g.offer
          ? {
              name: offer.name,
              funder: offer.funder,
              amount: offer.amount,
              description: offer.description,
              weeks: offer.weeks,
              closesIn: Math.max(1, Math.ceil((g.offer.until - state.tick) / TICKS_PER_DAY)),
              canAccept: g.active.length < GRANT_OFFERS.maxActive,
            }
          : null,
      active: g.active.map((a) => {
        const def = grantById.get(a.defId)!;
        const p = progress(state, a);
        return {
          name: def.name,
          funder: def.funder,
          amount: def.amount,
          description: def.description,
          share: p.share,
          progress: p.text,
          daysLeft: Math.max(0, Math.ceil((a.until - state.tick) / TICKS_PER_DAY)),
        };
      }),
      done: [...g.done].reverse().map((d) => ({
        name: grantById.get(d.defId)?.name ?? d.defId,
        met: d.met,
        when: formatDate(clockFromTick(d.tick).day),
      })),
      maxActive: GRANT_OFFERS.maxActive,
    },
  };
}

/** The months of the current financial year (April to March) so far, as one. */
function yearToDate(state: SimState): MonthReport {
  const year = Math.floor(state.month.monthIndex / 12);
  const months = [
    ...state.months.filter((m) => Math.floor(m.monthIndex / 12) === year),
    state.month,
  ];
  const sum: MonthReport = {
    monthIndex: months[0]!.monthIndex,
    days: 0,
    ledger: emptyLedger(),
    stats: emptyStats(),
    openingCash: months[0]!.openingCash,
    closingCash: state.month.closingCash,
    flows: emptyFlows(),
    services: emptyServices(),
    end: state.month.end,
  };
  for (const m of months) {
    sum.days += m.days;
    addInto(sum.ledger, m.ledger);
    addInto(sum.stats, m.stats);
    addInto(sum.flows, m.flows);
    addServices(sum.services, m.services);
  }
  return sum;
}

/** The financial year so far: "Year 1 to date". */
function yearName(monthIndex: number): string {
  return `Year ${Math.floor(monthIndex / 12) + 1} to date`;
}

function toStatement(m: MonthReport, name: string): StatementMonth {
  return {
    name,
    days: m.days,
    ledger: m.ledger,
    flows: m.flows,
    openingCash: m.openingCash,
    closingCash: m.closingCash,
  };
}

const nameOf = (m: MonthReport) => monthName(dateOf(firstDayOf(m.monthIndex)));

function statement(state: SimState): StatementMonth[] {
  const months = [state.month, ...state.months.slice(-(STATEMENT_MONTHS - 1)).reverse()];
  const cols = months.map((m, i) => toStatement(m, i === 0 ? `${nameOf(m)} so far` : nameOf(m)));
  // The year to date only adds something once there's an earlier month in it.
  if (
    state.months.some(
      (m) => Math.floor(m.monthIndex / 12) === Math.floor(state.month.monthIndex / 12),
    )
  ) {
    cols.push(toStatement(yearToDate(state), yearName(state.month.monthIndex)));
  }
  return cols;
}

const DEPARTMENTS: Record<ServiceLine, { name: string; title: string; unit: string | null }> = {
  ae: {
    name: "A&E",
    title: "Attendances, the block contract's A&E share, and the A&E team",
    unit: "attendance",
  },
  wards: {
    name: "Wards",
    title: "Emergency admissions' stays, the ward share of planned inpatients, and the ward teams",
    unit: "discharge",
  },
  theatres: {
    name: "Theatres",
    title: "Operations: planned (day cases, and the theatre share of inpatients) and emergency",
    unit: "operation",
  },
  outpatients: { name: "Outpatients", title: "Clinic appointments", unit: "appointment" },
  diagnostics: {
    name: "Diagnostics",
    title: "X-ray, CT and the lab: paid for within other departments' tariffs, so a shared cost",
    unit: "test",
  },
  support: {
    name: "Support and overheads",
    title:
      "Porters, cleaners, the mortuary, corridors, shared waiting areas and staff areas, and loan interest",
    unit: null,
  },
};

/** Patients or tests a department saw over the period. */
function activity(line: ServiceLine, m: MonthReport): number {
  const s = m.stats;
  switch (line) {
    case "ae":
      return s.departures;
    case "wards":
      return s.wardDischarges;
    case "theatres":
      return s.electiveOps + s.emergencyOps;
    case "outpatients":
      return s.firstAppointments + s.followUps;
    case "diagnostics":
      return s.xrays + s.ctScans + s.bloodResults;
    case "support":
      return 0;
  }
}

function departmentRow(line: ServiceLine, m: MonthReport): DepartmentRow {
  const l = m.services[line];
  const pay = l.salaries + l.bank + l.agency;
  const direct = costs(l);
  const d = DEPARTMENTS[line];
  const count = activity(line, m);
  return {
    line,
    name: d.name,
    title: d.title,
    ledger: l,
    income: income(l),
    pay,
    other: direct - pay,
    net: income(l) - direct,
    activity: d.unit && count > 0 ? { count, unit: d.unit, costEach: direct / count } : null,
  };
}

function departmentPeriod(
  id: DepartmentPeriod["id"],
  name: string,
  m: MonthReport,
): DepartmentPeriod {
  const rows = SERVICE_LINES.map((line) => departmentRow(line, m)).filter(
    (r) => r.income !== 0 || r.pay + r.other !== 0,
  );
  const shared = (r: DepartmentRow) => r.line === "diagnostics" || r.line === "support";
  const surplus = income(m.ledger) - costs(m.ledger);
  const attributed = rows.reduce((n, r) => n + r.net, 0);
  return {
    id,
    name,
    days: m.days,
    patientFacing: rows.filter((r) => !shared(r)),
    shared: rows.filter(shared),
    unattributed: Math.abs(surplus - attributed) < 1 ? 0 : surplus - attributed,
    surplus,
  };
}

function departments(state: SimState): DepartmentPeriod[] {
  const periods = [departmentPeriod("month", `${nameOf(state.month)} so far`, state.month)];
  const last = state.months[state.months.length - 1];
  if (last) periods.push(departmentPeriod("last", nameOf(last), last));
  if (
    state.months.some(
      (m) => Math.floor(m.monthIndex / 12) === Math.floor(state.month.monthIndex / 12),
    )
  ) {
    periods.push(departmentPeriod("year", yearName(state.month.monthIndex), yearToDate(state)));
  }
  return periods;
}
