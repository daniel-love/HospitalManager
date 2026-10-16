/**
 * Draws patients and staff as small figures (programmer art: discs), moved
 * smoothly between sim ticks. Staff are coloured by role; patients are white
 * with a ring in their triage colour. Patients in a bad mood show a red dot;
 * a cardiac arrest a red cross. One getting worse shows an amber "!": it
 * blinks until staff notice, then holds steady, and gains a ring in the
 * clinician blue while a doctor or nurse is with them.
 * Someone who has died is never shown graphically: deathMarks.ts draws each
 * step after a death (curtains, sheet, trolley, mortuary drawer, family).
 *
 * Ambulances (driving or parked) are drawn beneath everyone, and a paramedic stands
 * beside each patient still waiting to be handed over. So are funeral
 * directors' private ambulances, whose crew are drawn while on foot.
 *
 * Views are pooled by agent id: created when an agent appears, destroyed
 * when it leaves.
 */
import { Container, Graphics, GraphicsContext } from "pixi.js";
import { equipmentById, staffRoleById } from "@data/catalogue";
import { TRIAGE_CATEGORIES } from "@data/patients";
import { onSite, type AgentBase, type Ambulance, type Patient, type Staff } from "@sim/agents";
import type { SimState } from "@sim/state";
import { SPACE_L, SPACE_W, withAmbulanceCrew } from "@sim/systems/ambulances";
import { crewOnFoot } from "@sim/systems/collections";
import { curtainsDrawn } from "@sim/systems/curtains";
import { kitsOut } from "@sim/world/sharedKit";
import { bayScreen, drawBayScreen, type BayScreen } from "./bayCurtains";
import { TILE_SIZE } from "./constants";
import {
  bedCurtainSize,
  crewSpot,
  deceasedBed,
  deceasedLook,
  drawBedCurtains,
  drawCrew,
  drawDeceased,
  drawFamilies,
  familiesLook,
  privateAmbulanceContext,
  pushOffset,
} from "./deathMarks";
import {
  AMBULANCE_GREEN,
  AMBULANCE_YELLOW,
  ARREST_MARK,
  ATTENDED_RING,
  CATEGORY_COLOURS,
  DETERIORATING_MARK,
  OUTPATIENT_RING,
  PARAMEDIC_COLOUR,
  PATIENT_COLOUR,
  ROLE_COLOURS,
  SELECTED_RING,
  UNTRIAGED_RING,
} from "./palette";

const PATIENT_RADIUS = 7;
const STAFF_RADIUS = 8;
/** Shared kit drawn beside staff, px. */
const KIT_SIZE = 12;
const UNHAPPY_MOOD = 30;
/** How long each on and off half of the unnoticed-deterioration blink lasts. */
const BLINK_MS = 400;

interface View {
  g: Graphics;
  /** What the drawing depends on, so it's only redrawn when that changes. */
  look: string;
}

export class AgentLayer {
  readonly container = new Container();
  /** Vehicles go under people. */
  private readonly vehicles = new Container();
  private readonly people = new Container();
  private readonly views = new Map<number, View>();
  /** Each ambulance's body, and the way it's facing (radians, 0 = along y). */
  private readonly ambulances = new Map<number, { g: Graphics; angle: number }>();
  /** Funeral directors' private ambulances, by collection id. */
  private readonly privateAmbulances = new Map<number, { g: Graphics; angle: number }>();
  /** Families in the Relatives' Room, being told of a death. */
  private readonly families = new Graphics();
  /** Shared kit (a 12-lead ECG, say) beside whoever has it out. */
  private readonly kits = new Graphics();
  private familiesDrawn = "";
  /** Cubicles with their curtain drawn across the opening, under everyone in them. */
  private readonly bays = new Graphics();
  private baysDrawn = "";

  constructor() {
    this.container.addChild(this.bays, this.vehicles, this.families, this.kits, this.people);
  }
  selectedId: number | null = null;
  /** The floor on view: only those on it are drawn (vehicles only on the ground). */
  floor = 0;

