/**
 * Medical specialties (GAME_DESIGN §6.1). Consultants and registrars are
 * hired into one. A specialty's team reviews A&E patients referred to it and
 * decides whether to admit them, and its patients belong on its wards.
 *
 * `outpatients` is the specialty's clinic service (M4 step 6). Referral rates
 * come from England's first outpatient attendances by specialty (about 0.75
 * of them from GPs), follow-up chances from the national follow-up ratios
 * (ophthalmology about 3 per first appointment, ENT about 1), and tariffs are
 * rough 2025/26 UK prices for consultant-led attendances.
 *
 * `surgery` is what its clinics list patients for (M4 step 7): day-case
 * shares from UK day surgery rates (the British Association of Day
 * Surgery's targets), lengths of stay with enhanced recovery, and tariffs for
 * the whole spell (a hip replacement about £6,000, a cataract under £1,000).
 */
import type { SpecialtyInput } from "./schema";

export const specialties: SpecialtyInput[] = [
  {
    id: "general_medicine",
    name: "General Medicine",
    team: "the medical team",
    outpatients: {
      referralsPer100k: 1.1,
      urgentShare: 0.05,
      firstSlotMins: 30,
      followUpSlotMins: 15,
      followUpChance: 0.6,
      followUpWeeks: [8, 16],
      surgeryChance: 0,
      firstTariff: 260,
      followUpTariff: 130,
    },
    description:
      "The acute medical take: breathing problems, infections and sepsis, and frail older people after a fall.",
  },
  {
    id: "cardiology",
    name: "Cardiology",
    team: "the cardiology team",
    outpatients: {
      referralsPer100k: 2.6,
      urgentShare: 0.03,
      firstSlotMins: 30,
      followUpSlotMins: 15,
      followUpChance: 0.64,
      followUpWeeks: [6, 12],
      surgeryChance: 0.05,
      firstTariff: 210,
      followUpTariff: 110,
    },
    surgery: {
      dayCaseShare: 0.6,
      opMins: [45, 90],
      stayDays: [1, 2],
      dayCaseTariff: 1600,
      inpatientTariff: 3200,
      examples: "pacemaker implants (angioplasty needs a cath lab, which comes later)",
    },
    description: "Heart conditions, including chest pain that may be a heart attack.",
  },
  {
    id: "general_surgery",
    name: "General Surgery",
    team: "the surgical team",
    outpatients: {
      referralsPer100k: 3.6,
      urgentShare: 0.15,
      firstSlotMins: 20,
      followUpSlotMins: 15,
      followUpChance: 0.45,
      followUpWeeks: [6, 12],
      surgeryChance: 0.2,
      firstTariff: 165,
      followUpTariff: 100,
    },
    surgery: {
      dayCaseShare: 0.65,
      opMins: [45, 120],
      stayDays: [1, 4],
      dayCaseTariff: 1300,
      inpatientTariff: 3500,
      examples:
        "hernia repairs and gallbladder removals, most as day cases; bowel surgery as inpatients",
    },
    description: "Abdominal pain, and head injuries that need observing overnight.",
  },
  {
    id: "trauma_orthopaedics",
    name: "Trauma & Orthopaedics",
    team: "the orthopaedic team",
    outpatients: {
      referralsPer100k: 7,
      urgentShare: 0.02,
      firstSlotMins: 20,
      followUpSlotMins: 15,
      followUpChance: 0.6,
      followUpWeeks: [6, 12],
      surgeryChance: 0.15,
      firstTariff: 170,
      followUpTariff: 95,
    },
    surgery: {
      dayCaseShare: 0.45,
      opMins: [60, 150],
      stayDays: [2, 4],
      dayCaseTariff: 1500,
      inpatientTariff: 6200,
      examples:
        "hip and knee replacements (a few days on a ward), and knee arthroscopies and hand surgery as day cases",
    },
    description:
      "Broken bones from A&E, and in clinic, joint and back problems referred by GPs: hips and knees that may need replacing.",
  },
  {
    id: "anaesthetics",
    name: "Anaesthetics",
    team: "the critical care team",
    description:
      "Anaesthetists and intensivists: they review the sickest patients for intensive care. (Theatres come later in M4.)",
  },
  {
    id: "dermatology",
    name: "Dermatology",
    team: "the dermatology team",
    outpatients: {
      referralsPer100k: 3.6,
      urgentShare: 0.25,
      firstSlotMins: 20,
      followUpSlotMins: 10,
      followUpChance: 0.6,
      followUpWeeks: [8, 16],
      surgeryChance: 0.05,
      firstTariff: 140,
      followUpTariff: 90,
    },
    surgery: {
      dayCaseShare: 1,
      opMins: [20, 45],
      stayDays: [1, 1],
      dayCaseTariff: 600,
      inpatientTariff: 1200,
      examples: "skin cancer excisions, all day cases",
    },
    description:
      "Skin conditions, almost all seen in clinic: eczema, psoriasis, and moles or lesions that might be skin cancer, which are referred urgently.",
  },
  {
    id: "ent",
    name: "ENT",
    team: "the ENT team",
    outpatients: {
      referralsPer100k: 4,
      urgentShare: 0.08,
      firstSlotMins: 20,
      followUpSlotMins: 15,
      followUpChance: 0.5,
      followUpWeeks: [6, 12],
      surgeryChance: 0.12,
      firstTariff: 145,
      followUpTariff: 95,
    },
    surgery: {
      dayCaseShare: 0.7,
      opMins: [30, 90],
      stayDays: [1, 2],
      dayCaseTariff: 1100,
      inpatientTariff: 2400,
      examples: "tonsillectomies, sinus and ear operations",
    },
    description:
      "Ear, nose and throat: hearing loss, sinus problems, tonsils, and lumps in the neck. Mostly clinic work, with some day surgery.",
  },
  {
    id: "ophthalmology",
    name: "Ophthalmology",
    team: "the eye team",
    outpatients: {
      referralsPer100k: 5.5,
      urgentShare: 0.02,
      firstSlotMins: 20,
      followUpSlotMins: 10,
      followUpChance: 0.75,
      followUpWeeks: [8, 20],
      surgeryChance: 0.15,
      firstTariff: 155,
      followUpTariff: 80,
    },
    surgery: {
      dayCaseShare: 0.98,
      opMins: [20, 40],
      stayDays: [1, 1],
      dayCaseTariff: 950,
      inpatientTariff: 2000,
      examples: "cataract operations, almost all day cases",
    },
    description:
      "Eyes: cataracts (the commonest operation in the PHS), glaucoma and macular degeneration, which need many follow-up visits.",
  },
];
