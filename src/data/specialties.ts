/**
 * Medical specialties (GAME_DESIGN §6.1). Consultants and registrars are
 * hired into one. A specialty's team reviews A&E patients referred to it and
 * decides whether to admit them, and its patients belong on its wards.
 */
import type { SpecialtyInput } from "./schema";

export const specialties: SpecialtyInput[] = [
  {
    id: "general_medicine",
    name: "General Medicine",
    team: "the medical team",
    description:
      "The acute medical take: breathing problems, infections and sepsis, and frail older people after a fall.",
  },
  {
    id: "cardiology",
    name: "Cardiology",
    team: "the cardiology team",
    description: "Heart conditions, including chest pain that may be a heart attack.",
  },
  {
    id: "general_surgery",
    name: "General Surgery",
    team: "the surgical team",
    description: "Abdominal pain, and head injuries that need observing overnight.",
  },
  {
    id: "trauma_orthopaedics",
    name: "Trauma & Orthopaedics",
    team: "the orthopaedic team",
    description: "Broken bones. (Fractures arrive with X-ray in M4.)",
  },
  {
    id: "anaesthetics",
    name: "Anaesthetics",
    team: "the critical care team",
    description:
      "Anaesthetists and intensivists: they review the sickest patients for intensive care. (Theatres come later in M4.)",
  },
];