  /** On the floor on view, and not out of sight on the stairs or in a lift. */
  private shown(a: AgentBase): boolean {
    const t = a.transit;
    return a.floor === this.floor && !(t && (t.phase === "climbing" || t.phase === "riding"));
  }

  /** Positions every agent, interpolated `alpha` of the way from last tick to this one. */
  update(state: SimState, alpha: number): void {
    this.vehicles.visible = this.floor === 0;
    this.updateAmbulances(Object.values(state.ambulances), alpha);
    const attended = attendedPatients(state);
    const wheeled = wheeledPatients(state);
    const blinkOn = Math.floor(performance.now() / BLINK_MS) % 2 === 0;
    const live = new Set<number>();
    const screened = new Map<number, BayScreen>();
    for (const p of Object.values(state.patients)) {
      if (!this.shown(p)) continue;
      live.add(p.id);
      const selected = p.id === this.selectedId;
      if (p.death) {
        const bed = deceasedBed(state, p);
        const bay = bed && bayScreen(state, bed);
        if (bay) screened.set(bed.id, bay);
        this.place(p, alpha, deceasedLook(state, p, selected), (g) =>
          drawDeceased(g, state, p, selected),
        );
        continue;
      }
      const warning = warningOf(p, state.tick, attended.has(p.id), blinkOn);
      const bed = p.bed === null ? undefined : state.objects[p.bed];
      let curtains: Curtains = null;
      if (bed && curtainsDrawn(state, bed.id)) {
        const bay = bayScreen(state, bed);
        if (bay) screened.set(bed.id, bay);
        else curtains = bedCurtainSize(bed);
      }
      const moving = onTheMove(p) || wheeled.has(p.id);
      this.place(p, alpha, patientLook(p, selected, warning, curtains, moving), (g) =>
        drawPatient(g, p, selected, warning, curtains, moving),
      );
    }
    for (const s of Object.values(state.staff)) {
      if (!onSite(s) || !this.shown(s)) continue; // On call at home, or on the way in.
      live.add(s.id);
      const selected = s.id === this.selectedId;
      this.place(s, alpha, `${s.role}|${selected}`, (g) => drawStaff(g, s, selected));
      // A porter wheeling a covered trolley pushes it from behind.
      const push = pushOffset(state, s);
      if (push) {
        const pos = this.views.get(s.id)!.g.position;
        pos.set(pos.x + push.x * TILE_SIZE, pos.y + push.y * TILE_SIZE);
      }
    }
    for (const o of Object.values(state.outpatients)) {
      if (!this.shown(o)) continue;
      live.add(o.id);
      const selected = o.id === this.selectedId;
      this.place(o, alpha, `outpatient|${selected}`, (g) => drawOutpatient(g, selected));
    }
    for (const v of Object.values(state.visitors)) {
      if (!this.shown(v)) continue;
      live.add(v.id);
      this.place(v, alpha, "visitor", drawVisitor);
    }
    for (const t of Object.values(state.tours)) {
      if (!this.shown(t)) continue;
      live.add(t.id);
      this.place(t, alpha, t.kind, t.kind === "inspector" ? drawInspector : drawVip);
    }
    for (const c of Object.values(state.collections)) {
      if (!crewOnFoot(c) || !this.shown(c.crew)) continue;
      live.add(c.crew.id);
      this.place(c.crew, alpha, "crew", drawCrew);
      const at = crewSpot(state, c, alpha);
      if (at)
        this.views
          .get(c.crew.id)!
          .g.position.set((at.x + 0.5) * TILE_SIZE, (at.y + 0.5) * TILE_SIZE);
    }
    this.drawBays(screened);
    this.updatePrivateAmbulances(state, alpha);
    this.drawKits(state);
    const families = `${this.floor}|${familiesLook(state)}`;
    if (families !== this.familiesDrawn) {
      this.families.clear();
      drawFamilies(this.families, state, this.floor);
      this.familiesDrawn = families;
    }
    for (const [id, view] of this.views) {
      if (!live.has(id)) {
        view.g.destroy();
        this.views.delete(id);
      }
    }
  }

