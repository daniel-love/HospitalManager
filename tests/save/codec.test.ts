import { describe, expect, it } from "vitest";
import { decodeSave, encodeSave, SaveError } from "@save/codec";
import { tick } from "@sim/sim";
import { nextU32 } from "@sim/rng";
import { createSimState, SIM_STATE_VERSION, type SimState } from "@sim/state";
import { TICKS_PER_DAY } from "@sim/time";
import { applyStaffCommand } from "@sim/systems/staffing";
import { setWardSpecialty } from "@sim/world/rooms";
import { buildMajorsAE, MAJORS_TEAM, staffedMajorsAE } from "../fixtures/majorsAE";
import { buildSmallAE, staffedSmallAE } from "../fixtures/smallAE";

/** Comparable snapshot of everything that matters, typed arrays included. */
function snapshot(state: SimState) {
  return JSON.parse(
    JSON.stringify(state, (_k, v: unknown) =>
      ArrayBuffer.isView(v) ? Array.from(v as Uint8Array) : v,
    ),
  ) as unknown;
}

/** State added in save version 3 (M2: patients, staff, jobs, finance). */
const M2_FIELDS = [
  "layoutVersion",
  "patients",
  "staff",
  "nextAgentId",
  "jobs",
  "nextJobId",
  "reserved",
  "dirt",
  "today",
  "history",
  "settings",
  "alerts",
];

/** Stats added in save versions 7 and 8, which older saves upgrade to zero. */
const NO_V8_STATS = { deaths: 0, unexpectedDeaths: 0, complaints: 0 };
const NO_V7_STATS = {
  admissions: 0,
  bedWaitMins: 0,
  bedWaitsOver4h: 0,
  bedWaitsOver12h: 0,
  wardDischarges: 0,
  transfersOut: 0,
  ...NO_V8_STATS,
};

/** Simulates saving to disk and loading again. */
function roundTrip(state: SimState): SimState {
  return decodeSave(JSON.parse(JSON.stringify(encodeSave(state, "test")))).state;
}

/**
 * A day and a bit of the small A&E, as an older save could hold it: nobody
 * referred to a specialty (new in version 13) or being transferred out (new
 * in version 15), which upgrading an older save would rightly leave out.
 */
function busyDayBeforeTransfers(): SimState {
  const state = staffedSmallAE(9);
  for (let i = 0; i < TICKS_PER_DAY + 600; i++) tick(state);
  for (const p of Object.values(state.patients)) {
    p.specialty = null;
    p.times.referred = null;
    p.transfer = null;
    p.curtainUntil = null; // Curtains came later too (v17).
    p.retriaged = null; // And re-triage (v18).
  }
  return state;
}

describe("save codec", () => {
  it("round-trips a built hospital exactly, rebuilding derived data", () => {
    const state = buildSmallAE();
    for (let i = 0; i < 100; i++) tick(state);
    nextU32(state.rng);
    const loaded = roundTrip(state);
    expect(snapshot(loaded)).toEqual(snapshot(state));
    expect(loaded.rooms.every((r) => r.valid)).toBe(true);
  });

  it("continues identically after loading (determinism)", () => {
    const a = buildSmallAE(42);
    const b = roundTrip(a);
    for (let i = 0; i < 500; i++) {
      tick(a);
      tick(b);
    }
    expect(nextU32(b.rng)).toBe(nextU32(a.rng));
    expect(b.tick).toBe(a.tick);
  });

  it("records metadata", () => {
    const save = encodeSave(buildSmallAE(), "My A&E", new Date("2026-10-08T12:00:00Z"));
    expect(save.meta).toMatchObject({
      name: "My A&E",
      savedAt: "2026-10-08T12:00:00.000Z",
      gameTime: "Mon day 1  08:00",
    });
  });

  it("rejects things that aren't saves", () => {
    expect(() => decodeSave({ hello: "world" })).toThrow(SaveError);
    expect(() => decodeSave(null)).toThrow(SaveError);
  });

  it("rejects corrupt grids and overlapping objects", () => {
    const save = JSON.parse(JSON.stringify(encodeSave(buildSmallAE(), "x")));
    const shortGrid = structuredClone(save);
    shortGrid.state.floors[0].wall = btoa("abc");
    expect(() => decodeSave(shortGrid)).toThrow(/Wrong size for floor 0 wall/);

    const overlap = structuredClone(save);
    overlap.state.objects.push({ ...overlap.state.objects[0], id: 1 });
    expect(() => decodeSave(overlap)).toThrow(/overlap/);

    const unknown = structuredClone(save);
    unknown.state.objects[0].defId = "time_machine";
    expect(() => decodeSave(unknown)).toThrow(/Unknown item/);
  });

  it("rejects saves from a newer version", () => {
    const save = JSON.parse(JSON.stringify(encodeSave(buildSmallAE(), "x")));
    save.version = 999;
    expect(() => decodeSave(save)).toThrow(SaveError);
  });
});

