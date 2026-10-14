/**
 * Upgrades older save files to the current version, one step at a time.
 * When SIM_STATE_VERSION goes from N to N+1, add a `N: (save) => ...` entry
 * that transforms a version-N save into a version-N+1 save.
 */
import { dateOf } from "@sim/time";
import { specialtyById } from "@data/catalogue";
import type { SpecialtyId } from "@data/schema";
import { SIM_STATE_VERSION } from "@sim/state";
import { createFloorGrid } from "@sim/world/grid";
import { fitSite } from "@sim/world/site";
import { fromBase64, toBase64 } from "./base64";

type RawSave = Record<string, unknown> & { version: number };

const migrations: Record<number, (save: RawSave) => RawSave> = {
  // v2 added build plans (plan mode).
  1: (save) => ({ ...save, state: { ...(save.state as object), plan: [] } }),
  // v3 added patients, staff, the job board and finance (M2).
  2: (save) => ({
    ...save,
    state: {
      ...(save.state as object),
      layoutVersion: 0,
      patients: [],
      staff: [],
      nextAgentId: 1,
      jobs: [],
      nextJobId: 1,
      reserved: {},
      dirt: {},
      today: {
        ledger: { tariff: 0, salaries: 0, upkeep: 0 },
        stats: {
          arrivals: 0,
          discharged: 0,
          lwbs: 0,
          within4h: 0,
          departures: 0,
          triaged: 0,
          triageWaitMins: 0,
          timeInDeptMins: 0,
        },
      },
      history: [],
      settings: { patientVolume: 1 },
      alerts: {},
    },
  }),
  // v4: a job can be done by several roles (Emergency Nurse Practitioners).
  3: (save) => {
    const state = save.state as { jobs: { role: string }[] };
    return {
      ...save,
      state: {
        ...state,
        jobs: state.jobs.map(({ role, ...job }) => ({ ...job, roles: [role] })),
      },
    };
  },
  // v5 (M3): deterioration, observations, crash calls and incident records.
  4: (save) => {
    type Stats = Record<string, unknown>;
    const state = save.state as {
      patients: object[];
      today: { ledger: object; stats: Stats };
      history: { stats: Stats }[];
    };
    const stats = (s: Stats) => ({ ...s, transferred: 0, incidents: 0 });
    return {
      ...save,
      state: {
        ...state,
        patients: state.patients.map((p) => ({ ...p, deterioration: null, obs: null })),
        today: { ...state.today, stats: stats(state.today.stats) },
        history: state.history.map((d) => ({ ...d, stats: stats(d.stats) })),
        incidents: [],
        nextIncidentId: 1,
      },
    };
  },
  // v6 (M3): ambulances and handovers.
  5: (save) => {
    type Stats = Record<string, unknown>;
    const state = save.state as {
      patients: object[];
      today: { ledger: object; stats: Stats };
      history: { stats: Stats }[];
    };
    const stats = (s: Stats) => ({
      ...s,
      ambulances: 0,
      handovers: 0,
      handoverMins: 0,
      handoversOver30: 0,
      handoversOver60: 0,
    });
    return {
      ...save,
      state: {
        ...state,
        patients: state.patients.map((p) => ({ ...p, ambulanceId: null })),
        today: { ...state.today, stats: stats(state.today.stats) },
        history: state.history.map((d) => ({ ...d, stats: stats(d.stats) })),
        ambulances: [],
        nextAmbulanceId: 1,
      },
    };
  },
  // v7 (M3): porters, wards and admissions.
  6: (save) => {
    type Stats = Record<string, unknown>;
    const state = save.state as {
      patients: { times: object }[];
      today: { ledger: object; stats: Stats };
      history: { stats: Stats }[];
    };
    const stats = (s: Stats) => ({
      ...s,
      admissions: 0,
      bedWaitMins: 0,
      bedWaitsOver4h: 0,
      bedWaitsOver12h: 0,
      wardDischarges: 0,
      transfersOut: 0,
    });
    return {
      ...save,
      state: {
        ...state,
        patients: state.patients.map((p) => ({
          ...p,
          times: { ...p.times, decided: null, admitted: null },
          stayUntil: null,
        })),
        today: { ...state.today, stats: stats(state.today.stats) },
        history: state.history.map((d) => ({ ...d, stats: stats(d.stats) })),
      },
    };
  },
  // v8 (M3): deaths, the mortuary and staff morale.
  7: (save) => {
    type Stats = Record<string, unknown>;
    const state = save.state as {
      patients: object[];
      staff: object[];
      today: { ledger: object; stats: Stats };
      history: { stats: Stats }[];
    };
    const stats = (s: Stats) => ({ ...s, deaths: 0, unexpectedDeaths: 0, complaints: 0 });
    return {
      ...save,
      state: {
        ...state,
        patients: state.patients.map((p) => ({ ...p, endOfLife: false, death: null })),
        staff: state.staff.map((s) => ({ ...s, morale: 75 })),
        today: { ...state.today, stats: stats(state.today.stats) },
        history: state.history.map((d) => ({ ...d, stats: stats(d.stats) })),
      },
    };
  },
  // v9: land ownership and the public road. Older maps were all the hospital's
  // own land, with no road.
  8: (save) => {
    const state = save.state as { floors: { width: number; height: number }[] };
    return {
      ...save,
      state: {
        ...state,
        floors: state.floors.map((f) => ({ ...f, land: zeroBase64(f.width * f.height) })),
        site: null,
      },
    };
  },
  // v10: ambulances drive in along the road, so they have a position and route.
  9: (save) => {
    type Space = { x: number; y: number; w: number; h: number };
    const state = save.state as {
      ambulances: { space: Space | null }[];
      site: { road: { y: number } } | null;
    };
    // Parked ones sit at their space; waiting ones queue at the west end of the road.
    const waitAt = { x: 0, y: state.site ? state.site.road.y + 1 : 0 };
    return {
      ...save,
      state: {
        ...state,
        ambulances: state.ambulances.map((a) => {
          const at = a.space
            ? { x: a.space.x + Math.floor(a.space.w / 2), y: a.space.y + Math.floor(a.space.h / 2) }
            : waitAt;
          return {
            ...a,
            phase: a.space ? "parked" : "arriving",
            x: at.x,
            y: at.y,
            prevX: at.x,
            prevY: at.y,
            route: [],
            routeVersion: 0,
            from: 0,
          };
        }),
      },
    };
  },
  // v11: hospitals built before the road get one, fitted in below the
  // building with a free footpath to the door (see fitSite). Waiting
  // ambulances move onto it.
  10: (save) => {
    type Floor = { width: number; height: number } & Record<string, string | number>;
    const state = save.state as {
      floors: Floor[];
      site: unknown;
      ambulances: { phase: string; space: unknown; x: number; y: number }[];
    };
    const ground = state.floors[0];
    if (state.site || !ground) return save;
    const grid = createFloorGrid(ground.width, ground.height);
    const read = (key: string) => fromBase64(String(ground[key]));
    grid.floorType.set(read("floorType"));
    grid.wall.set(read("wall"));
    grid.door.set(read("door"));
    grid.land.set(read("land"));
    const site = fitSite(grid);
    if (!site) return save;
    const enter = { x: 0, y: site.road.y + 1 };
    return {
      ...save,
      state: {
        ...state,
        floors: [
          { ...ground, floorType: toBase64(grid.floorType), land: toBase64(grid.land) },
          ...state.floors.slice(1),
        ],
        site,
        ambulances: state.ambulances.map((a) =>
          a.phase === "arriving" && !a.space
            ? { ...a, ...enter, prevX: enter.x, prevY: enter.y }
            : a,
        ),
      },
    };
  },
  // v12: demand comes from the catchment population. Older games ran at
  // about a small town's rates; ambulances deflected elsewhere are counted.
  11: (save) => {
    type Stats = Record<string, unknown>;
    const state = save.state as {
      settings: Record<string, unknown>;
      today: { ledger: object; stats: Stats };
      history: { stats: Stats }[];
    };
    const stats = (s: Stats) => ({ ...s, deflected: 0 });
    return {
      ...save,
      state: {
        ...state,
        settings: { ...state.settings, catchment: 80_000 },
        today: { ...state.today, stats: stats(state.today.stats) },
        history: state.history.map((d) => ({ ...d, stats: stats(d.stats) })),
      },
    };
  },
  // v13 (M4): specialties, consultants and registrars, and referrals.
  12: (save) => {
    type Stats = Record<string, unknown>;
    const state = save.state as {
      patients: { times: object }[];
      staff: object[];
      jobs: object[];
      today: { ledger: object; stats: Stats };
      history: { stats: Stats }[];
    };
    const stats = (s: Stats) => ({ ...s, referrals: 0, referralMins: 0, outliers: 0 });
    return {
      ...save,
      state: {
        ...state,
        patients: state.patients.map((p) => ({
          ...p,
          specialty: null,
          times: { ...p.times, referred: null },
        })),
        staff: state.staff.map((s) => ({ ...s, specialty: null, onCall: null })),
        jobs: state.jobs.map((j) => ({ ...j, specialty: null })),
        wardSpecialties: {},
        today: { ...state.today, stats: stats(state.today.stats) },
        history: state.history.map((d) => ({ ...d, stats: stats(d.stats) })),
      },
    };
  },
  // v14 (M4): the Medical Examiner is a consultant's duty. Dedicated
  // Medical Examiners become General Medicine consultants with the duty.
  13: (save) => {
    type Staff = { role: string; specialty: unknown };
    const state = save.state as {
      patients: object[];
      staff: Staff[];
      jobs: { roles: string[] }[];
    };
    const me = (r: string) => (r === "medical_examiner" ? "consultant" : r);
    return {
      ...save,
      state: {
        ...state,
        patients: state.patients.map((p) => ({ ...p, consultants: [] })),
        staff: state.staff.map((s) =>
          s.role === "medical_examiner"
            ? { ...s, role: "consultant", specialty: "general_medicine", meDuty: true }
            : { ...s, meDuty: false },
        ),
        jobs: state.jobs.map((j) => ({ ...j, roles: [...new Set(j.roles.map(me))] })),
      },
    };
  },
  // v15 (M4): A&E transfers patients out to other hospitals.
  14: (save) => {
    type Day = { ledger: { transfers?: number }; stats: { transferWaitMins?: number } };
    const state = save.state as {
      patients: { transfer?: unknown }[];
      today: Day;
      history: Day[];
    };
    const day = (d: Day) => ({
      ...d,
      ledger: { ...d.ledger, transfers: d.ledger.transfers ?? 0 },
      stats: { ...d.stats, transferWaitMins: d.stats.transferWaitMins ?? 0 },
    });
    return {
      ...save,
      state: {
        ...state,
        patients: state.patients.map((p) => ({ ...p, transfer: p.transfer ?? null })),
        today: day(state.today),
        history: state.history.map(day),
      },
    };
  },
  // v16 (M4): blood tests and scans.
  15: (save) => {
    type Day = { stats: Record<string, unknown> };
    const state = save.state as {
      patients: { investigations?: unknown; homeBed?: unknown }[];
      today: Day;
      history: Day[];
    };
    const fields = ["xrays", "ctScans", "doorToCtMins", "ctWithinTarget"];
    const day = (d: Day) => ({
      ...d,
      stats: {
        ...Object.fromEntries([...fields, "bloodResults", "bloodResultMins"].map((k) => [k, 0])),
        ...d.stats,
      },
    });
    return {
      ...save,
      state: {
        ...state,
        patients: state.patients.map((p) => ({
          ...p,
          investigations: p.investigations ?? [],
          homeBed: p.homeBed ?? null,
        })),
        today: day(state.today),
        history: state.history.map(day),
      },
    };
  },
  // v17: privacy curtains are drawn during and after bedside care.
  16: (save) => {
    const state = save.state as { patients: object[] };
    return {
      ...save,
      state: {
        ...state,
        patients: state.patients.map((p) => ({ ...p, curtainUntil: null })),
      },
    };
  },
  // v18: patients are re-triaged down once treatment works.
  17: (save) => {
    const state = save.state as { patients: object[] };
    return {
      ...save,
      state: {
        ...state,
        patients: state.patients.map((p) => ({ ...p, retriaged: null })),
      },
    };
  },
  // v19: staff remember when they last had a job.
  18: (save) => {
    const state = save.state as { tick: number; staff: object[] };
    return {
      ...save,
      state: {
        ...state,
        staff: state.staff.map((s) => ({ ...s, lastActiveTick: state.tick })),
      },
    };
  },
  // v20: funeral directors come to collect from the mortuary.
  19: (save) => ({
    ...save,
    state: { ...(save.state as object), collections: [], nextCollectionId: 1 },
  }),
  // v21: shared kit. Old jobs never fetched any: the ECGs already in bays
  // become shared ones, kept where they stand.
  20: (save) => {
    const state = save.state as { jobs: object[] };
    return { ...save, state: { ...state, jobs: state.jobs.map((j) => ({ ...j, kit: null })) } };
  },
  // v22: outpatient clinics. Clinic rooms take a specialty like wards, so the
  // setting is renamed; nobody has clinic sessions in their job plan yet.
  21: (save) => {
    const { wardSpecialties, ...state } = save.state as {
      wardSpecialties?: object;
      roomSpecialties?: object;
      staff: object[];
    };
    return {
      ...save,
      state: {
        ...state,
        roomSpecialties: wardSpecialties ?? state.roomSpecialties ?? {},
        staff: state.staff.map((s) => ({ ...s, clinicSessions: 0 })),
      },
    };
  },
  // v23: outpatient waiting lists, with their own income line and day stats.
  22: (save) => {
    type Day = { ledger: object; stats: object };
    const state = save.state as { today: Day; history: (Day & { day: number })[] };
    const day = <T extends Day>(d: T): T => ({
      ...d,
      ledger: { ...d.ledger, outpatients: 0 },
      stats: {
        ...d.stats,
        gpReferrals: 0,
        firstAppointments: 0,
        followUps: 0,
        dnas: 0,
        clinicCancellations: 0,
        urgentSeen: 0,
        urgentWithin2w: 0,
        listedForSurgery: 0,
      },
    });
    return {
      ...save,
      state: {
        ...state,
        referrals: [],
        nextReferralId: 1,
        outpatients: [],
        today: day(state.today),
        history: state.history.map(day),
      },
    };
  },
  // v24: theatres. Nobody does theatre lists yet, and no theatre is kept for emergencies.
  23: (save) => {
    const state = save.state as { staff: object[] };
    return {
      ...save,
      state: {
        ...state,
        emergencyTheatres: {},
        staff: state.staff.map((s) => ({ ...s, theatreSessions: 0 })),
      },
    };
  },
  // v25: elective surgery. Patients already listed are day cases where most
  // of their specialty's operations are.
  24: (save) => {
    type Day = { stats: object };
    const state = save.state as {
      patients: object[];
      referrals: { specialty: string }[];
      today: Day;
      history: Day[];
    };
    const stats = (d: Day) => ({
      ...d,
      stats: {
        ...d.stats,
        electiveOps: 0,
        dayCases: 0,
        cancelledOnDay: 0,
        emergencyOps: 0,
        bumped: 0,
      },
    });
    const dayCase = (sp: string) =>
      (specialtyById.get(sp as SpecialtyId)?.surgery?.dayCaseShare ?? 0) >= 0.5;
    return {
      ...save,
      state: {
        ...state,
        patients: state.patients.map((p) => ({ ...p, elective: null })),
        referrals: state.referrals.map((r) => ({
          ...r,
          dayCase: dayCase(r.specialty),
          rebookBy: null,
        })),
        operations: [],
        nextOperationId: 1,
        today: stats(state.today),
        history: state.history.map(stats),
      },
    };
  },
  // v26: emergency surgery.
  25: (save) => {
    type Day = { stats: object };
    const state = save.state as { patients: object[]; today: Day; history: Day[] };
    const stats = (d: Day) => ({ ...d, stats: { ...d.stats, emergencyOnTime: 0 } });
    return {
      ...save,
      state: {
        ...state,
        patients: state.patients.map((p) => ({ ...p, emergencyOp: null })),
        today: stats(state.today),
        history: state.history.map(stats),
      },
    };
  },
  // v27: shifts and rotas. Old hospitals were staffed for everyone working
  // around the clock, so rotas start off (Settings can turn them on).
  26: (save) => {
    type Staff = { onCall: object | null };
    const state = save.state as { staff: Staff[]; settings: object };
    return {
      ...save,
      state: {
        ...state,
        staff: state.staff.map((s) => ({
          ...s,
          contract: s.onCall ? "on_call" : "resident",
          duty: "on",
          shiftEnd: null,
        })),
        cover: {},
        settings: { ...state.settings, rotas: false },
      },
    };
  },
  // v28: nurse bands, skill, fatigue, sickness and resignations, bank and agency.
  27: (save) => {
    type Staff = { id: number; role: string; morale: number };
    type Day = { ledger: object };
    const state = save.state as {
      staff: Staff[];
      cover: Record<string, unknown>;
      today: Day;
      history: Day[];
    };
    const ledger = (d: Day) => ({ ...d, ledger: { ...d.ledger, bank: 0, agency: 0 } });
    // Nurses' cover was for all of them; they were all Band 5.
    const cover = Object.fromEntries(
      Object.entries(state.cover).map(([k, v]) => [k === "nurse" ? "nurse:band5" : k, v]),
    );
    return {
      ...save,
      state: {
        ...state,
        staff: state.staff.map((s) => ({
          ...s,
          band: s.role === "nurse" ? 5 : null,
          // Settled staff: the middle of the usual range, varied a little by id.
          // (Kept if present: tests upgrade saves written by this version.)
          skill: (s as { skill?: number }).skill ?? 50 + ((s.id * 37) % 21) - 10,
          fatigue: 0,
          sickUntil: null,
          leavesAt: null,
          shiftLoad: null,
        })),
        cover,
        policies: { gapFill: "bank" },
        today: ledger(state.today),
        history: state.history.map(ledger),
      },
    };
  },
  // v29: the NHS block contract, planned care on its own line, supplies and
  // estates costs, monthly statements.
  28: (save) => {
    type Day = { day: number; ledger: Record<string, number>; stats: Record<string, number> };
    const state = save.state as { money: number; tick: number; today: Day; history: Day[] };
    // Planned operations were in the tariff line; they stay there.
    const ledger = (d: Day) => ({
      ...d,
      ledger: { block: 0, elective: 0, supplies: 0, estates: 0, ...d.ledger },
    });
    const history = state.history.map(ledger);
    // This month so far, from the daily reports kept.
    const day = Math.floor((state.tick / 10 + 8 * 60) / (24 * 60)) + 1;
    const monthIndex = dateOf(day).monthIndex;
    const inMonth = history.filter((d) => dateOf(d.day).monthIndex === monthIndex);
    const sum = (rows: Record<string, number>[]) => {
      const out: Record<string, number> = {};
      for (const r of rows) for (const [k, v] of Object.entries(r)) out[k] = (out[k] ?? 0) + v;
      return out;
    };
    const month = {
      monthIndex,
      days: inMonth.length,
      ledger: { ...ledger(state.today).ledger, ...sum(inMonth.map((d) => d.ledger)) },
      stats: { ...state.today.stats, ...sum(inMonth.map((d) => d.stats)) },
      openingCash: state.money,
      closingCash: state.money,
    };
    if (inMonth.length === 0) {
      for (const k of Object.keys(month.ledger)) (month.ledger as Record<string, number>)[k] = 0;
      for (const k of Object.keys(month.stats)) (month.stats as Record<string, number>)[k] = 0;
    }
    return {
      ...save,
      state: {
        ...state,
        today: ledger(state.today),
        history,
        // (Kept if present: tests upgrade saves written by this version.)
        month: (state as { month?: unknown }).month ?? month,
        months: (state as { months?: unknown }).months ?? [],
      },
    };
  },
  // v30: funding models (an old hospital is an NHS trust), reputation, private care.
  // Defaults only where missing: tests upgrade saves written by this version.
  29: (save) => {
    type Ledgered = { ledger: object };
    type Day = Ledgered & { stats?: object };
    type Patient = { elective: object | null };
    const state = save.state as {
      staff?: object[];
      patients?: Patient[];
      referrals?: object[];
      policies?: object;
      privateRooms?: object;
      funding?: string;
      reputation?: number;
      today: Day;
      history: Day[];
      month?: Day;
      months?: Day[];
    };
    const ledger = <T extends Ledgered>(d: T) => ({ ...d, ledger: { private: 0, ...d.ledger } });
    const stats = <T extends Day>(d: T) => ({
      ...ledger(d),
      stats: { privateReferrals: 0, privateSeen: 0, privateOps: 0, ...d.stats },
    });
    return {
      ...save,
      state: {
        ...state,
        staff: (state.staff ?? []).map((s) => ({
          privateClinicSessions: 0,
          privateTheatreSessions: 0,
          ...s,
        })),
        patients: (state.patients ?? []).map((p) =>
          p.elective ? { ...p, elective: { payer: "nhs", ...p.elective } } : p,
        ),
        referrals: (state.referrals ?? []).map((r) => ({ payer: "nhs", ...r })),
        policies: { priceLevel: 1, nhsReferrals: {}, ...state.policies },
        privateRooms: state.privateRooms ?? {},
        funding: state.funding ?? "nhs",
        reputation: state.reputation ?? 60,
        today: stats(state.today),
        history: state.history.map((d) => ({ reputation: 60, ...stats(d) })),
        ...(state.month ? { month: stats(state.month) } : {}),
        ...(state.months ? { months: state.months.map(stats) } : {}),
      },
    };
  },
  // v31: loans, ratings, grants; interest and cash flows in the books.
  30: (save) => {
    type Ledgered = { ledger: object };
    type Month = Ledgered & { flows?: object };
    const state = save.state as {
      today: Ledgered;
      history: Ledgered[];
      month: Month;
      months: Month[];
      loans?: object[];
      nextLoanId?: number;
      rating?: object;
      grants?: object;
    };
    const ledger = <T extends Ledgered>(d: T) => ({ ...d, ledger: { interest: 0, ...d.ledger } });
    const flows = { building: 0, borrowed: 0, repaid: 0, grants: 0, clawedBack: 0 };
    const month = (m: Month) => ({ ...ledger(m), flows: m.flows ?? flows });
    return {
      ...save,
      state: {
        ...state,
        today: ledger(state.today),
        history: state.history.map(ledger),
        month: month(state.month),
        months: state.months.map(month),
        loans: state.loans ?? [],
        nextLoanId: state.nextLoanId ?? 1,
        rating: state.rating ?? {
          segment: 2,
          credit: 3,
          administration: null,
          overdrawnSince: null,
        },
        grants: state.grants ?? { offer: null, active: [], nextOffer: 0, done: [] },
      },
    };
  },
};

/** Base64 of n zero bytes, without building them. */
function zeroBase64(n: number): string {
  const tail = ["", "AA==", "AAA="][n % 3]!;
  return "A".repeat(Math.floor(n / 3) * 4) + tail;
}

export function migrate(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || !("version" in raw)) return raw;
  let save = raw as RawSave;
  while (typeof save.version === "number" && save.version < SIM_STATE_VERSION) {
    const step = migrations[save.version];
    if (!step) break; // Leave it for validation to reject.
    save = { ...step(save), version: save.version + 1 };
  }
  return save;
}