  private drawBays(screened: Map<number, BayScreen>): void {
    const key = [...screened]
      .map(([id, bay]) => `${id}:${bay.tiles.length}:${bay.openings.length}`)
      .sort()
      .join(",");
    if (key === this.baysDrawn) return;
    this.baysDrawn = key;
    this.bays.clear();
    for (const bay of screened.values()) drawBayScreen(this.bays, bay);
  }

  /**
   * Shared kit out of its store: wheeled just ahead of whoever is taking it
   * to a patient or back, and left beside them at the bedside.
   */
  private drawKits(state: SimState): void {
    this.kits.clear();
    const T = TILE_SIZE;
    for (const [kitId, staffId] of kitsOut(state)) {
      const kit = state.objects[kitId];
      const s = state.staff[staffId];
      const view = this.views.get(staffId);
      if (!kit || !s || !view || !this.shown(s)) continue;
      const def = equipmentById.get(kit.defId);
      const dx = s.x - s.prevX;
      const dy = s.y - s.prevY;
      const len = Math.hypot(dx, dy);
      // Ahead of them while walking; to their right while they work.
      const ox = len > 1e-6 ? (dx / len) * 0.6 : 0.6;
      const oy = len > 1e-6 ? (dy / len) * 0.6 : 0;
      const x = view.g.position.x + ox * T;
      const y = view.g.position.y + oy * T;
      const colour = def ? CATEGORY_COLOURS[def.category] : 0x888888;
      this.kits
        .roundRect(x - KIT_SIZE / 2, y - KIT_SIZE / 2, KIT_SIZE, KIT_SIZE, 3)
        .fill(colour)
        .stroke({ width: 1.5, color: 0xffffff });
      // Its screen.
      this.kits.rect(x - KIT_SIZE / 4, y - KIT_SIZE / 4, KIT_SIZE / 2, KIT_SIZE / 3).fill(0x1d232b);
    }
  }

  clear(): void {
    this.kits.clear();
    this.bays.clear();
    this.baysDrawn = "";
    for (const v of this.views.values()) v.g.destroy();
    this.views.clear();
    for (const v of this.ambulances.values()) v.g.destroy();
    this.ambulances.clear();
    for (const v of this.privateAmbulances.values()) v.g.destroy();
    this.privateAmbulances.clear();
    this.families.clear();
    this.familiesDrawn = "";
  }

  /** Funeral directors' vehicles: driving in, parked near the mortuary, or driving off. */
  private updatePrivateAmbulances(state: SimState, alpha: number): void {
    const live = new Set<number>();
    for (const c of Object.values(state.collections)) {
      const v = c.vehicle;
      if (!v) continue;
      live.add(c.id);
      let view = this.privateAmbulances.get(c.id);
      if (!view) {
        // It comes in along the road: eastbound from the west end, or westbound.
        view = {
          g: new Graphics(privateAmbulanceContext()),
          angle: v.from === 0 ? -Math.PI / 2 : Math.PI / 2,
        };
        this.vehicles.addChild(view.g);
        this.privateAmbulances.set(c.id, view);
      }
      const dx = v.x - v.prevX;
      const dy = v.y - v.prevY;
      if (Math.hypot(dx, dy) > 1e-6) view.angle = Math.atan2(-dx, dy);
      view.g.position.set(
        (v.prevX + dx * alpha + 0.5) * TILE_SIZE,
        (v.prevY + dy * alpha + 0.5) * TILE_SIZE,
      );
      view.g.rotation = view.angle;
    }
    for (const [id, view] of this.privateAmbulances) {
      if (!live.has(id)) {
        view.g.destroy();
        this.privateAmbulances.delete(id);
      }
    }
  }

