/**
 * Save file encoding (ARCHITECTURE §8).
 *
 * A save is plain JSON: { format, version, meta, state }. Typed arrays are
 * stored as base64, and id-keyed records (objects, patients, staff, jobs,
 * ambulances) as
 * arrays. Derived data (rooms, the roomId, objectId and mountId grids) is not
 * saved, nor are pending notifications; it is rebuilt on load so it can never disagree with the layout.
 * Loading runs migrations for older versions and then validates with Zod, so
 * a corrupt or hand-edited file fails with a readable message.
 */
import { z } from "zod";
import { conditionById, objectDef } from "@data/catalogue";
import { PRIVATE } from "@data/economy";
import { KEY_QUESTIONS, RATINGS, type KeyQuestion } from "@data/csi";
import { SCENARIOS, type ScenarioId } from "@data/scenarios";
import { PRESSURE_EVENTS, type PressureEventId } from "@data/pressure";
import { specialtyIds, staffRoleIds } from "@data/schema";
import { SERVICE_LINES, type ServiceLine } from "@sim/agents";
import { SIM_STATE_VERSION, WAITING_FOR, type PlacedObject, type SimState } from "@sim/state";
import { clockFromTick, formatClock } from "@sim/time";
import { createFloorGrid, tileIndex, type FloorGrid } from "@sim/world/grid";
import { layerOf, objectRect } from "@sim/world/objects";
import { detectRooms } from "@sim/world/rooms";
import { fromBase64, toBase64 } from "./base64";
import { migrate } from "./migrations";

export const SAVE_FORMAT = "hospital-save";

export interface SaveMeta {
  name: string;
  /** ISO timestamp. */
  savedAt: string;
  /** In-game time, e.g. "Day 3  14:20". */
  gameTime: string;
  money: number;
}

export class SaveError extends Error {}

const u32 = z.number().int().min(0).max(0xffffffff);

const floorSchema = z.object({
  width: z.number().int().positive().max(1000),
  height: z.number().int().positive().max(1000),
  floorType: z.string(),
  wall: z.string(),
  door: z.string(),
  land: z.string(),
  zone: z.string(),
});

const objectSchema = z.object({
  id: z.number().int().positive(),
  defId: z.string(),
  floor: z.number().int().min(0),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  rotation: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
});

const int = z.number().int();
const rectSchema = z.object({ x: int, y: int, w: int.min(0), h: int.min(0) });
const rotationSchema = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const floorIndex = int.min(0);
const pointSchema = z.object({ x: int, y: int, floor: floorIndex.optional() });

const siteSchema = z.object({
  road: rectSchema,
  pavements: z.tuple([rectSchema, rectSchema]),
  busStop: pointSchema,
});

/** Every build command, as stored in a saved plan. */
const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("build_floor"), floor: floorIndex, rect: rectSchema }),
  z.object({
    type: z.literal("pave"),
    floor: floorIndex,
    rect: rectSchema,
    surface: z.enum(["path", "road"]),
  }),
  z.object({ type: z.literal("remove_floor"), floor: floorIndex, rect: rectSchema }),
  z.object({
    type: z.literal("build_walls"),
    floor: floorIndex,
    rect: rectSchema,
    wall: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  }),
  z.object({ type: z.literal("demolish"), floor: floorIndex, rect: rectSchema }),
  z.object({
    type: z.literal("zone"),
    floor: floorIndex,
    rect: rectSchema,
    roomType: z.string().nullable(),
  }),
  z.object({
    type: z.literal("place_object"),
    floor: floorIndex,
    defId: z.string(),
    x: int,
    y: int,
    rotation: rotationSchema,
  }),
  z.object({ type: z.literal("remove_objects"), floor: floorIndex, rect: rectSchema }),
  z.object({ type: z.literal("remove_object"), floor: floorIndex, id: int.positive() }),
  z.object({
    type: z.literal("move_object"),
    floor: floorIndex,
    id: int.positive(),
    x: int,
    y: int,
    rotation: rotationSchema,
  }),
]);

const num = z.number().finite();
const nullableInt = int.nullable();
const payerSchema = z.enum(["phs", "insured", "self_pay"]);

const agentFields = {
  id: int.positive(),
  name: z.string(),
  x: num,
  y: num,
  floor: floorIndex,
  prevX: num,
  prevY: num,
  path: z.array(num).refine((p) => p.length % 2 === 0, "path must be x, y pairs"),
  dest: z
    .object({ x: num, y: num, floor: floorIndex.optional(), ax: int, ay: int, blocked: int })
    .nullable(),
  pathVersion: int.min(0),
};

