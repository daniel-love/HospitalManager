/**
 * What the Finance dialog shows: ratings, loans and the borrowing on offer,
 * and grants (systems/loans.ts, systems/grants.ts).
 */
import { CREDIT_RATINGS, GRANT_OFFERS, LOANS } from "@data/finance";
import type { SimState } from "@sim/state";
import { grantById, progress } from "@sim/systems/grants";
import { bankLimit, bankRate, capitalLimit } from "@sim/systems/loans";
import { formatDate, TICKS_PER_DAY, clockFromTick } from "@sim/time";

const SEGMENT_NOTES = [
  "",
  "Segment 1: no concerns. The trust can borrow for building.",
  "Segment 2: some concerns, watched closely. The trust can still borrow for building.",
  "Segment 3: significant financial concerns, or on revenue support. No new capital loans.",
  "Segment 4: the Recovery Support Programme, under financial special measures. No new capital loans, no agency staff, and building capped each month.",
];

export interface FinanceData {
  funding: SimState["funding"];
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