describe("agents in saves", () => {
  it("saves mid-shift and carries on exactly as if it never stopped", () => {
    const a = staffedSmallAE(9);
    for (let i = 0; i < TICKS_PER_DAY / 2; i++) tick(a);
    expect(Object.keys(a.patients).length).toBeGreaterThan(0);
    expect(Object.keys(a.jobs).length).toBeGreaterThan(0);
    a.events = [];
    const b = roundTrip(a);
    expect(snapshot(b)).toEqual(snapshot(a));
    for (let i = 0; i < TICKS_PER_DAY / 2; i++) {
      tick(a);
      tick(b);
    }
    a.events = [];
    b.events = [];
    expect(snapshot(b)).toEqual(snapshot(a));
  });

  it("rejects a patient with an unknown condition", () => {
    const state = staffedSmallAE(9);
    for (let i = 0; i < TICKS_PER_DAY / 3; i++) tick(state);
    const save = JSON.parse(JSON.stringify(encodeSave(state, "bad")));
    save.state.patients[0].conditionId = "dragon_pox";
    expect(() => decodeSave(save)).toThrow(SaveError);
  });
});

describe("save upgrades", () => {
  it("turns a version-3 job's single role into a list", () => {
    const state = staffedSmallAE(9);
    for (let i = 0; i < TICKS_PER_DAY / 2; i++) tick(state);
    const save = JSON.parse(JSON.stringify(encodeSave(state, "v3")));
    save.version = 3;
    for (const job of save.state.jobs) {
      job.role = job.roles[0];
      delete job.roles;
    }
    const loaded = decodeSave(save).state;
    expect(Object.values(loaded.jobs).map((j) => j.roles)).toEqual(
      Object.values(state.jobs).map((j) => [j.roles[0]]),
    );
  });
});

describe("M3 state in saves", () => {
  it("round-trips deterioration, observations and incidents", async () => {
    const { staffedMajorsAE } = await import("../fixtures/majorsAE");
    const state = staffedMajorsAE(4);
    state.settings.patientVolume = 2;
    let collapsed = false;
    for (let i = 0; i < TICKS_PER_DAY && !collapsed; i++) {
      tick(state);
      collapsed = Object.values(state.patients).some((p) => p.stage === "collapsed");
    }
    expect(collapsed).toBe(true);
    expect(state.incidents.length).toBeGreaterThan(0);
    state.events = []; // Notifications aren't saved.
    const loaded = roundTrip(state);
    expect(snapshot(loaded)).toEqual(snapshot(state));
    for (let i = 0; i < 600; i++) {
      tick(state);
      tick(loaded);
    }
    expect(loaded.incidents).toEqual(state.incidents);
    expect(nextU32(loaded.rng)).toBe(nextU32(state.rng));
  });

  it("upgrades a version-4 save with no monitoring state", () => {
    const state = staffedSmallAE(9);
    for (let i = 0; i < TICKS_PER_DAY + 600; i++) tick(state);
    const save = JSON.parse(JSON.stringify(encodeSave(state, "v4")));
    save.version = 4;
    delete save.state.incidents;
    delete save.state.nextIncidentId;
    for (const p of save.state.patients) {
      delete p.deterioration;
      delete p.obs;
    }
    for (const stats of [
      save.state.today.stats,
      ...save.state.history.map((d: { stats: object }) => d.stats),
    ]) {
      delete stats.transferred;
      delete stats.incidents;
    }
    const loaded = decodeSave(save).state;
    expect(loaded.incidents).toEqual([]);
    expect(loaded.history[0]!.stats).toEqual({ ...state.history[0]!.stats, ...NO_V7_STATS });
    expect(Object.values(loaded.patients).every((p) => p.deterioration === null)).toBe(true);
  });
});