const tourSchema = z.object({
  ...agentFields,
  kind: z.enum(["inspector", "vip"]),
  rooms: z.array(z.string()),
  until: nullableInt,
  stage: z.enum(["touring", "leaving"]),
});
const rating = z.enum(RATINGS);
const findingSchema = z.object({
  question: z.enum(KEY_QUESTIONS),
  good: z.boolean(),
  text: z.string(),
});
const reportSchema = z.object({
  visited: int,
  published: int,
  overall: rating,
  questions: z.object(
    Object.fromEntries(
      KEY_QUESTIONS.map((q) => [
        q,
        z.object({ rating, score: num, evidence: z.array(z.string()) }),
      ]),
    ) as Record<
      KeyQuestion,
      z.ZodObject<{ rating: typeof rating; score: typeof num; evidence: z.ZodArray<z.ZodString> }>
    >,
  ),
  findings: z.array(findingSchema),
});

const patientSchema = z.object({
  ...agentFields,
  conditionId: z.string().refine((id) => conditionById.has(id), "unknown condition"),
  category: int.min(0).max(5),
  stage: z.enum([
    "awaiting_handover",
    "queueing",
    "booking",
    "waiting_triage",
    "called_triage",
    "triage",
    "waiting_treatment",
    "called_treatment",
    "in_cubicle",
    "collapsed",
    "awaiting_bed",
    "transferring",
    "on_ward",
    "deceased",
    "to_mortuary",
    "in_mortuary",
    "with_funeral_director",
    "pre_op",
    "to_theatre",
    "in_theatre",
    "in_recovery",
    "post_op",
    "discharge_lounge",
    "leaving",
  ]),
  step: int.min(0),
  seat: z.object({ objectId: int.positive(), slot: int.min(0) }).nullable(),
  standing: z.object({ x: num, y: num, floor: floorIndex.optional() }).nullable(),
  bed: nullableInt,
  desk: nullableInt,
  bookingLeft: int,
  toilet: z.object({ objectId: int.positive(), left: int }).nullable(),
  ambulanceId: nullableInt,
  deterioration: z.object({ onset: int, crash: int, noticed: nullableInt }).nullable(),
  obs: z.object({ tick: int, news: int.min(0) }).nullable(),
  mood: num,
  bladder: num,
  bladderRate: num,
  times: z.object({
    arrived: int,
    booked: nullableInt,
    triaged: nullableInt,
    seen: nullableInt,
    referred: nullableInt,
    decided: nullableInt,
    admitted: nullableInt,
    rounded: nullableInt,
    left: nullableInt,
  }),
  consultants: z.array(int.positive()),
  specialty: z.enum(specialtyIds).nullable(),
  stayUntil: nullableInt,
  discharge: z
    .object({
      needsCare: z.boolean(),
      careHours: num.min(0),
      planned: nullableInt,
      careReady: nullableInt,
      fit: nullableInt,
      goAt: nullableInt,
    })
    .nullable(),
  infection: z
    .object({ caught: int, symptoms: int, clears: int, acquired: z.boolean() })
    .nullable(),
  endOfLife: z.boolean(),
  curtainUntil: nullableInt,
  transfer: z
    .object({
      reason: z.string(),
      decided: int,
      arranged: nullableInt,
      ambulanceAt: nullableInt,
    })
    .nullable(),
  death: z
    .object({
      tick: int,
      expected: z.boolean(),
      where: z.string(),
      verified: nullableInt,
      familyTold: nullableInt,
      lastOffices: nullableInt,
      transfer: z
        .object({
          started: int,
          from: pointSchema,
          seenBy: z.array(int.positive()),
        })
        .nullable(),
      inMortuary: nullableInt,
      fridge: z.object({ objectId: int.positive(), slot: int.min(0) }).nullable(),
      meReviewed: nullableInt,
      coroner: z.boolean(),
      releaseAt: nullableInt,
    })
    .nullable(),
  investigations: z.array(
    z.object({
      test: z.enum(["bloods", "xray", "ct"]),
      requested: int,
      done: nullableInt,
      ready: nullableInt,
    }),
  ),
  homeBed: nullableInt,
  elective: z
    .object({
      referralId: int.positive(),
      payer: payerSchema,
      dayCase: z.boolean(),
      checked: z.boolean(),
      wardBed: nullableInt,
    })
    .nullable(),
  emergencyOp: z
    .object({
      specialty: z.enum(specialtyIds),
      due: int,
      from: z.enum(["ae", "ward"]).nullable(),
      done: z.boolean(),
    })
    .nullable(),
  retriaged: z.object({ tick: int, from: int.min(1).max(5) }).nullable(),
  lastVisit: nullableInt,
  outcome: z.enum(["discharged", "lwbs", "transferred", "transferred_out", "died"]).nullable(),
});

