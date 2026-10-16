/**
 * Advances the simulation by one fixed tick, running the systems in the
 * order given in ARCHITECTURE.md §4.2.
 */
import type { SimState } from "./state";
import { updateWards } from "./systems/admissions";
import { updateCollections } from "./systems/collections";
import { updateDeaths } from "./systems/deaths";
import { updateAlerts } from "./systems/alerts";
import { updateAmbulances } from "./systems/ambulances";
import { updateArrivals } from "./systems/arrivals";
import { updateFinance } from "./systems/finance";
import { updateDeterioration } from "./systems/deterioration";
import { assignJobs, runJobs } from "./systems/jobs";
import { postObservations } from "./systems/monitoring";
import { moveAgents } from "./systems/movement";
import { updatePatients } from "./systems/patients";
import { updateStaff } from "./systems/staffing";
import { updateTransfers } from "./systems/transfers";
import { updateReferrals } from "./systems/referrals";
import { updateOutpatients } from "./systems/outpatients";
import { updateTheatres } from "./systems/theatres";
import { updateWorkforce } from "./systems/workforce";
import { updateVisitors } from "./systems/visitors";
import { updatePressure } from "./systems/pressure";
import { updateMajorIncident } from "./systems/majorIncident";
import { updateDischarges } from "./systems/discharge";
import { updateOutbreaks } from "./systems/outbreaks";
import { updateMaintenance } from "./systems/maintenance";
import { updateInspections } from "./systems/inspections";
import { updateRecruitment } from "./systems/recruitment";
import { updateScenarios } from "./systems/scenarios";

/** The systems in tick order, by name (the benchmark times each one). */
export const SYSTEMS: readonly (readonly [string, (state: SimState) => void])[] = [
  ["updatePressure", updatePressure],
  ["updateMajorIncident", updateMajorIncident],
  ["updateArrivals", updateArrivals],
  ["updateReferrals", updateReferrals],
  ["updateAmbulances", updateAmbulances],
  ["updateStaff", updateStaff],
  ["updatePatients", updatePatients],
  ["updateOutpatients", updateOutpatients],
  ["updateVisitors", updateVisitors],
  ["updateTheatres", updateTheatres],
  ["updateTransfers", updateTransfers],
  ["updateDeterioration", updateDeterioration],
  ["updateWards", updateWards],
  ["updateDischarges", updateDischarges],
  ["updateOutbreaks", updateOutbreaks],
  ["updateMaintenance", updateMaintenance],
  ["updateInspections", updateInspections],
  ["updateRecruitment", updateRecruitment],
  ["updateScenarios", updateScenarios],
  ["updateDeaths", updateDeaths],
  ["updateCollections", updateCollections],
  ["postObservations", postObservations],
  ["assignJobs", assignJobs],
  ["moveAgents", moveAgents],
  ["runJobs", runJobs],
  ["updateWorkforce", updateWorkforce],
  ["updateFinance", updateFinance],
  ["updateAlerts", updateAlerts],
];

export function tick(state: SimState): void {
  state.tick++;
  for (const [, run] of SYSTEMS) run(state);
}

/**
 * A tick that adds each system's time in milliseconds to `ms`, by name
 * (tests/bench). Same order and effects as tick().
 */
export function profiledTick(state: SimState, ms: Record<string, number>): void {
  state.tick++;
  for (const [name, run] of SYSTEMS) {
    const t0 = performance.now();
    run(state);
    ms[name] = (ms[name] ?? 0) + performance.now() - t0;
  }
}