describe("ambulances in saves", () => {
  it("round-trips ambulances parked and waiting, and keeps running identically", async () => {
    const { staffedMajorsAE, MAJORS_TEAM } = await import("../fixtures/majorsAE");
    const state = staffedMajorsAE(2, MAJORS_TEAM, { ambulance: true });
    let both = false;
    for (let i = 0; i < TICKS_PER_DAY && !both; i++) {
      tick(state);
      const all = Object.values(state.ambulances);
      both = all.some((a) => a.space) && all.some((a) => !a.space);
    }
    expect(both).toBe(true);
    state.events = [];
    const loaded = roundTrip(state);
    expect(snapshot(loaded)).toEqual(snapshot(state));
    for (let i = 0; i < 600; i++) {
      tick(state);
      tick(loaded);
    }
    expect(loaded.ambulances).toEqual(state.ambulances);
    expect(nextU32(loaded.rng)).toBe(nextU32(state.rng));
  });

  it("upgrades a version-5 save with no ambulances", () => {
    const state = staffedSmallAE(9);
    for (let i = 0; i < TICKS_PER_DAY + 600; i++) tick(state);
    const save = JSON.parse(JSON.stringify(encodeSave(state, "v5")));
    save.version = 5;
    delete save.state.ambulances;
    delete save.state.nextAmbulanceId;
    for (const p of save.state.patients) delete p.ambulanceId;
    for (const stats of [
      save.state.today.stats,
      ...save.state.history.map((d: { stats: object }) => d.stats),
    ]) {
      for (const k of [
        "ambulances",
        "handovers",
        "handoverMins",
        "handoversOver30",
        "handoversOver60",
      ])
        delete stats[k];
    }
    const loaded = decodeSave(save).state;
    expect(loaded.ambulances).toEqual({});
    expect(loaded.history[0]!.stats).toEqual({ ...state.history[0]!.stats, ...NO_V7_STATS });
  });
});

describe("admissions in saves", () => {
  it("upgrades a version-6 save with no admission state", () => {
    const state = staffedSmallAE(9);
    for (let i = 0; i < TICKS_PER_DAY + 600; i++) tick(state);
    const save = JSON.parse(JSON.stringify(encodeSave(state, "v6")));
    save.version = 6;
    for (const p of save.state.patients) {
      delete p.times.decided;
      delete p.times.admitted;
      delete p.stayUntil;
    }
    for (const stats of [
      save.state.today.stats,
      ...save.state.history.map((d: { stats: object }) => d.stats),
    ]) {
      for (const k of Object.keys(NO_V7_STATS)) delete stats[k];
    }
    const loaded = decodeSave(save).state;
    expect(loaded.history[0]!.stats).toEqual({ ...state.history[0]!.stats, ...NO_V7_STATS });
    expect(Object.values(loaded.patients).every((p) => p.stayUntil === null)).toBe(true);
  });
});