const staffSchema = z.object({
  ...agentFields,
  role: z.enum(staffRoleIds),
  specialty: z.enum(specialtyIds).nullable(),
  contract: z.enum(["resident", "on_call", "bank", "agency", "privileges"]),
  band: z.union([z.literal(5), z.literal(6), z.literal(7)]).nullable(),
  skill: num.min(0).max(100),
  fatigue: num.min(0).max(100),
  sickUntil: nullableInt,
  leavesAt: nullableInt,
  shiftLoad: z.object({ mins: num.min(0), busy: num.min(0), short: z.boolean() }).nullable(),
  onCall: z
    .object({ state: z.enum(["home", "called", "in", "leaving"]), at: int.min(0) })
    .nullable(),
  duty: z.enum(["on", "leaving", "off"]),
  shiftEnd: nullableInt,
  meDuty: z.boolean(),
  clinicSessions: int.min(0),
  theatreSessions: int.min(0),
  privateClinicSessions: int.min(0),
  privateTheatreSessions: int.min(0),
  jobId: nullableInt,
  desk: nullableInt,
  hiredTick: int.min(0),
  lastActiveTick: int.min(0),
  morale: num.min(0).max(100),
});

const jobSchema = z.object({
  id: int.positive(),
  kind: z.enum([
    "carry_sample",
    "lab_test",
    "arrange_transfer",
    "referral",
    "transfer",
    "ward_discharge",
    "ward_round",
    "handover",
    "triage",
    "treat",
    "obs",
    "commode",
    "resus",
    "clean_cubicle",
    "clean_toilet",
    "verify_death",
    "break_news",
    "last_offices",
    "to_mortuary",
    "me_review",
    "release_body",
    "pre_op_check",
    "recovery",
    "discharge_planning",
    "isolate",
    "repair",
    "maintain",
    "return_kit",
    "escort",
    "debrief",
  ]),
  roles: z.array(z.enum(staffRoleIds)).min(1),
  specialty: z.enum(specialtyIds).nullable(),
  patientId: nullableInt,
  objectId: nullableInt,
  roomType: z.string(),
  capabilities: z.array(z.string()),
  step: int.min(0),
  dueTick: int,
  durationTicks: int.positive(),
  progress: num.min(0),
  staffId: nullableInt,
  state: z.enum(["open", "assigned", "working"]),
  createdTick: int.min(0),
  kit: z.object({ objectId: int.positive(), at: z.enum(["store", "staff", "patient"]) }).nullable(),
});

const spaceSchema = z.object({ x: int, y: int, w: int.positive(), h: int.positive() });
const ambulanceSchema = z.object({
  id: int.positive(),
  arrived: int.min(0),
  phase: z.enum(["arriving", "parked", "leaving"]),
  space: spaceSchema.nullable(),
  x: num,
  y: num,
  prevX: num,
  prevY: num,
  route: z.array(int),
  routeVersion: int.min(0),
  from: z.union([z.literal(0), z.literal(1)]),
  patientId: nullableInt,
  conditionId: z.string().nullable(),
  handedOver: nullableInt,
  leaveAt: nullableInt,
});

const collectionSchema = z.object({
  id: int.positive(),
  patientId: int.positive(),
  phase: z.enum(["arriving", "to_mortuary", "releasing", "to_vehicle", "loading", "leaving"]),
  vehicle: z
    .object({
      x: num,
      y: num,
      prevX: num,
      prevY: num,
      route: z.array(int),
      routeVersion: int.min(0),
      from: z.union([z.literal(0), z.literal(1)]),
      stop: pointSchema,
    })
    .nullable(),
  crew: z.object(agentFields),
  leaveAt: nullableInt,
});

