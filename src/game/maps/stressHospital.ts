/**
 * The performance stress map (ROADMAP M7 steps 1 and 2): three district
 * hospitals side by side on one site, each with a two-storey ward tower
 * reached by a bed lift (three storeys in all), sharing a catchment twice
 * each hospital's, so a few hundred patients, staff, outpatients and
 * visitors are on the map at once. Used by `npm run bench` (tests/bench) and, in the browser, to watch
 * frame times: `__game.loadState((await import('/src/game/maps/stressHospital.ts')).buildStressHospital())`.
 */
import { createSimState, type SimState } from "@sim/state";
import { buildDistrictCopies, DISTRICT_MAP, DISTRICT_PITCH } from "./districtHospital";

export const STRESS_COPIES = 3;

/** People per copy's catchment: double the district hospital's, so A&E is crowded, as in winter. */
export const STRESS_CATCHMENT = 160_000;

export function buildStressHospital(
  seed = 1,
  copies = STRESS_COPIES,
  catchment = STRESS_CATCHMENT,
): SimState {
  const state = createSimState({
    seed,
    width: DISTRICT_PITCH * (copies - 1) + DISTRICT_MAP.width,
    height: DISTRICT_MAP.height,
    rotas: true,
    catchment: catchment * copies,
    eventFrequency: "off",
    recruitment: false,
  });
  buildDistrictCopies(state, copies, { towers: true });
  return state;
}