describe("deaths in saves", () => {
  it("round-trips a death part-way through the process", async () => {
    const { staffedDeathsWard } = await import("../fixtures/deathsWard");
    const { spawnPatient } = await import("@sim/systems/arrivals");
    const { die } = await import("@sim/systems/deaths");
    const { reserve, restPoint, siteEntrance } = await import("@sim/places");
    const state = staffedDeathsWard();
    for (let i = 0; i < 200; i++) tick(state);
    const bed = Object.values(state.objects).find((o) => o.defId === "hospital_bed")!;
    const p = spawnPatient(state, siteEntrance(state)!, "sepsis");
    reserve(state, bed.id, 0, p.id);
    p.bed = bed.id;
    p.stage = "on_ward";
    const at = restPoint(bed);
    p.x = p.prevX = at.x;
    p.y = p.prevY = at.y;
    p.times.admitted = state.tick;
    die(state, p, false, true);
    for (let i = 0; i < 600; i++) tick(state);
    state.events = [];
    const loaded = roundTrip(state);
    expect(snapshot(loaded)).toEqual(snapshot(state));
    for (let i = 0; i < 600; i++) {
      tick(state);
      tick(loaded);
    }
    expect(loaded.patients[p.id]?.death).toEqual(state.patients[p.id]?.death);
  });

  it("upgrades a version-7 save with no deaths or morale", () => {
    const state = staffedSmallAE(9);
    for (let i = 0; i < TICKS_PER_DAY + 600; i++) tick(state);
    const save = JSON.parse(JSON.stringify(encodeSave(state, "v7")));
    save.version = 7;
    for (const p of save.state.patients) {
      delete p.endOfLife;
      delete p.death;
    }
    for (const st of save.state.staff) delete st.morale;
    for (const stats of [
      save.state.today.stats,
      ...save.state.history.map((d: { stats: object }) => d.stats),
    ]) {
      for (const k of Object.keys(NO_V8_STATS)) delete stats[k];
    }
    const loaded = decodeSave(save).state;
    expect(loaded.history[0]!.stats).toEqual({ ...state.history[0]!.stats, ...NO_V8_STATS });
    expect(Object.values(loaded.staff).every((s) => s.morale === 75)).toBe(true);
  });
});

describe("the site in saves", () => {
  it("round-trips the public road and land ownership", () => {
    const state = createSimState({ seed: 4, width: 40, height: 40, site: true });
    const loaded = roundTrip(state);
    expect(loaded.site).toEqual(state.site);
    expect(snapshot(loaded)).toEqual(snapshot(state));
  });

  it("upgrades a version-8 save as all the hospital's own land, with no road", () => {
    const state = buildSmallAE();
    const save = JSON.parse(JSON.stringify(encodeSave(state, "v8")));
    save.version = 8;
    delete save.state.site;
    for (const f of save.state.floors) delete f.land;
    const loaded = decodeSave(save).state;
    expect(loaded.site).toBeNull();
    expect(loaded.floors[0]!.land.every((l) => l === 0)).toBe(true);
    expect(snapshot(loaded)).toEqual(snapshot(state));
  });
});

describe("ambulances in saves", () => {
  it("upgrades a version-9 save's ambulances to parked or waiting where they were", () => {
    const state = staffedSmallAE(1);
    const save = JSON.parse(JSON.stringify(encodeSave(state, "v9")));
    save.version = 9;
    const space = { x: 4, y: 6, w: 3, h: 6 };
    const old = { arrived: 0, patientId: null, handedOver: null, leaveAt: null };
    save.state.ambulances = [
      { id: 1, space, ...old },
      { id: 2, space: null, ...old },
    ];
    save.state.nextAmbulanceId = 3;
    const loaded = decodeSave(save).state;
    expect(loaded.ambulances[1]).toMatchObject({ phase: "parked", x: 5, y: 9, route: [] });
    expect(loaded.ambulances[2]).toMatchObject({ phase: "arriving", space: null, x: 0, y: 0 });
  });
});

describe("old saves get the road", () => {
  it("fits the road in below a version-10 hospital, and moves waiting ambulances onto it", async () => {
    const { applyAll, SMALL_AE_COMMANDS } = await import("../fixtures/smallAE");
    const state = createSimState({ seed: 1, width: 60, height: 60, money: 1_000_000 });
    applyAll(state, SMALL_AE_COMMANDS);
    const save = JSON.parse(JSON.stringify(encodeSave(state, "v10")));
    save.version = 10;
    save.state.ambulances = [
      {
        id: 1,
        arrived: 0,
        phase: "arriving",
        space: null,
        x: 0,
        y: 0,
        prevX: 0,
        prevY: 0,
        route: [],
        routeVersion: 0,
        from: 0,
        patientId: null,
        handedOver: null,
        leaveAt: null,
      },
    ];
    save.state.nextAmbulanceId = 2;
    const loaded = decodeSave(save).state;
    expect(loaded.site?.road.y).toBe(21);
    const grid = loaded.floors[0]!;
    expect(grid.land[grid.width * 21]).toBe(1);
    expect(loaded.ambulances[1]).toMatchObject({ x: 0, y: 22 });
    expect(loaded.rooms.every((r) => r.valid)).toBe(true);
  });

  it("leaves a save that already has a road alone", () => {
    const state = createSimState({ seed: 4, width: 40, height: 40, site: true });
    const save = JSON.parse(JSON.stringify(encodeSave(state, "v10")));
    save.version = 10;
    expect(snapshot(decodeSave(save).state)).toEqual(snapshot(state));
  });
});