const pressureEventId = z.enum(
  PRESSURE_EVENTS.map((e) => e.id) as [PressureEventId, ...PressureEventId[]],
);
const ledgerSchema = z.object({
  block: num,
  tariff: num,
  elective: num,
  outpatients: num,
  private: num,
  salaries: num,
  bank: num,
  agency: num,
  upkeep: num,
  supplies: num,
  estates: num,
  interest: num,
  transfers: num,
});
const monthSchemaFields = {
  monthIndex: int.min(0),
  days: int.min(0),
  openingCash: num,
  closingCash: num,
  flows: z.object({
    building: num,
    borrowed: num,
    repaid: num,
    grants: num,
    clawedBack: num,
  }),
};
const grantSchema = z.object({
  defId: z.string(),
  offered: int,
  until: int,
  target: nullableInt,
});
const statsSchema = z.object({
  arrivals: int.min(0),
  discharged: int.min(0),
  lwbs: int.min(0),
  transferred: int.min(0),
  incidents: int.min(0),
  ambulances: int.min(0),
  deflected: int.min(0),
  diverted: int.min(0),
  handovers: int.min(0),
  handoverMins: num,
  handoversOver30: int.min(0),
  handoversOver60: int.min(0),
  admissions: int.min(0),
  bedWaitMins: num,
  bedWaitsOver4h: int.min(0),
  bedWaitsOver12h: int.min(0),
  wardDischarges: int.min(0),
  referrals: int.min(0),
  referralMins: num,
  outliers: int.min(0),
  transfersOut: int.min(0),
  transferWaitMins: num,
  xrays: int.min(0),
  ctScans: int.min(0),
  doorToCtMins: num,
  ctWithinTarget: int.min(0),
  bloodResults: int.min(0),
  bloodResultMins: num,
  deaths: int.min(0),
  unexpectedDeaths: int.min(0),
  complaints: int.min(0),
  mortuaryTransfers: int.min(0),
  mortuaryTransferMins: num,
  transfersSeen: int.min(0),
  within4h: int.min(0),
  departures: int.min(0),
  triaged: int.min(0),
  triageWaitMins: num,
  timeInDeptMins: num,
  gpReferrals: int.min(0),
  firstAppointments: int.min(0),
  followUps: int.min(0),
  dnas: int.min(0),
  clinicCancellations: int.min(0),
  urgentSeen: int.min(0),
  urgentWithin2w: int.min(0),
  listedForSurgery: int.min(0),
  electiveOps: int.min(0),
  dayCases: int.min(0),
  cancelledOnDay: int.min(0),
  emergencyOps: int.min(0),
  emergencyOnTime: int.min(0),
  bumped: int.min(0),
  privateReferrals: int.min(0),
  privateSeen: int.min(0),
  privateOps: int.min(0),
  bedHours: num,
  occupiedBedHours: num,
  stayMins: num,
  shifts: int.min(0),
  sickShifts: int.min(0),
  unfilledShifts: int.min(0),
  resignations: int.min(0),
  corridorNights: int.min(0),
  delayedBedHours: int.min(0),
  hospitalInfections: int.min(0),
  closedBedHours: int.min(0),
});
const servicesSchema = z.object(
  Object.fromEntries(SERVICE_LINES.map((l) => [l, ledgerSchema])) as Record<
    ServiceLine,
    typeof ledgerSchema
  >,
);
const monthSchema = z.object({
  ...monthSchemaFields,
  ledger: ledgerSchema,
  stats: statsSchema,
  services: servicesSchema,
  end: z.object({
    reputation: num.min(0).max(100),
    rttWaiting: int.min(0),
    rttWithin18w: int.min(0),
    headcount: int.min(0),
  }),
});

const operationSchema = z.object({
  id: int.positive(),
  patientId: int.positive(),
  table: int.positive(),
  surgeonId: int.positive(),
  anaesthetistId: int.positive(),
  practitionerIds: z.array(int.positive()),
  phase: z.enum(["gathering", "operating", "to_recovery"]),
  left: int,
  recoveryBed: nullableInt,
  emergency: z.boolean(),
});

const outpatientSchema = z.object({
  ...agentFields,
  referralId: int.positive(),
  specialty: z.enum(specialtyIds),
  stage: z.enum(["arriving", "booking", "waiting", "called", "in_clinic", "leaving"]),
  seat: z.object({ objectId: int.positive(), slot: int.min(0) }).nullable(),
  desk: nullableInt,
  left: int,
  appointment: int,
  staffId: int.positive(),
  bookedIn: nullableInt,
  seen: nullableInt,
});