  private updateAmbulances(all: Ambulance[], alpha: number): void {
    const live = new Set<number>();
    const T = TILE_SIZE;
    for (const a of all) {
      live.add(a.id);
      let view = this.ambulances.get(a.id);
      if (!view) {
        view = { g: new Graphics(ambulanceContext()), angle: 0 };
        this.vehicles.addChild(view.g);
        this.ambulances.set(a.id, view);
      }
      if (a.phase === "parked" && a.space) {
        // Centred in its space, lengthways.
        const { x, y, w, h } = a.space;
        view.g.position.set((x + w / 2) * T, (y + h / 2) * T);
        view.angle = h >= w ? 0 : Math.PI / 2;
      } else {
        const dx = a.x - a.prevX;
        const dy = a.y - a.prevY;
        if (Math.hypot(dx, dy) > 1e-6) view.angle = Math.atan2(-dx, dy);
        const x = a.prevX + dx * alpha;
        const y = a.prevY + dy * alpha;
        view.g.position.set((x + 0.5) * T, (y + 0.5) * T);
      }
      view.g.rotation = view.angle;
    }
    for (const [id, view] of this.ambulances) {
      if (!live.has(id)) {
        view.g.destroy();
        this.ambulances.delete(id);
      }
    }
  }

  private place(a: AgentBase, alpha: number, look: string, draw: (g: Graphics) => void): void {
    let view = this.views.get(a.id);
    if (!view) {
      view = { g: new Graphics(), look: "" };
      this.views.set(a.id, view);
      // Staff draw above patients.
      if ("role" in a) this.people.addChild(view.g);
      else this.people.addChildAt(view.g, 0);
    }
    if (view.look !== look) {
      view.g.clear();
      draw(view.g);
      view.look = look;
    }
    const x = a.prevX + (a.x - a.prevX) * alpha;
    const y = a.prevY + (a.y - a.prevY) * alpha;
    // Agents don't block each other, so two staff often share a tile (a
    // nurse and doctor at one bedside). A small fixed offset per person
    // keeps both visible.
    const [ox, oy] = "role" in a ? [((a.id * 7) % 5) - 2, ((a.id * 11) % 5) - 2] : [0, 0];
    view.g.position.set((x + 0.5) * TILE_SIZE + ox * 3, (y + 0.5) * TILE_SIZE + oy * 3);
  }
}

/**
 * How a deterioration looks: `unnoticed` blinks (its off half is `hidden`),
 * `escalated` is noticed but nobody is with them yet, `attended` has a
 * clinician (or the ambulance crew) at their side.
 */
type Warning = "none" | "unnoticed" | "hidden" | "escalated" | "attended" | "arrest";

/** Patients a doctor or nurse is working with right now. */
/** Patients a porter is wheeling to a scan or back, or a practitioner from theatre to Recovery. */
function wheeledPatients(state: SimState): Set<number> {
  const ids = new Set<number>();
  for (const op of Object.values(state.operations)) {
    if (op.phase === "to_recovery") ids.add(op.patientId);
    // An emergency wheeled to theatre on their bed.
    if (op.emergency && state.patients[op.patientId]?.stage === "to_theatre") ids.add(op.patientId);
  }
  for (const j of Object.values(state.jobs)) {
    if (j.kind !== "escort" || j.state !== "working" || j.patientId === null) continue;
    if (!j.roles.includes("porter")) continue;
    const p = state.patients[j.patientId];
    if (p && p.path.length > 0) ids.add(p.id);
  }
  return ids;
}

function attendedPatients(state: SimState): Set<number> {
  const ids = new Set<number>();
  for (const j of Object.values(state.jobs)) {
    if (j.state !== "working" || j.patientId === null || j.staffId === null) continue;
    const s = state.staff[j.staffId];
    const group = s && staffRoleById.get(s.role)?.group;
    if (group === "medical" || group === "nursing") ids.add(j.patientId);
  }
  return ids;
}

/** Drawn from the sim's truth, so the player sees trouble staff haven't spotted yet. */
function warningOf(p: Patient, tick: number, attended: boolean, blinkOn: boolean): Warning {
  if (p.stage === "collapsed") return "arrest";
  const d = p.deterioration;
  if (!d || tick < d.onset || p.stage === "leaving") return "none";
  if (attended || withCrew(p)) return "attended";
  if (d.noticed !== null) return "escalated";
  return blinkOn ? "unnoticed" : "hidden";
}

type Curtains = { w: number; h: number } | null;

