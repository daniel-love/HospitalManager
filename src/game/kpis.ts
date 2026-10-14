/**
 * Key performance indicators (GAME_DESIGN §8.5): the monthly measures an
 * NHS trust board sees in its integrated performance report, each against
 * its national standard (or a usual benchmark where there's no standard),
 * rated green, amber or red. Computed from a month's report
 * (systems/finance.ts), so the current month counts the days filed so far.
 */
import type { MonthReport } from "@sim/agents";
import { net } from "@sim/agents";

export type Rag = "ok" | "warn" | "bad" | "none";

export type KpiSection =
  | "Urgent and emergency care"
  | "Planned care"
  | "Inpatients"
  | "Quality and safety"
  | "Workforce"
  | "Finance";

export interface Kpi {
  id: string;
  section: KpiSection;
  label: string;
  /** The standard or benchmark, in words. */
  standard: string;
  /** What it measures, for a tooltip. */
  title: string;
  /** The month's figure, or null if there's nothing to measure. */
  value: (m: MonthReport) => number | null;
  format: (v: number) => string;
  rate: (v: number) => Rag;
  /** Only for a hospital with an A&E (not a Private Hospital). */
  ae?: boolean;
}

const share = (n: number, d: number) => (d === 0 ? null : n / d);
const pct = (v: number) => `${Math.round(v * 100)}%`;
const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;
const count = (v: number) => String(Math.round(v));
const money = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});

/** Higher is better: green at or above `ok`, amber at or above `warn`. */
const atLeast = (ok: number, warn: number) => (v: number) =>
  v >= ok ? "ok" : v >= warn ? "warn" : "bad";
/** Lower is better: green at or below `ok`, amber at or below `warn`. */
const atMost = (ok: number, warn: number) => (v: number) =>
  v <= ok ? "ok" : v <= warn ? "warn" : "bad";
/** For information: no rating. */
const unrated = () => "none" as const;