const visitorSchema = z.object({
  ...agentFields,
  patientId: int.positive(),
  stage: z.enum(["arriving", "visiting", "leaving"]),
  until: int,
});

const referralSchema = z.object({
  id: int.positive(),
  name: z.string(),
  specialty: z.enum(specialtyIds),
  payer: payerSchema,
  kind: z.enum(["first", "follow_up", "surgery"]),
  urgent: z.boolean(),
  clockStart: nullableInt,
  added: int,
  due: nullableInt,
  dnas: int.min(0),
  dayCase: z.boolean(),
  rebookBy: nullableInt,
  booking: z
    .object({
      day: int.positive(),
      half: z.enum(["am", "pm"]),
      staffId: int.positive(),
      at: int,
      mins: int.positive(),
    })
    .nullable(),
});

const saveSchema = z.object({
  format: z.literal(SAVE_FORMAT),
  version: z.literal(SIM_STATE_VERSION),
  meta: z.object({
    name: z.string(),
    savedAt: z.string(),
    gameTime: z.string(),
    money: z.number(),
  }),
  state: z.object({
    seed: u32,
    rng: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]),
    tick: z.number().int().min(0),
    money: z.number().finite(),
    floors: z.array(floorSchema).min(1),
    site: siteSchema.nullable(),
    objects: z.array(objectSchema),
    nextObjectId: z.number().int().positive(),
    plan: z.array(z.object({ cmd: commandSchema, createdId: int.positive().optional() })),
    layoutVersion: int.min(0),
    patients: z.array(patientSchema),
    staff: z.array(staffSchema),
    nextAgentId: int.positive(),
    jobs: z.array(jobSchema),
    nextJobId: int.positive(),
    ambulances: z.array(ambulanceSchema),
    nextAmbulanceId: int.positive(),
    collections: z.array(collectionSchema),
    nextCollectionId: int.positive(),
    referrals: z.array(referralSchema),
    nextReferralId: int.positive(),
    outpatients: z.array(outpatientSchema),
    visitors: z.array(visitorSchema),
    tours: z.array(tourSchema),
    goals: z.object({
      scenario: z.enum(SCENARIOS.map((s) => s.id) as [ScenarioId, ...ScenarioId[]]).nullable(),
      objectives: z.record(
        z.string(),
        z.object({ status: z.enum(["pending", "met", "failed"]), n: num, d: num }),
      ),
      unlocked: z.array(z.string()),
      outcome: z.object({ won: z.boolean(), text: z.string(), tick: int }).nullable(),
      segment4Since: nullableInt,
      inadequateRun: int.min(0),
    }),
    applicants: z.array(
      z.object({ id: int.positive(), key: z.string(), skill: num.min(0).max(100), until: int }),
    ),
    nextApplicantId: int.positive(),
    csi: z.object({
      overall: rating.nullable(),
      questions: z
        .object(
          Object.fromEntries(KEY_QUESTIONS.map((q) => [q, rating])) as Record<
            KeyQuestion,
            typeof rating
          >,
        )
        .nullable(),
      next: int,
      visit: z.object({ started: int, findings: z.array(findingSchema) }).nullable(),
      pending: reportSchema.nullable(),
      reports: z.array(reportSchema),
      specialMeasures: z.boolean(),
      concernsAt: nullableInt,
      vip: z
        .object({ eventId: int.positive(), who: z.string(), findings: z.array(findingSchema) })
        .nullable(),
    }),
    operations: z.array(operationSchema),
    nextOperationId: int.positive(),
    reserved: z.record(z.string(), int.positive()),
    dirt: z.record(z.string(), int.min(0)),
    roomSpecialties: z.record(z.string().regex(/^\d+:\d+$/), z.enum(specialtyIds)),
    emergencyTheatres: z.record(z.string().regex(/^\d+:\d+$/), z.literal(true)),
    cover: z.record(
      z.string().regex(/^[a-z_]+(:[a-z0-9_]+)?$/),
      z.object({ day: int.min(0).max(99), night: int.min(0).max(99) }),
    ),
    policies: z.object({
      gapFill: z.enum(["none", "bank", "bank_agency"]),
      priceLevel: num.min(PRIVATE.priceLevels[0]).max(PRIVATE.priceLevels[1]),
      phsReferrals: z.partialRecord(z.enum(specialtyIds), z.literal(true)),
      escalation: z.boolean(),
      dischargeBeforeNoon: z.boolean(),
      visiting: z.enum(["open", "set", "restricted", "none"]),
      fluVaccination: z.boolean(),
      infectionControl: z.boolean(),
      outbreakClosures: z.enum(["ipc", "manual"]),
    }),
    privateRooms: z.record(z.string().regex(/^\d+:\d+$/), z.literal(true)),
    essentialRooms: z.record(z.string().regex(/^\d+:\d+$/), z.boolean()),
    waitingAreas: z.record(z.string().regex(/^\d+:\d+$/), z.enum(WAITING_FOR)),
    inheritedLists: z.array(z.enum(specialtyIds)),
    maintenance: z.record(z.string(), z.object({ wear: num.min(0).max(100), broken: nullableInt })),
    closedRooms: z.record(
      z.string().regex(/^\d+:\d+$/),
      z.object({ since: int, by: z.enum(["ipc", "player"]) }),
    ),
    name: z.string().min(1),
    funding: z.enum(["phs", "private", "hybrid"]),
    departments: z.object({
      ae: z.enum(["open", "divert", "closed"]),
      outpatients: z.enum(["open", "urgent", "closed"]),
      theatres: z.enum(["open", "emergency", "closed"]),
    }),
    reputation: num.min(0).max(100),
    today: z.object({ ledger: ledgerSchema, stats: statsSchema, services: servicesSchema }),
    history: z.array(
      z.object({
        day: int.positive(),
        ledger: ledgerSchema,
        stats: statsSchema,
        reputation: num.min(0).max(100),
      }),
    ),
    month: monthSchema,
    months: z.array(monthSchema),
    loans: z.array(
      z.object({
        id: int.positive(),
        kind: z.enum(["capital", "revenue_support", "bank"]),
        principal: num.min(0),
        balance: num.min(0),
        rate: num.min(0),
        months: int.positive(),
        payment: num.min(0),
        taken: int,
        missed: int.min(0),
      }),
    ),
    nextLoanId: int.positive(),
    rating: z.object({
      segment: int.min(1).max(4),
      credit: int.min(0).max(6),
      administration: nullableInt,
      overdrawnSince: nullableInt,
    }),
    grants: z.object({
      offer: grantSchema.nullable(),
      active: z.array(grantSchema),
      nextOffer: int,
      done: z.array(z.object({ defId: z.string(), tick: int, met: z.boolean() })),
    }),
    pressure: z.object({
      active: z.array(
        z.object({
          id: int.positive(),
          defId: pressureEventId,
          announced: int,
          start: int,
          end: int,
        }),
      ),
      past: z.array(z.object({ defId: pressureEventId, start: int, end: int })),
      nextId: int.positive(),
      vaccinated: nullableInt,
      majorIncident: z
        .object({
          eventId: int.positive(),
          cause: z.string(),
          expected: int.min(0),
          arrived: int.min(0),
          casualties: z.array(
            z.object({
              at: int,
              conditionId: z.string(),
              channel: z.enum(["walk_in", "ambulance"]),
            }),
          ),
          declared: nullableInt,
          previous: z
            .object({
              outpatients: z.enum(["open", "urgent", "closed"]),
              theatres: z.enum(["open", "emergency", "closed"]),
              escalation: z.boolean(),
            })
            .nullable(),
          asked: int.min(0),
          coming: z.array(z.object({ staffId: int.positive(), at: int })),
          calledIn: z.array(int.positive()),
          last: nullableInt,
        })
        .nullable(),
    }),
    settings: z.object({
      catchment: int.min(1_000).max(10_000_000),
      patientVolume: num.min(0).max(10),
      rotas: z.boolean(),
      eventFrequency: z.enum(["off", "rare", "realistic", "frequent"]),
      recruitment: z.boolean(),
      failStates: z.boolean(),
    }),
    alerts: z.record(z.string(), int),
    incidents: z.array(
      z.object({
        id: int.positive(),
        tick: int.min(0),
        patientId: int.positive(),
        patientName: z.string(),
        conditionId: z.string(),
        summary: z.string(),
        where: z.string(),
        at: pointSchema,
        causes: z.array(z.string()),
        recommendations: z.array(z.string()),
      }),
    ),
    nextIncidentId: int.positive(),
  }),
});

