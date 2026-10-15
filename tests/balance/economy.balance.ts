/**
 * Economy balance check (not part of `npm test`; run `npm run balance`).
 * Headless runs of the test hospitals with a lean but safe rota, printing
 * each one's average day from the third week on: income by line, costs by
 * line, the net, and how the A&E is doing. Used for the M5 rebalance; rerun
 * after changing tariffs, pay, funding or running costs.
 */
import { it } from "vitest";
import type { SpecialtyId, StaffRoleId } from "@data/schema";
import type { NurseBand } from "@data/staff";
import { SERVICE_LINES, costs, income, type Ledger } from "@sim/agents";
import { tick } from "@sim/sim";
import type { SimState } from "@sim/state";
import { setCover } from "@sim/systems/rota";
import { applyStaffCommand } from "@sim/systems/staffing";
import { TICKS_PER_DAY } from "@sim/time";
import { buildHospital } from "../fixtures/hospital";
import { buildMajorsAE } from "../fixtures/majorsAE";
import { buildPlannedCare, grantPrivileges } from "../fixtures/plannedCare";
import { FIXTURE_MONEY } from "../fixtures/smallAE";

type Cover = [StaffRoleId, number, number, { band?: NurseBand; specialty?: SpecialtyId }?];

/** People wanted on each day and night shift: A&E, diagnostics and a medical registrar. */
const AE_COVER: Cover[] = [
  ["nurse", 6, 5],
  ["nurse", 1, 1, { band: 7 }],
  ["junior_doctor", 4, 2],
  ["receptionist", 1, 1],
  ["cleaner", 2, 1],
  ["porter", 2, 1],
  ["radiographer", 1, 1],
  ["biomedical_scientist", 1, 1],
  ["registrar", 1, 1, { specialty: "general_medicine" }],
];
/** On top, for outpatients and theatres. */
const ELECTIVE_COVER: Cover[] = [
  ["receptionist", 1, 0],
  ["theatre_practitioner", 2, 1],
];

/** Sets each group's cover and hires enough people (three shifts a week each) to meet it. */
function staff(state: SimState, cover: Cover[]): void {
  state.settings.rotas = true;
  state.policies.gapFill = "bank";
  const wanted = new Map<
    string,
    { role: StaffRoleId; extra: object; day: number; night: number }
  >();
  for (const [role, day, night, extra = {}] of cover) {
    const key = `${role}:${JSON.stringify(extra)}`;
    const w = wanted.get(key) ?? { role, extra, day: 0, night: 0 };
    w.day += day;
    w.night += night;
    wanted.set(key, w);
  }
  for (const w of wanted.values()) {
    const e = w.extra as { band?: NurseBand; specialty?: SpecialtyId };
    const group =
      w.role === "nurse"
        ? `nurse:band${e.band ?? 5}`
        : e.specialty
          ? `${w.role}:${e.specialty}`
          : w.role;
    setCover(state, group, { day: w.day, night: w.night });
    const n = Math.ceil(((w.day + w.night) * 7) / 3);
    for (let i = 0; i < n; i++)
      applyStaffCommand(state, { type: "hire_staff", role: w.role, ...e });
  }
}

function consultant(
  state: SimState,
  specialty: SpecialtyId,
  clinics = 0,
  lists = 0,
  onCall = false,
): void {
  const r = applyStaffCommand(state, { type: "hire_staff", role: "consultant", specialty, onCall });
  if (!r.ok) throw new Error(r.error);
  const id = r.staff.id;
  if (clinics) applyStaffCommand(state, { type: "set_clinic_sessions", id, sessions: clinics });
  if (lists) applyStaffCommand(state, { type: "set_theatre_sessions", id, sessions: lists });
}

