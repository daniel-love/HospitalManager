/**
 * Waiting Areas kept for A&E or outpatients, standing when the seats run
 * out, and crowding wearing on A&E patients' mood.
 */
import { describe, expect, it } from "vitest";
import { WAITING_CROWD } from "@data/patients";
import { decodeSave, encodeSave } from "@save/codec";
import { seatCount } from "@sim/places";
import { crowdMoodDecay } from "@sim/systems/patients";
import { TICKS_PER_MINUTE } from "@sim/time";
import { detectRooms, setWaitingFor } from "@sim/world/rooms";
import { staffedSmallAE } from "../fixtures/smallAE";
import { run } from "./simHelpers";

const HOUR = TICKS_PER_MINUTE * 60;

describe("crowding", () => {
  it("costs nothing until the room is past comfortable", () => {
    expect(crowdMoodDecay(0, false)).toBe(0);
    expect(crowdMoodDecay(WAITING_CROWD.comfortable, true)).toBe(0);
  });

  it("gets worse with every extra person, up to a cap", () => {
    const a = crowdMoodDecay(WAITING_CROWD.comfortable + 2, false);
    const b = crowdMoodDecay(WAITING_CROWD.comfortable + 6, false);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(crowdMoodDecay(500, false)).toBe(WAITING_CROWD.max);
  });

  it("is worse standing", () => {
    const n = WAITING_CROWD.comfortable + 4;
    expect(crowdMoodDecay(n, true)).toBeGreaterThan(crowdMoodDecay(n, false));
  });
});

describe("keeping a Waiting Area for one group", () => {
  const waitingRoom = (state: ReturnType<typeof staffedSmallAE>) =>
    state.rooms.find((r) => r.typeId === "waiting_area")!;

  it("survives rooms being re-detected and a save", () => {
    const state = staffedSmallAE(3);
    setWaitingFor(state, waitingRoom(state), "outpatients");
    detectRooms(state);
    expect(waitingRoom(state).waitingFor).toBe("outpatients");
    const loaded = decodeSave(JSON.parse(JSON.stringify(encodeSave(state, "t")))).state;
    expect(waitingRoom(loaded).waitingFor).toBe("outpatients");
    setWaitingFor(state, waitingRoom(state), null);
    expect(state.waitingAreas).toEqual({});
  });

  it("keeps A&E patients out of an outpatients' area: they stand", () => {
    const state = staffedSmallAE(3);
    const room = waitingRoom(state);
    expect(seatCount(state, "ae").total).toBeGreaterThan(0);
    setWaitingFor(state, room, "outpatients");
    expect(seatCount(state, "ae").total).toBe(0);
    expect(seatCount(state, "outpatients").total).toBeGreaterThan(0);

    let waiting = 0;
    let seated = 0;
    run(state, 6 * HOUR, (s) => {
      for (const p of Object.values(s.patients)) {
        if (!p.stage.startsWith("waiting") || p.toilet) continue;
        waiting++;
        if (p.seat) seated++;
      }
    });
    expect(waiting).toBeGreaterThan(0);
    expect(seated).toBe(0);
  });

  it("seats A&E patients in an area kept for them", () => {
    const state = staffedSmallAE(3);
    setWaitingFor(state, waitingRoom(state), "ae");
    let seated = 0;
    run(state, 6 * HOUR, (s) => {
      for (const p of Object.values(s.patients)) if (p.seat) seated++;
    });
    expect(seated).toBeGreaterThan(0);
  });
});