export type SaveFile = z.input<typeof saveSchema>;

export function encodeSave(state: SimState, name: string, now = new Date()): SaveFile {
  return {
    format: SAVE_FORMAT,
    version: SIM_STATE_VERSION,
    meta: {
      name,
      savedAt: now.toISOString(),
      gameTime: formatClock(clockFromTick(state.tick)),
      money: state.money,
    },
    state: {
      seed: state.seed,
      rng: [...state.rng],
      tick: state.tick,
      money: state.money,
      floors: state.floors.map((g) => ({
        width: g.width,
        height: g.height,
        floorType: toBase64(g.floorType),
        wall: toBase64(g.wall),
        door: toBase64(g.door),
        land: toBase64(g.land),
        zone: toBase64(g.zone),
      })),
      site: state.site,
      objects: Object.values(state.objects),
      nextObjectId: state.nextObjectId,
      plan: state.plan,
      layoutVersion: state.layoutVersion,
      patients: Object.values(state.patients),
      staff: Object.values(state.staff),
      nextAgentId: state.nextAgentId,
      jobs: Object.values(state.jobs),
      nextJobId: state.nextJobId,
      ambulances: Object.values(state.ambulances),
      nextAmbulanceId: state.nextAmbulanceId,
      collections: Object.values(state.collections),
      referrals: Object.values(state.referrals),
      nextReferralId: state.nextReferralId,
      outpatients: Object.values(state.outpatients),
      visitors: Object.values(state.visitors),
      tours: Object.values(state.tours),
      goals: state.goals,
      applicants: state.applicants,
      nextApplicantId: state.nextApplicantId,
      csi: state.csi,
      operations: Object.values(state.operations),
      nextOperationId: state.nextOperationId,
      nextCollectionId: state.nextCollectionId,
      reserved: state.reserved,
      dirt: state.dirt,
      roomSpecialties: state.roomSpecialties,
      emergencyTheatres: state.emergencyTheatres,
      cover: state.cover,
      policies: state.policies,
      privateRooms: state.privateRooms,
      closedRooms: state.closedRooms,
      essentialRooms: state.essentialRooms,
      waitingAreas: state.waitingAreas,
      inheritedLists: state.inheritedLists,
      maintenance: state.maintenance,
      name: state.name,
      funding: state.funding,
      departments: state.departments,
      reputation: state.reputation,
      today: state.today,
      history: state.history,
      month: state.month,
      months: state.months,
      loans: state.loans,
      nextLoanId: state.nextLoanId,
      rating: state.rating,
      grants: state.grants,
      pressure: state.pressure,
      settings: state.settings,
      alerts: state.alerts,
      incidents: state.incidents,
      nextIncidentId: state.nextIncidentId,
    },
  };
}

