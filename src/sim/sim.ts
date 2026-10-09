/**
 * Advances the simulation by one fixed tick, running the systems in the
 * order given in ARCHITECTURE.md §4.2.
 */
import type { SimState } from "./state";
import { updateWards } from "./systems/admissions";
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

export function tick(state: SimState): void {
  state.tick++;
  updateArrivals(state);
  updateAmbulances(state);
  updateStaff(state);
  updatePatients(state);
  updateDeterioration(state);
  updateWards(state);
  updateDeaths(state);
  postObservations(state);
  assignJobs(state);
  moveAgents(state);
  runJobs(state);
  updateFinance(state);
  updateAlerts(state);
}