function patientLook(
  p: Patient,
  selected: boolean,
  warning: Warning,
  curtains: Curtains,
  moving: boolean,
): string {
  return `${p.category}|${p.mood < UNHAPPY_MOOD}|${selected}|${warning}|${withCrew(p)}|${onStretcher(p)}|${moving}|${curtains?.w}x${curtains?.h}`;
}

/** The paramedic stays with them until handover. */
const withCrew = withAmbulanceCrew;
/** On the crew's stretcher: at the ambulance, or being wheeled in. */
const onStretcher = (p: Patient) =>
  p.stage === "awaiting_handover" || (withCrew(p) && p.stage === "called_treatment");
const onTheMove = (p: Patient) => p.stage === "transferring";

function drawPatient(
  g: Graphics,
  p: Patient,
  selected: boolean,
  warning: Warning,
  curtains: Curtains,
  moving: boolean,
): void {
  const ring = p.category === 0 ? UNTRIAGED_RING : TRIAGE_CATEGORIES[p.category]!.colour;
  // Screened for care: the bay's privacy curtain drawn round the bed.
  if (curtains) drawBedCurtains(g, curtains);
  // The stretcher beneath, and the paramedic staying with them.
  if (onStretcher(p)) g.roundRect(-8, -12, 16, 24, 4).fill({ color: 0xffffff, alpha: 0.8 });
  if (withCrew(p)) {
    g.circle(14, 0, STAFF_RADIUS).fill(PARAMEDIC_COLOUR).stroke({ width: 2.5, color: 0xffffff });
  }
  // Being wheeled to the ward, or to a scan, on their trolley.
  if (moving) g.roundRect(-8, -14, 16, 28, 4).fill({ color: 0xffffff, alpha: 0.85 });
  if (selected) g.circle(0, 0, PATIENT_RADIUS + 5).stroke({ width: 2.5, color: SELECTED_RING });
  g.circle(0, 0, PATIENT_RADIUS).fill(PATIENT_COLOUR).stroke({ width: 3, color: ring });
  if (p.mood < UNHAPPY_MOOD)
    g.circle(5, -6, 3).fill(0xe0504a).stroke({ width: 1, color: 0x1d232b });
  if (warning === "arrest") {
    g.rect(-2, -14, 4, 12).fill(ARREST_MARK);
    g.rect(-6, -10, 12, 4).fill(ARREST_MARK);
  } else if (warning === "unnoticed" || warning === "escalated" || warning === "attended") {
    if (warning === "attended") g.circle(-6, -8, 7.5).stroke({ width: 2, color: ATTENDED_RING });
    g.circle(-6, -8, 5).fill(DETERIORATING_MARK).stroke({ width: 1, color: 0x1d232b });
    g.rect(-7, -11, 2, 4).fill(0x1d232b);
    g.rect(-7, -6, 2, 1.5).fill(0x1d232b);
  }
}

/** Someone in for an outpatient appointment: a patient with a teal ring. */
function drawOutpatient(g: Graphics, selected: boolean): void {
  if (selected) g.circle(0, 0, PATIENT_RADIUS + 5).stroke({ width: 2.5, color: SELECTED_RING });
  g.circle(0, 0, PATIENT_RADIUS).fill(PATIENT_COLOUR).stroke({ width: 3, color: OUTPATIENT_RING });
}

/** A visitor: a member of the public, smaller than a patient, in plain clothes. */
/** Visitors' clothes: a muted violet, apart from patients and every staff role. */
const VISITOR_COLOUR = 0x9b8fb8;

function drawVisitor(g: Graphics): void {
  g.circle(0, 0, PATIENT_RADIUS - 1)
    .fill(VISITOR_COLOUR)
    .stroke({ width: 1.5, color: 0xffffff });
}

/** A CSI inspector: a dark suit, with a white lanyard ring. */
function drawInspector(g: Graphics): void {
  g.circle(0, 0, PATIENT_RADIUS).fill(0x1f2937).stroke({ width: 2.5, color: 0xffffff });
}

/** A VIP and their party: gold, so they stand out. */
function drawVip(g: Graphics): void {
  g.circle(0, 0, PATIENT_RADIUS).fill(0xd4a72c).stroke({ width: 2, color: 0x1f2937 });
}