/** Parses a save (already JSON.parsed) into a ready-to-run SimState. */
export function decodeSave(raw: unknown): { meta: SaveMeta; state: SimState } {
  const parsed = saveSchema.safeParse(migrate(raw));
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join(".") || "file";
    throw new SaveError(`Not a valid save (${where}: ${first?.message ?? "unknown problem"})`);
  }
  const { meta, state: s } = parsed.data;

  const floors = s.floors.map((f, n) => {
    const grid = createFloorGrid(f.width, f.height);
    const size = f.width * f.height;
    grid.floorType.set(layer(f.floorType, size, `floor ${n} floorType`));
    grid.wall.set(layer(f.wall, size, `floor ${n} wall`));
    grid.door.set(layer(f.door, size, `floor ${n} door`));
    grid.land.set(layer(f.land, size, `floor ${n} land`));
    grid.zone.set(layer(f.zone, size, `floor ${n} zone`));
    return grid;
  });

  const state: SimState = {
    version: SIM_STATE_VERSION,
    seed: s.seed,
    rng: [s.rng[0], s.rng[1], s.rng[2], s.rng[3]],
    tick: s.tick,
    money: s.money,
    floors,
    site: s.site,
    objects: {},
    nextObjectId: s.nextObjectId,
    // Checked when the game builds its plan preview, which drops steps that no longer fit.
    plan: s.plan.map(({ cmd, createdId }) =>
      createdId === undefined ? { cmd } : { cmd, createdId },
    ),
    layoutVersion: s.layoutVersion,
    patients: byId(s.patients, "patient"),
    staff: byId(s.staff, "staff member"),
    nextAgentId: s.nextAgentId,
    jobs: byId(s.jobs, "job"),
    nextJobId: s.nextJobId,
    ambulances: byId(s.ambulances, "ambulance"),
    nextAmbulanceId: s.nextAmbulanceId,
    collections: byId(s.collections, "collection"),
    referrals: byId(s.referrals, "referral"),
    nextReferralId: s.nextReferralId,
    outpatients: byId(s.outpatients, "outpatient"),
    visitors: byId(s.visitors, "visitor"),
    tours: byId(s.tours, "tour"),
    goals: s.goals,
    applicants: s.applicants,
    nextApplicantId: s.nextApplicantId,
    csi: s.csi,
    operations: byId(s.operations, "operation"),
    nextOperationId: s.nextOperationId,
    nextCollectionId: s.nextCollectionId,
    reserved: { ...s.reserved },
    dirt: Object.fromEntries(Object.entries(s.dirt).map(([k, v]) => [Number(k), v])),
    roomSpecialties: { ...s.roomSpecialties },
    emergencyTheatres: { ...s.emergencyTheatres },
    cover: { ...s.cover },
    policies: { ...s.policies, phsReferrals: { ...s.policies.phsReferrals } },
    privateRooms: { ...s.privateRooms },
    closedRooms: { ...s.closedRooms },
    essentialRooms: { ...s.essentialRooms },
    waitingAreas: { ...s.waitingAreas },
    inheritedLists: [...s.inheritedLists],
    maintenance: Object.fromEntries(
      Object.entries(s.maintenance).map(([k, v]) => [Number(k), { ...v }]),
    ),
    name: s.name,
    funding: s.funding,
    departments: { ...s.departments },
    reputation: s.reputation,
    today: s.today,
    history: s.history,
    month: s.month,
    months: s.months,
    loans: s.loans,
    nextLoanId: s.nextLoanId,
    rating: { ...s.rating },
    grants: {
      offer: s.grants.offer,
      active: s.grants.active,
      nextOffer: s.grants.nextOffer,
      done: s.grants.done,
    },
    pressure: {
      active: s.pressure.active,
      past: s.pressure.past,
      nextId: s.pressure.nextId,
      vaccinated: s.pressure.vaccinated,
      majorIncident: s.pressure.majorIncident,
    },
    settings: { ...s.settings },
    alerts: { ...s.alerts },
    incidents: s.incidents,
    nextIncidentId: s.nextIncidentId,
    events: [],
    rooms: [],
    objectRoom: {},
  };
  for (const p of Object.values(state.patients)) {
    if (p.id >= state.nextAgentId) throw new SaveError(`Patient id ${p.id} out of range`);
  }
  for (const st of Object.values(state.staff)) {
    if (st.id >= state.nextAgentId) throw new SaveError(`Staff id ${st.id} out of range`);
  }
  for (const obj of s.objects) restoreObject(state, floors, obj);
  detectRooms(state);
  return { meta, state };
}

