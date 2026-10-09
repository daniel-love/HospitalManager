/**
 * Reference pages for the Help panel, built from the game data so they stay
 * in step with it: what each room needs, what each member of staff does and
 * needs, and how each condition is treated.
 */
import {
  conditionEquipment,
  content,
  equipmentNamesFor,
  roleNames,
  roomById,
  roomSections,
  specialtyById,
  staffRoleSections,
} from "@data/catalogue";
import { TRIAGE_CATEGORIES } from "@data/patients";
import type { ConditionDef, SpecialtyId, StaffRoleId } from "@data/schema";
import { formatMoney } from "@game/tools";
import { requirementLines } from "./help";

export interface GuideEntry {
  id: string;
  title: string;
  subtitle: string;
  body: string;
  sections: { heading: string; items: string[] }[];
}

export interface GuideSection {
  name: string;
  entries: GuideEntry[];
}

/**
 * What each role needs to do their job, beyond being hired: the rooms and
 * kit they work from. Duties come from the role descriptions and pathways.
 */
const ROLE_NEEDS: Partial<Record<StaffRoleId, string[]>> = {
  receptionist: ["A&E Reception with a reception desk (one receptionist per desk)"],
  nurse: [
    "A Triage Room to triage walk-ins",
    "A nurse station (or central monitor) to wait at between jobs, in sight of Majors and Resus trolleys; with every station taken, they wait at the A&E Staff Base",
  ],
  nurse_practitioner: ["Minors Cubicles", "An A&E Staff Base to wait at between patients"],
  junior_doctor: [
    "Minors Cubicles, Majors Bays or a Resus Bay to see patients in",
    "An A&E Staff Base to wait at between patients",
  ],
  porter: [
    "A Ward to take patients to",
    "A bed-width route all the way: double doors and corridors 2 tiles wide",
    "A Pathology Lab to take blood samples to",
    "A Porters' Lodge to wait in between jobs",
  ],
  radiographer: [
    "An X-ray Room or CT Room, enclosed by lead-lined walls; they wait there between patients",
  ],
  biomedical_scientist: ["A Pathology Lab with a blood analyser"],
  cleaner: [
    "A Domestic Services Room to wait in between jobs; they find dirty beds, trolleys and toilets themselves",
  ],
  registrar: [
    "Patients who need their specialty (see Conditions)",
    "A Ward to admit to, ideally one given to their specialty; they wait there between referrals",
  ],
  consultant: [
    "As for a registrar",
    "For the Medical Examiner duty: a desk, and to be resident rather than on call",
  ],
};

/** Duties that aren't treatment steps in a pathway. */
const ROLE_DUTIES: Partial<Record<StaffRoleId, string[]>> = {
  receptionist: ["Books in every walk-in"],
  nurse: [
    "Triages every patient",
    "Takes over ambulance patients from the crew",
    "Observations",
    "Supports a resuscitation",
    "Verifies expected deaths and does last offices",
  ],
  junior_doctor: [
    "Leads resuscitation at a cardiac arrest",
    "Arranges transfers to another hospital",
    "Discharges ward patients when they're ready",
    "Verifies deaths and breaks bad news to families",
  ],
  porter: [
    "Wheels admitted patients to the ward",
    "Takes blood samples to the lab",
    "Takes the deceased to the mortuary",
  ],
  biomedical_scientist: ["Books in and processes blood samples on the analyser"],
  cleaner: ["Cleans cubicles, trolleys and beds between patients", "Keeps toilets usable"],
  registrar: ["Reviews referred patients in A&E and decides to admit"],
  consultant: [
    "Reviews referred patients in A&E and decides to admit",
    "Medical Examiner reviews (with the duty)",
  ],
};

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

export function staffGuide(): GuideSection[] {
  const sections: GuideSection[] = staffRoleSections().map((sec) => ({
    name: sec.name,
    entries: sec.items.map((role) => {
      const steps = new Set<string>();
      for (const c of content.conditions) {
        for (const s of c.pathway) {
          if (s.roles.includes(role.id) && !s.specialty) steps.add(s.name);
        }
      }
      const duties = [...(ROLE_DUTIES[role.id] ?? []), ...steps];
      return {
        id: role.id,
        title: role.name,
        subtitle: `${formatMoney(role.annualCost)} a year${role.specialist ? " · hired into a specialty" : ""}`,
        body: role.description,
        sections: [
          ...(ROLE_NEEDS[role.id] ? [{ heading: "Needs", items: ROLE_NEEDS[role.id]! }] : []),
          ...(duties.length > 0 ? [{ heading: "Does", items: duties }] : []),
        ],
      };
    }),
  }));

  sections.push({
    name: "Specialties",
    entries: content.specialties.map((sp) => {
      const conds = content.conditions.filter((c) => conditionSpecialties(c).includes(sp.id));
      return {
        id: sp.id,
        title: sp.name,
        subtitle: `Consultants and registrars: ${sp.team}`,
        body: sp.description,
        sections: [
          {
            heading: "Takes",
            items: conds.length > 0 ? conds.map((c) => c.name) : ["No patients yet (coming later)"],
          },
        ],
      };
    }),
  });
  return sections;
}

