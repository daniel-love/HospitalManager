/**
 * What the Hospital dialog shows: department statuses, escalation and
 * policies.
 */
import type { SimState } from "@sim/state";
import { STATUS_TEXT, type Department } from "@sim/systems/departments";
import { statusPenalty } from "@sim/systems/reputation";

export interface HospitalData {
  reputation: number;
  /** Points a day off reputation's score for departments not fully open. */
  statusPenalty: number;
  departments: {
    id: Department;
    name: string;
    status: string;
    options: { id: string; label: string; effect: string }[];
    note: string | null;
  }[];
  opel: number;
}

const NAMES: Record<Department, string> = {
  ae: "A&E",
  outpatients: "Outpatients",
  theatres: "Theatres",
};

export function describeHospital(state: SimState): HospitalData {
  const ids: Department[] =
    state.funding === "private" ? ["outpatients", "theatres"] : ["ae", "outpatients", "theatres"];
  return {
    reputation: state.reputation,
    statusPenalty: statusPenalty(state),
    departments: ids.map((id) => ({
      id,
      name: NAMES[id],
      status: state.departments[id],
      options: Object.entries(STATUS_TEXT[id]).map(([k, v]) => ({ id: k, ...v })),
      note:
        id === "ae" && state.departments.ae === "divert"
          ? `${state.today.stats.diverted} ambulances sent elsewhere today.`
          : null,
    })),
    opel: 1,
  };
}