/** Rebuilds an id-keyed record, rejecting duplicate ids. */
function byId<T extends { id: number }>(items: T[], what: string): Record<number, T> {
  const out: Record<number, T> = {};
  for (const item of items) {
    if (out[item.id]) throw new SaveError(`Duplicate ${what} id ${item.id}`);
    out[item.id] = item;
  }
  return out;
}

function restoreObject(state: SimState, floors: FloorGrid[], obj: PlacedObject): void {
  const grid = floors[obj.floor];
  if (!objectDef(obj.defId)) throw new SaveError(`Unknown item "${obj.defId}" in save`);
  if (obj.id >= state.nextObjectId) throw new SaveError(`Object id ${obj.id} out of range`);
  const r = objectRect(obj);
  if (!grid || r.x + r.w > grid.width || r.y + r.h > grid.height) {
    throw new SaveError(`Object ${obj.id} is off the map`);
  }
  const layer = layerOf(grid, obj.defId);
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const i = tileIndex(grid, x, y);
      if (layer[i] !== -1) throw new SaveError(`Objects overlap at ${x}, ${y}`);
      layer[i] = obj.id;
    }
  }
  state.objects[obj.id] = { ...obj };
}

/** Decodes one saved grid layer, checking its size. */
function layer(b64: string, expectedLength: number, what: string): Uint8Array {
  let out: Uint8Array;
  try {
    out = fromBase64(b64);
  } catch {
    throw new SaveError(`Corrupt data in ${what}`);
  }
  if (out.length !== expectedLength) throw new SaveError(`Wrong size for ${what}`);
  return out;
}