describe("catchment in saves", () => {
  it("upgrades a version-11 save to a small town's catchment, with no deflections", () => {
    const state = busyDayBeforeTransfers();
    const save = JSON.parse(JSON.stringify(encodeSave(state, "v11")));
    save.version = 11;
    delete save.state.settings.catchment;
    delete save.state.today.stats.deflected;
    for (const d of save.state.history) delete d.stats.deflected;
    const loaded = decodeSave(save).state;
    expect(loaded.settings.catchment).toBe(80_000);
    expect(loaded.history[0]!.stats.deflected).toBe(0);
    // Pending notifications aren't saved.
    expect(snapshot(loaded)).toEqual(snapshot({ ...state, events: [] }));
  });
});

describe("specialties in saves", () => {
  it("round-trips specialists, on-call state and ward specialties", () => {
    const state = buildMajorsAE(4, { ward: "door_double" });
    applyStaffCommand(state, { type: "hire_staff", role: "registrar", specialty: "cardiology" });
    applyStaffCommand(state, {
      type: "hire_staff",
      role: "consultant",
      specialty: "general_medicine",
      onCall: true,
    });
    setWardSpecialty(
      state,
      state.rooms.find((r) => r.typeId === "ward")!,
      "cardiology",
    );
    const loaded = roundTrip(state);
    expect(snapshot(loaded)).toEqual(snapshot({ ...state, events: [] }));
    expect(loaded.rooms.find((r) => r.typeId === "ward")!.specialty).toBe("cardiology");
  });

  it("upgrades a version-12 save with no specialties", () => {
    const state = busyDayBeforeTransfers();
    const save = JSON.parse(JSON.stringify(encodeSave(state, "v12")));
    save.version = 12;
    delete save.state.wardSpecialties;
    for (const p of save.state.patients) {
      delete p.specialty;
      delete p.times.referred;
    }
    for (const s of save.state.staff) {
      delete s.specialty;
      delete s.onCall;
    }
    for (const j of save.state.jobs) delete j.specialty;
    for (const st of [
      save.state.today.stats,
      ...save.state.history.map((d: { stats: object }) => d.stats),
    ]) {
      delete st.referrals;
      delete st.referralMins;
      delete st.outliers;
    }
    const loaded = decodeSave(save).state;
    expect(loaded.history[0]!.stats.referrals).toBe(0);
    expect(snapshot(loaded)).toEqual(snapshot({ ...state, events: [] }));
  });
});

describe("the Medical Examiner in saves", () => {
  it("upgrades a version-13 save's dedicated Medical Examiner to a consultant with the duty", () => {
    const state = buildMajorsAE(4, { ward: "door_double" });
    const r = applyStaffCommand(state, {
      type: "hire_staff",
      role: "consultant",
      specialty: "general_medicine",
    });
    if (!r.ok) throw new Error(r.error);
    applyStaffCommand(state, { type: "set_me_duty", id: r.staff.id, on: true });
    const save = JSON.parse(JSON.stringify(encodeSave(state, "v13")));
    save.version = 13;
    for (const p of save.state.patients) delete p.consultants;
    for (const s of save.state.staff) {
      delete s.meDuty;
      if (s.id === r.staff.id) Object.assign(s, { role: "medical_examiner", specialty: null });
    }
    save.state.jobs.push({
      id: 999,
      kind: "me_review",
      roles: ["medical_examiner"],
      specialty: null,
      patientId: null,
      objectId: null,
      roomType: "",
      capabilities: [],
      step: 0,
      dueTick: 0,
      durationTicks: 300,
      progress: 0,
      staffId: null,
      state: "open",
      createdTick: 0,
    });
    save.state.nextJobId = 1000;
    const loaded = decodeSave(save).state;
    expect(loaded.staff[r.staff.id]).toMatchObject({
      role: "consultant",
      specialty: "general_medicine",
      meDuty: true,
    });
    expect(loaded.jobs[999]!.roles).toEqual(["consultant"]);
    delete loaded.jobs[999];
    loaded.nextJobId = state.nextJobId;
    expect(snapshot(loaded)).toEqual(snapshot({ ...state, events: [] }));
  });
});