function report(name: string, state: SimState, days: number): void {
  const built = FIXTURE_MONEY - state.money;
  for (let i = 0; i < days * TICKS_PER_DAY; i++) tick(state);
  const h = state.history.slice(14);
  const avg = (f: (d: (typeof h)[number]) => number) =>
    Math.round(h.reduce((a, d) => a + f(d), 0) / h.length);
  const line = (k: keyof Ledger) => avg((d) => d.ledger[k]);
  const stat = (k: keyof (typeof h)[number]["stats"]) => avg((d) => d.stats[k]);
  console.log(
    name,
    JSON.stringify({
      built: Math.round(built),
      staff: Object.keys(state.staff).length,
      block: line("block"),
      tariff: line("tariff"),
      elective: line("elective"),
      outpatients: line("outpatients"),
      salaries: line("salaries"),
      bank: line("bank"),
      agency: line("agency"),
      supplies: line("supplies"),
      estates: line("estates"),
      upkeep: line("upkeep"),
      transfers: line("transfers"),
      income: avg((d) => income(d.ledger)),
      costs: avg((d) => costs(d.ledger)),
      net: avg((d) => income(d.ledger) - costs(d.ledger)),
      arrivals: stat("arrivals"),
      leftUnseen: stat("lwbs"),
      admissions: stat("admissions"),
      fourHour: avg((d) => (100 * d.stats.within4h) / Math.max(1, d.stats.departures)),
      plannedOps: stat("electiveOps"),
      private: line("private"),
      privateSeen: stat("privateSeen"),
      privateOps: stat("privateOps"),
      reputation: Math.round(state.reputation),
      clinicAppointments: avg((d) => d.stats.firstAppointments + d.stats.followUps),
      occupancy: avg((d) => (100 * d.stats.occupiedBedHours) / Math.max(1, d.stats.bedHours)),
      sickness: avg(
        (d) => (100 * d.stats.sickShifts) / Math.max(1, d.stats.shifts + d.stats.sickShifts),
      ),
    }),
  );
  // Each department's contribution a day, over the whole run (services are kept by month).
  const months = [...state.months, state.month];
  const runDays = months.reduce((n, m) => n + m.days, 0);
  const contribution = Object.fromEntries(
    SERVICE_LINES.map((l) => [
      l,
      Math.round(
        months.reduce((n, m) => n + income(m.services[l]) - costs(m.services[l]), 0) / runDays,
      ),
    ]),
  );
  console.log(name, "contribution a day by department", JSON.stringify(contribution));
}

function aeOnly(catchment: number): SimState {
  const state = buildMajorsAE(1, { ambulance: true, ward: "door_double" });
  state.settings.catchment = catchment;
  staff(state, AE_COVER);
  consultant(state, "cardiology", 0, 0, true);
  consultant(state, "general_surgery", 0, 0, true);
  coordinator(state);
  return state;
}

/** A discharge coordinator (weekdays), so social care is asked for on admission. */
function coordinator(state: SimState): void {
  applyStaffCommand(state, { type: "hire_staff", role: "discharge_coordinator" });
}

function hospital(catchment: number): SimState {
  const state = buildHospital(1);
  state.settings.catchment = catchment;
  staff(state, [...AE_COVER, ...ELECTIVE_COVER]);
  consultant(state, "cardiology", 4);
  consultant(state, "trauma_orthopaedics", 3, 3);
  consultant(state, "anaesthetics", 0, 3);
  consultant(state, "general_surgery", 0, 0, true);
  consultant(state, "general_medicine", 0, 0, true);
  coordinator(state);
  return state;
}

/** A Private Hospital: clinics, two theatres, three side rooms; a lean planned-care rota. */
function privateHospital(catchment: number, phs: boolean): SimState {
  const state = buildPlannedCare(1, "private");
  state.settings.catchment = catchment;
  staff(state, [
    ["nurse", 3, 2],
    ["nurse", 1, 0, { band: 7 }],
    ["junior_doctor", 1, 1],
    ["receptionist", 1, 0],
    ["cleaner", 1, 1],
    ["porter", 1, 1],
    ["theatre_practitioner", 2, 0],
  ]);
  grantPrivileges(state, [
    { specialty: "cardiology", clinics: 4, lists: 0 },
    { specialty: "trauma_orthopaedics", clinics: 3, lists: 3 },
    { specialty: "general_surgery", clinics: 3, lists: 2 },
    { specialty: "anaesthetics", clinics: 0, lists: 4 },
    { specialty: "anaesthetics", clinics: 0, lists: 1 },
  ]);
  if (phs) {
    for (const sp of ["cardiology", "trauma_orthopaedics", "general_surgery"] as const) {
      state.policies.phsReferrals[sp] = true;
    }
  }
  return state;
}

it("A&E and a six-bed ward, 80k", () => report("ae80k", aeOnly(80_000), 42), 900_000);
it("whole hospital, 80k", () => report("hospital80k", hospital(80_000), 56), 900_000);
it("whole hospital, 40k", () => report("hospital40k", hospital(40_000), 56), 900_000);
it(
  "private hospital, 80k",
  () => report("private80k", privateHospital(80_000, false), 56),
  900_000,
);
it(
  "private hospital with PHS referrals, 80k",
  () => report("privatePhs80k", privateHospital(80_000, true), 56),
  900_000,
);
