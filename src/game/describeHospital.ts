/**
 * What the Hospital dialog shows: department statuses, escalation,
 * policies and performance (game/kpis.ts).
 */
import { content } from "@data/catalogue";
import { PRIVATE, REPUTATION } from "@data/economy";
import { FLU_VACCINATION } from "@data/pressure";
import { NOROVIRUS } from "@data/infection";
import type { SpecialtyId } from "@data/schema";
import type { GapFill, SimState, Visiting } from "@sim/state";
import { STATUS_TEXT, type Department } from "@sim/systems/departments";
import { escalationBeds, opel, patientsInEscalation } from "@sim/systems/escalation";
import { holder } from "@sim/places";
import { statusPenalty } from "@sim/systems/reputation";
import { VISITING } from "@sim/systems/visitors";
import { dateOf, firstDayOf, monthName } from "@sim/time";
import { describeEvents, type EventsData } from "./describeEvents";
import { KPIS, type KpiSection, type Rag } from "./kpis";

/** Months of KPIs shown: this month so far and the ones before. */
const PERFORMANCE_MONTHS = 4;

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
    fluVaccination: boolean;
    fluVaccinationCost: number;
    infectionControl: boolean;
    infectionControlCost: number;
    outbreakClosures: "ipc" | "manual";
  };
  events: EventsData;
  performance: {
    /** This month so far first, then earlier months. */
    months: { name: string; days: number }[];
    rows: {
      id: string;
      section: KpiSection;
      label: string;
      standard: string;
      title: string;
      cells: { text: string; rag: Rag }[];
    }[];
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
      fluVaccination: state.policies.fluVaccination,
      fluVaccinationCost: FLU_VACCINATION.costPerHead,
      infectionControl: state.policies.infectionControl,
      infectionControlCost: NOROVIRUS.enhancedCostPerBedDay,
      outbreakClosures: state.policies.outbreakClosures,
    },
    events: describeEvents(state),
    performance: performance(state),
  };
}

/** The KPIs for this month so far and the months before, rated against their standards. */
function performance(state: SimState): HospitalData["performance"] {
  const months = [state.month, ...state.months.slice(-(PERFORMANCE_MONTHS - 1)).reverse()];
  const ae = state.funding !== "private";
  return {
    months: months.map((m) => ({
      name: monthName(dateOf(firstDayOf(m.monthIndex))),
      days: m.days,
    })),
    rows: KPIS.filter((k) => ae || !k.ae).map((k) => ({
      id: k.id,
      section: k.section,
      label: k.label,
      standard: k.standard,
      title: k.title,
      cells: months.map((m) => {
        const v = m.days === 0 ? null : k.value(m);
        return v === null ? { text: "—", rag: "none" } : { text: k.format(v), rag: k.rate(v) };
      }),
    })),
  };
}
