/**
 * Upgrades older save files to the current version, one step at a time.
 * When SIM_STATE_VERSION goes from N to N+1, add a `N: (save) => ...` entry
 * that transforms a version-N save into a version-N+1 save.
 */
import { SIM_STATE_VERSION } from "@sim/state";

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