function drawStaff(g: Graphics, s: Staff, selected: boolean): void {
  if (selected) g.circle(0, 0, STAFF_RADIUS + 5).stroke({ width: 2.5, color: SELECTED_RING });
  g.circle(0, 0, STAFF_RADIUS).fill(ROLE_COLOURS[s.role]).stroke({ width: 2, color: 0xffffff });
}

/**
 * An ambulance seen from above, centred on the origin and lying along the y
 * axis with its cab at +y: a box body with a Battenburg check down each side,
 * a light bar and roof unit, then a narrower cab with windscreen and mirrors.
 * It fills a 3×6 space less a margin. Built once and shared by every
 * ambulance, so each one costs only a draw of the same geometry.
 */
let ambulanceShape: GraphicsContext | null = null;

function ambulanceContext(): GraphicsContext {
  if (ambulanceShape) return ambulanceShape;
  const T = TILE_SIZE;
  const pad = T * 0.2;
  const W = SPACE_W * T - pad * 2;
  const L = SPACE_L * T - pad * 2;
  const left = -W / 2;
  const top = -L / 2;
  const outline = { width: 1.5, color: 0x2b2b2b };
  const g = new GraphicsContext();
  // Shadow.
  g.roundRect(left + 3, top + 4, W, L, 8).fill({ color: 0x000000, alpha: 0.25 });
  // Cab: the front 22%, a little narrower than the box, with a rounded nose.
  const cabL = L * 0.22;
  const cabTop = top + L - cabL;
  const cabW = W * 0.9;
  g.roundRect(-cabW / 2, cabTop - 6, cabW, cabL + 6, 9)
    .fill(AMBULANCE_YELLOW)
    .stroke(outline);
  // Wing mirrors, then the windscreen and bonnet.
  g.rect(-cabW / 2 - 4, cabTop + cabL * 0.18, 5, 4).fill(0x2b2b2b);
  g.rect(cabW / 2 - 1, cabTop + cabL * 0.18, 5, 4).fill(0x2b2b2b);
  g.roundRect(-cabW * 0.42, cabTop + cabL * 0.08, cabW * 0.84, cabL * 0.38, 3).fill(0x2c3e50);
  g.rect(-cabW * 0.3, cabTop + cabL * 0.72, cabW * 0.6, 2).fill({ color: 0x000000, alpha: 0.2 });
  // Box body (the patient compartment), roof in yellow.
  const boxL = L - cabL;
  g.roundRect(left, top, W, boxL, 5).fill(AMBULANCE_YELLOW).stroke(outline);
  // Battenburg: a two-row check down each side.
  const sq = W * 0.12;
  const n = Math.floor((boxL - 4) / sq);
  const y0 = top + (boxL - n * sq) / 2;
  for (let i = 0; i < n; i++) {
    const y = y0 + i * sq;
    for (const [x, odd] of [
      [left + 1, 0],
      [left + 1 + sq, 1],
      [left + W - 1 - sq * 2, 1],
      [left + W - 1 - sq, 0],
    ] as const) {
      if ((i + odd) % 2 === 0) g.rect(x, y, sq, sq).fill(AMBULANCE_GREEN);
    }
  }
  // Blue light bar across the front of the box, a smaller one at the back.
  g.roundRect(-W * 0.3, top + boxL - 9, W * 0.6, 6, 2).fill(0x2f6fff);
  g.roundRect(-W * 0.2, top + 3, W * 0.4, 4, 2).fill(0x2f6fff);
  // Air-conditioning unit and a roof vent.
  g.roundRect(-W * 0.22, top + boxL * 0.45, W * 0.44, boxL * 0.18, 3)
    .fill(0xdcdcd4)
    .stroke({ width: 1, color: 0x8a8a84 });
  g.rect(-W * 0.1, top + boxL * 0.18, W * 0.2, W * 0.2).fill(0xdcdcd4);
  // Rear doors: the seam between them.
  g.rect(-0.75, top, 1.5, boxL * 0.08).fill(0x2b2b2b);
  ambulanceShape = g;
  return g;
}
