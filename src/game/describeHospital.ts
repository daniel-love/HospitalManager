/**
 * What the Hospital dialog shows: department statuses, escalation and
 * policies.
 */
import { content } from "@data/catalogue";
import { PRIVATE, REPUTATION } from "@data/economy";
import type { SpecialtyId } from "@data/schema";
import type { GapFill, SimState, Visiting } from "@sim/state";
import { STATUS_TEXT, type Department } from "@sim/systems/departments";
import { escalationBeds, opel, patientsInEscalation } from "@sim/systems/escalation";
import { holder } from "@sim/places";
import { statusPenalty } from "@sim/systems/reputation";
import { VISITING } from "@sim/systems/visitors";

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
  opel: { level: number; drivers: string[] };
  escalation: {
    open: boolean;
    trolleys: number;
    inUse: number;
    patients: number;
    reputationPerPatient: number;
  };
  policies: {
    funding: SimState["funding"];
    gapFill: GapFill;
    dischargeBeforeNoon: boolean;
    visiting: Visiting;
    visitingOptions: { id: Visiting; label: string }[];
    priceLevel: number;
    priceLevels: readonly [number, number];
    priceElasticity: number;
    nhsReferrals: { id: SpecialtyId; name: string; on: boolean }[];
  };
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
    opel: opel(state),
    escalation: {
      open: state.policies.escalation,
      trolleys: escalationBeds(state).length,
      inUse: escalationBeds(state).filter((o) => holder(state, o.id, 0) !== undefined).length,
      patients: patientsInEscalation(state),
      reputationPerPatient: REPUTATION.corridorCare,
    },
    policies: {
      funding: state.funding,
      gapFill: state.policies.gapFill,
      dischargeBeforeNoon: state.policies.dischargeBeforeNoon,
      visiting: state.policies.visiting,
      visitingOptions: (Object.keys(VISITING) as Visiting[]).map((id) => ({
        id,
        label: VISITING[id].label,
      })),
      priceLevel: state.policies.priceLevel,
      priceLevels: PRIVATE.priceLevels,
      priceElasticity: PRIVATE.priceElasticity,
      nhsReferrals: content.specialties
        .filter((sp) => sp.outpatients)
        .map((sp) => ({ id: sp.id, name: sp.name, on: !!state.policies.nhsReferrals[sp.id] })),
    },
  };
}
