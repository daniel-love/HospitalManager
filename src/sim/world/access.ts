/**
 * Where patients may walk. Hospitals route the public through corridors,
 * waiting areas and reception; clinical and staff rooms (Resus, a ward, the
 * mortuary, the ambulance bay) are entered only by those who belong there.
 * So a patient's route may cross a room that isn't a public route only if
 * it's where they're starting or where they're going, and never uses a door
 * from such a room straight outside: someone discharged from Resus leaves
 * through the department, not by its back door. Staff, and patients wheeled
 * on beds, aren't restricted.
 */
import { roomByCode } from "@data/catalogue";
import type { SimState } from "../state";
import { FloorType, tileIndex } from "./grid";

/** Open to patients. */
export const OPEN = 0;
/** In a room that isn't a public route: only for those starting or ending there. */
export const PRIVATE = 1;
/** A door from such a room straight outside: never for patients. */
export const BACK_DOOR = 2;

const cache = new WeakMap<SimState, { version: number; access: Uint8Array }>();

/** Patient access for each ground-floor tile (OPEN, PRIVATE or BACK_DOOR), cached per layout. */
export function patientAccess(state: SimState): Uint8Array {
  const cached = cache.get(state);
  if (cached && cached.version === state.layoutVersion) return cached.access;
  const grid = state.floors[0]!;
  const { width, height } = grid;
  const access = new Uint8Array(width * height);
  const isPrivate = (i: number) => {
    const code = grid.zone[i]!;
    return code !== 0 && !(roomByCode.get(code)?.publicRoute ?? false);
  };
  const outside = (i: number) => grid.floorType[i] !== FloorType.Floor && grid.roomId[i] === 0;
  for (let i = 0; i < access.length; i++) {
    if (isPrivate(i)) access[i] = PRIVATE;
  }
  for (let i = 0; i < access.length; i++) {
    if (grid.door[i] === 0) continue;
    const x = i % width;
    const y = (i - x) / width;
    let privateSide = false;
    let outsideSide = false;
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const n = tileIndex(grid, nx, ny);
      if (isPrivate(n)) privateSide = true;
      else if (outside(n)) outsideSide = true;
    }
    if (privateSide && outsideSide) access[i] = BACK_DOOR;
  }
  cache.set(state, { version: state.layoutVersion, access });
  return access;
}
