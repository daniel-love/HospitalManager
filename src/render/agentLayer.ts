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
 * beside each patient still waiting to be handed over.
 *
 * Views are pooled by agent id: created when an agent appears, destroyed
 * when it leaves.
 */
import { Container, Graphics, GraphicsContext } from "pixi.js";
import { staffRoleById } from "@data/catalogue";
import { TRIAGE_CATEGORIES } from "@data/patients";
import { onSite, type AgentBase, type Ambulance, type Patient, type Staff } from "@sim/agents";
import type { SimState } from "@sim/state";
import { SPACE_L, SPACE_W } from "@sim/systems/ambulances";
import { TILE_SIZE } from "./constants";
import { deceasedLook, drawDeceased, drawFamilies, familiesLook, pushOffset } from "./deathMarks";
import {
  AMBULANCE_GREEN,
  AMBULANCE_YELLOW,
  ARREST_MARK,
  ATTENDED_RING,
  DETERIORATING_MARK,
  PARAMEDIC_COLOUR,
  PATIENT_COLOUR,
  ROLE_COLOURS,
  SELECTED_RING,
  UNTRIAGED_RING,
} from "./palette";

const PATIENT_RADIUS = 7;
const STAFF_RADIUS = 8;
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
  /** Families in the Relatives' Room, being told of a death. */
  private readonly families = new Graphics();
  private familiesDrawn = "";

  constructor() {
    this.container.addChild(this.vehicles, this.families, this.people);
  }
  selectedId: number | null = null;

  /** Positions every agent, interpolated `alpha` of the way from last tick to this one. */
  update(state: SimState, alpha: number): void {
    this.updateAmbulances(Object.values(state.ambulances), alpha);
    const attended = attendedPatients(state);
    const blinkOn = Math.floor(performance.now() / BLINK_MS) % 2 === 0;
    const live = new Set<number>();
    for (const p of Object.values(state.patients)) {
      live.add(p.id);
      const selected = p.id === this.selectedId;
      if (p.death) {
        this.place(p, alpha, deceasedLook(state, p, selected), (g) =>
          drawDeceased(g, state, p, selected),
        );
        continue;
      }
      const warning = warningOf(p, state.tick, attended.has(p.id), blinkOn);
      this.place(p, alpha, patientLook(p, p.id === this.selectedId, warning), (g) =>
        drawPatient(g, p, p.id === this.selectedId, warning),
      );
    }
    for (const s of Object.values(state.staff)) {
      if (!onSite(s)) continue; // On call at home, or on the way in.
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
    const families = familiesLook(state);
    if (families !== this.familiesDrawn) {
      this.families.clear();
      drawFamilies(this.families, state);
      this.familiesDrawn = families;
    }
    for (const [id, view] of this.views) {
      if (!live.has(id)) {
        view.g.destroy();
        this.views.delete(id);
      }
    }
  }

  clear(): void {
    for (const v of this.views.values()) v.g.destroy();
    this.views.clear();
    for (const v of this.ambulances.values()) v.g.destroy();
    this.ambulances.clear();
    this.families.clear();
    this.familiesDrawn = "";
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

function patientLook(p: Patient, selected: boolean, warning: Warning): string {
  return `${p.category}|${p.mood < UNHAPPY_MOOD}|${selected}|${warning}|${withCrew(p)}|${onTheMove(p)}`;
}

const withCrew = (p: Patient) => p.stage === "awaiting_handover";
const onTheMove = (p: Patient) => p.stage === "transferring";

function drawPatient(g: Graphics, p: Patient, selected: boolean, warning: Warning): void {
  const ring = p.category === 0 ? UNTRIAGED_RING : TRIAGE_CATEGORIES[p.category]!.colour;
  if (withCrew(p)) {
    // The paramedic staying with them, and the stretcher beneath.
    g.roundRect(-8, -12, 16, 24, 4).fill({ color: 0xffffff, alpha: 0.8 });
    g.circle(14, 0, STAFF_RADIUS).fill(PARAMEDIC_COLOUR).stroke({ width: 2.5, color: 0xffffff });
  }
  // Being wheeled to the ward on their trolley.
  if (onTheMove(p)) g.roundRect(-8, -14, 16, 28, 4).fill({ color: 0xffffff, alpha: 0.85 });
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