describe("transfers in saves", () => {
  it("round-trips a transfer under way, and upgrades a version-14 save without them", () => {
    const state = busyDayBeforeTransfers();
    const p = Object.values(state.patients)[0]!;
    p.transfer = { reason: "No working Majors Bay", decided: 5, arranged: 10, ambulanceAt: 900 };
    expect(snapshot(roundTrip(state))).toEqual(snapshot({ ...state, events: [] }));

    p.transfer = null;
    const save = JSON.parse(JSON.stringify(encodeSave(state, "v14")));
    save.version = 14;
    for (const q of save.state.patients) delete q.transfer;
    for (const d of [save.state.today, ...save.state.history]) {
      delete d.ledger.transfers;
      delete d.stats.transferWaitMins;
    }
    const loaded = decodeSave(save).state;
    expect(loaded.history[0]!.ledger.transfers).toBe(0);
    expect(loaded.history[0]!.stats.transferWaitMins).toBe(0);
    const zeroed = structuredClone({ ...state, events: [] });
    for (const d of [zeroed.today, ...zeroed.history]) {
      d.ledger.transfers = 0;
      d.stats.transferWaitMins = 0;
    }
    expect(snapshot(loaded)).toEqual(snapshot(zeroed));
  });
});

describe("diagnostics in saves", () => {
  it("round-trips tests and scans under way, and upgrades a version-15 save without them", () => {
    const state = staffedMajorsAE(3, MAJORS_TEAM);
    const underway = () => Object.values(state.patients).some((p) => p.investigations.length > 0);
    for (let i = 0; i < TICKS_PER_DAY && !underway(); i++) tick(state);
    expect(underway()).toBe(true);
    expect(snapshot(roundTrip(state))).toEqual(snapshot({ ...state, events: [] }));

    const save = JSON.parse(JSON.stringify(encodeSave(state, "v15")));
    save.version = 15;
    for (const p of save.state.patients) {
      delete p.investigations;
      delete p.homeBed;
    }
    for (const d of [save.state.today, ...save.state.history]) {
      for (const k of ["xrays", "ctScans", "doorToCtMins", "ctWithinTarget"]) delete d.stats[k];
      delete d.stats.bloodResults;
      delete d.stats.bloodResultMins;
    }
    const loaded = decodeSave(save).state;
    expect(Object.values(loaded.patients).every((p) => p.investigations.length === 0)).toBe(true);
    expect(loaded.today.stats.xrays).toBe(0);
  });
});

describe("fixtures in saves", () => {
  it("restores a fixture over a bed into the right layers", async () => {
    const { applyAll } = await import("../fixtures/smallAE");
    const state = buildSmallAE();
    // Ceiling curtains already sit in the cubicles; add a wall oxygen point too.
    applyAll(state, [
      { type: "place_object", floor: 0, defId: "oxygen_point", x: 15, y: 12, rotation: 0 },
    ]);
    const loaded = roundTrip(state);
    expect(snapshot(loaded)).toEqual(snapshot(state));
  });
});

describe("plans in saves", () => {
  it("saves and restores a plan", async () => {
    const { buildPreview, addToPlan } = await import("@sim/plan");
    const state = buildSmallAE();
    const { preview } = buildPreview(state);
    addToPlan(state, preview, {
      type: "build_floor",
      floor: 0,
      rect: { x: 19, y: 2, w: 3, h: 3 },
    });
    expect(roundTrip(state).plan).toEqual(state.plan);
  });

  it("upgrades a version-1 save (no plans) with an empty plan", () => {
    const save = JSON.parse(JSON.stringify(encodeSave(buildSmallAE(), "old")));
    save.version = 1;
    delete save.state.plan;
    for (const key of M2_FIELDS) delete save.state[key];
    const { state } = decodeSave(save);
    expect(state.plan).toEqual([]);
    expect(state.version).toBe(SIM_STATE_VERSION);
  });
});