export const KPIS: Kpi[] = [
  {
    id: "four_hour",
    section: "Urgent and emergency care",
    label: "A&E within 4 hours",
    standard: "95% (78% interim)",
    title: "Patients leaving A&E within 4 hours of arriving",
    value: (m) => share(m.stats.within4h, m.stats.departures),
    format: pct,
    rate: atLeast(0.95, 0.78),
    ae: true,
  },
  {
    id: "trolley_12h",
    section: "Urgent and emergency care",
    label: "12-hour trolley waits",
    standard: "None",
    title: "Admitted patients waiting over 12 hours in A&E from the decision to admit",
    value: (m) => (m.stats.departures + m.stats.admissions === 0 ? null : m.stats.bedWaitsOver12h),
    format: count,
    rate: atMost(0, 2),
    ae: true,
  },
  {
    id: "handover",
    section: "Urgent and emergency care",
    label: "Ambulance handover, average",
    standard: "15 min",
    title: "Average time from an ambulance arriving to the crew handing over",
    value: (m) => (m.stats.handovers === 0 ? null : m.stats.handoverMins / m.stats.handovers),
    format: (v) => `${Math.round(v)} min`,
    rate: atMost(15, 30),
    ae: true,
  },
  {
    id: "handover_60",
    section: "Urgent and emergency care",
    label: "Handovers over 60 minutes",
    standard: "None",
    title: "Ambulance crews held over an hour before handing over",
    value: (m) => (m.stats.handovers === 0 ? null : m.stats.handoversOver60),
    format: count,
    rate: atMost(0, 0),
    ae: true,
  },
  {
    id: "lwbs",
    section: "Urgent and emergency care",
    label: "Left without being seen",
    standard: "Under 5%",
    title: "A&E patients who gave up waiting and left",
    value: (m) => share(m.stats.lwbs, m.stats.departures),
    format: pct1,
    rate: atMost(0.05, 0.1),
    ae: true,
  },
  {
    id: "rtt",
    section: "Planned care",
    label: "Waiting under 18 weeks",
    standard: "92%",
    title:
      "NHS patients waiting for treatment less than 18 weeks since their GP referral, at the month's end",
    value: (m) => share(m.end.rttWithin18w, m.end.rttWaiting),
    format: pct,
    rate: atLeast(0.92, 0.8),
  },
  {
    id: "cancer_2ww",
    section: "Planned care",
    label: "Urgent referrals seen in 2 weeks",
    standard: "93%",
    title: "Suspected cancer referrals seen within two weeks",
    value: (m) => share(m.stats.urgentWithin2w, m.stats.urgentSeen),
    format: pct,
    rate: atLeast(0.93, 0.85),
  },
  {
    id: "dna",
    section: "Planned care",
    label: "Missed appointments",
    standard: "Under 8%",
    title: "Outpatient appointments the patient didn't attend (DNA)",
    value: (m) => share(m.stats.dnas, m.stats.firstAppointments + m.stats.followUps + m.stats.dnas),
    format: pct1,
    rate: atMost(0.08, 0.12),
  },
  {
    id: "cancelled",
    section: "Planned care",
    label: "Operations cancelled on the day",
    standard: "Under 1%",
    title: "Planned operations the hospital cancelled on the day (no bed, the list overran)",
    value: (m) => share(m.stats.cancelledOnDay, m.stats.electiveOps + m.stats.cancelledOnDay),
    format: pct1,
    rate: atMost(0.01, 0.03),
  },
  {
    id: "emergency_ops",
    section: "Planned care",
    label: "Emergency operations on time",
    standard: "90%",
    title: "Emergency operations started by the time their urgency called for",
    value: (m) => share(m.stats.emergencyOnTime, m.stats.emergencyOps),
    format: pct,
    rate: atLeast(0.9, 0.75),
  },
  {
    id: "occupancy",
    section: "Inpatients",
    label: "Bed occupancy",
    standard: "92% or less",
    title:
      "Ward beds in use, on average. Above about 92%, patients wait in A&E for beds and outliers rise",
    value: (m) => share(m.stats.occupiedBedHours, m.stats.bedHours),
    format: pct,
    rate: atMost(0.92, 0.95),
  },
  {
    id: "los",
    section: "Inpatients",
    label: "Average length of stay",
    standard: "—",
    title: "Admission to discharge, for patients going home from a ward",
    value: (m) =>
      m.stats.wardDischarges === 0 ? null : m.stats.stayMins / m.stats.wardDischarges / 60,
    format: (h) => (h < 48 ? `${Math.round(h)} h` : `${(h / 24).toFixed(1)} days`),
    rate: unrated,
  },
  {
    id: "outliers",
    section: "Inpatients",
    label: "Outliers",
    standard: "—",
    title: "Patients admitted to another specialty's ward because theirs was full",
    value: (m) => (m.stats.admissions === 0 ? null : m.stats.outliers),
    format: count,
    rate: unrated,
  },
  {
    id: "corridor",
    section: "Inpatients",
    label: "Corridor care",
    standard: "None",
    title: "Patient-nights spent on escalation trolleys",
    value: (m) => (m.stats.bedHours === 0 ? null : m.stats.corridorNights),
    format: count,
    rate: atMost(0, 5),
  },
  {
    id: "unexpected_deaths",
    section: "Quality and safety",
    label: "Unexpected deaths",
    standard: "—",
    title: "Deaths after a failed resuscitation",
    value: (m) => m.stats.unexpectedDeaths,
    format: count,
    rate: atMost(0, 2),
  },
  {
    id: "incidents",
    section: "Quality and safety",
    label: "Patient safety incidents",
    standard: "—",
    title: "Incidents raised: reporting them is good practice, so this isn't rated",
    value: (m) => m.stats.incidents,
    format: count,
    rate: unrated,
  },
  {
    id: "complaints",
    section: "Quality and safety",
    label: "Complaints",
    standard: "—",
    title: "Complaints about how a death was handled",
    value: (m) => m.stats.complaints,
    format: count,
    rate: atMost(0, 2),
  },
  {
    id: "reputation",
    section: "Quality and safety",
    label: "Reputation",
    standard: "60",
    title: "What patients and GPs think of the hospital, 0–100, at the month's end",
    value: (m) => m.end.reputation,
    format: count,
    rate: atLeast(60, 40),
  },
  {
    id: "sickness",
    section: "Workforce",
    label: "Sickness absence",
    standard: "Under 5%",
    title: "Rostered shifts lost to sickness",
    value: (m) => share(m.stats.sickShifts, m.stats.shifts + m.stats.sickShifts),
    format: pct1,
    rate: atMost(0.05, 0.07),
  },
  {
    id: "unfilled",
    section: "Workforce",
    label: "Places left short",
    standard: "None",
    title:
      "Places short of the rota's cover at the start of a shift that no bank or agency staff filled",
    value: (m) => (m.stats.shifts === 0 ? null : m.stats.unfilledShifts),
    format: count,
    rate: atMost(0, 10),
  },
  {
    id: "agency",
    section: "Workforce",
    label: "Agency share of pay",
    standard: "Under 3.2%",
    title: "Agency staff costs as a share of the whole pay bill (the NHS limit)",
    value: (m) => share(m.ledger.agency, m.ledger.salaries + m.ledger.bank + m.ledger.agency),
    format: pct1,
    rate: atMost(0.032, 0.06),
  },
  {
    id: "turnover",
    section: "Workforce",
    label: "Turnover, a year",
    standard: "Under 12%",
    title: "Staff handing in their notice, as a yearly rate of the headcount",
    value: (m) =>
      m.end.headcount === 0 || m.days === 0
        ? null
        : (m.stats.resignations / m.end.headcount) * (365 / m.days),
    format: pct,
    rate: atMost(0.12, 0.18),
  },
  {
    id: "surplus",
    section: "Finance",
    label: "Surplus or deficit",
    standard: "Break even",
    title: "Income less running costs",
    value: (m) => (m.days === 0 ? null : net(m.ledger)),
    format: (v) => money.format(v),
    rate: (v) => (v >= 0 ? "ok" : "bad"),
  },
];