function conditionSpecialties(c: ConditionDef): SpecialtyId[] {
  const out = new Set<SpecialtyId>();
  if (c.specialty && (c.admission || c.outcome === "icu")) out.add(c.specialty);
  for (const s of c.pathway) if (s.specialty) out.add(s.specialty);
  return [...out];
}

export function roomGuide(): GuideSection[] {
  return roomSections().map((sec) => ({
    name: sec.name,
    entries: sec.items.map((r) => {
      const lines = requirementLines(r).map((l) => l.text);
      const conds = content.conditions.filter((c) => c.pathway.some((s) => s.room === r.id));
      const roles = new Set<StaffRoleId>();
      for (const c of conds)
        for (const s of c.pathway) if (s.room === r.id) s.roles.forEach((x) => roles.add(x));
      if (r.id === "triage_room") roles.add("nurse");
      if (r.id === "ae_reception") roles.add("receptionist");
      const extras = conditionEquipment(r.id).map(
        (e) => `${e.items.join(" and ")}: ${e.conditions.join(", ").toLowerCase()}`,
      );
      return {
        id: r.id,
        title: r.name,
        subtitle: `${r.department} · at least ${r.minSize[0]}×${r.minSize[1]}`,
        body: r.description,
        sections: [
          { heading: "To be valid", items: lines.length > 0 ? lines : ["No requirements"] },
          ...(extras.length > 0 ? [{ heading: "For some conditions", items: extras }] : []),
          ...(conds.length > 0
            ? [{ heading: "Treats", items: [conds.map((c) => c.name).join(", ")] }]
            : []),
          ...(roles.size > 0
            ? [{ heading: "Staffed by", items: [roleNames([...roles], true)] }]
            : []),
        ],
      };
    }),
  }));
}

export function conditionGuide(): GuideSection[] {
  const byAcuity = [...content.conditions].sort((a, b) => a.acuity - b.acuity);
  // By the most acute area they need: Resus, else Majors, else Minors.
  const uses = (c: ConditionDef, room: string) => c.pathway.some((s) => s.room === room);
  const area = (c: ConditionDef) =>
    uses(c, "resus_bay") ? "Resus" : uses(c, "majors_bay") ? "Majors" : "Minors";
  const groups = ["Resus", "Majors", "Minors"].map((name) => ({
    name,
    test: (c: ConditionDef) => area(c) === name,
  }));
  return groups.map((g) => ({
    name: g.name,
    entries: byAcuity.filter(g.test).map((c) => {
      const arrives = [
        c.channels.walk_in > 0 ? "walks in" : null,
        c.channels.ambulance > 0 ? "comes by ambulance" : null,
      ].filter(Boolean);
      const outcome: string[] = [];
      if (c.outcome === "icu") outcome.push("Transferred to intensive care");
      if (c.admission) {
        const sp = specialtyById.get(c.specialty!)!.name;
        outcome.push(`${Math.round(c.admission.chance * 100)}% admitted under ${sp}`);
      }
      if (c.outcome === "discharge") outcome.push("Otherwise home");
      return {
        id: c.id,
        title: c.name,
        subtitle: `${TRIAGE_CATEGORIES[c.acuity]!.name} · ${arrives.join(" or ")} · ${formatMoney(c.tariff)}`,
        body: c.description,
        sections: [
          {
            heading: "Treatment",
            items: c.pathway.map((s) => {
              const room = roomById.get(s.room)!.name;
              const kit = s.capabilities.flatMap(equipmentNamesFor);
              const who = s.specialty
                ? `${specialtyById.get(s.specialty)!.team}, or A&E's own doctors`
                : roleNames(s.roles);
              return `${s.name}: ${who}, in a ${room}${kit.length > 0 ? ` with ${kit.join(" and ")}` : ""}`;
            }),
          },
          ...(c.monitoring !== "none" || c.deterioration
            ? [
                {
                  heading: "Watch out",
                  items: [
                    ...(c.monitoring === "continuous"
                      ? ["Needs close monitoring: keep their trolley in sight of a nurse station"]
                      : c.monitoring === "periodic"
                        ? ["Needs regular observations"]
                        : []),
                    ...(c.deterioration
                      ? [
                          `${Math.round(c.deterioration.chance * 100)}% get worse before they're treated: ${lower(
                            c.pathway.find((s) => s.stabilises)!.name,
                          )} stops it`,
                        ]
                      : []),
                  ],
                },
              ]
            : []),
          { heading: "Afterwards", items: outcome },
        ],
      };
    }),
  }));
}
