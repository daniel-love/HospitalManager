/**
 * Upgrades older save files to the current version, one step at a time.
 * When SIM_STATE_VERSION goes from N to N+1, add a `N: (save) => ...` entry
 * that transforms a version-N save into a version-N+1 save.
 */
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
