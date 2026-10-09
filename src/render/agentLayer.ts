/**
 * Draws patients and staff as small figures (programmer art: discs), moved
 * smoothly between sim ticks. Staff are coloured by role; patients are white
 * with a ring in their triage colour. Patients in a bad mood show a red dot;
 * one getting worse shows an amber "!", and a cardiac arrest a red cross.
 * Someone who has died is shown only as a covered shape (never graphic),
 * and isn't drawn once they're in the mortuary.
 *
 * Parked ambulances are drawn beneath everyone, and a paramedic stands
 * beside each patient still waiting to be handed over.
 *
 * Views are pooled by agent id: created when an agent appears, destroyed
 * when it leaves.
 */
import { Container, Graphics } from "pixi.js";
import { TRIAGE_CATEGORIES } from "@data/patients";
import type { AgentBase, Ambulance, Patient, Staff } from "@sim/agents";
import type { SimState } from "@sim/state";
import { TILE_SIZE } from "./constants";
import {
  AMBULANCE_GREEN,
  AMBULANCE_YELLOW,
  ARREST_MARK,
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
  private readonly ambulances = new Map<number, Graphics>();

  constructor() {
    this.container.addChild(this.vehicles, this.people);
  }
  selectedId: number | null = null;

  /** Positions every agent, interpolated `alpha` of the way from last tick to this one. */
  update(state: SimState, alpha: number): void {
    this.updateAmbulances(Object.values(state.ambulances));
    const live = new Set<number>();
    for (const p of Object.values(state.patients)) {
      if (p.stage === "in_mortuary") continue;
      live.add(p.id);
      const warning = warningOf(p, state.tick);
      this.place(p, alpha, patientLook(p, p.id === this.selectedId, warning), (g) =>
        drawPatient(g, p, p.id === this.selectedId, warning),
      );
    }
    for (const s of Object.values(state.staff)) {
      live.add(s.id);
      const selected = s.id === this.selectedId;
      this.place(s, alpha, `${s.role}|${selected}`, (g) => drawStaff(g, s, selected));
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
    for (const g of this.ambulances.values()) g.destroy();
    this.ambulances.clear();
  }

  private updateAmbulances(all: Ambulance[]): void {
    const parked = new Set<number>();
    for (const a of all) {
      if (!a.space) continue;
      parked.add(a.id);
      if (this.ambulances.has(a.id)) continue;
      const g = new Graphics();
      drawAmbulance(g, a);
      this.vehicles.addChild(g);
      this.ambulances.set(a.id, g);
    }
    for (const [id, g] of this.ambulances) {
      if (!parked.has(id)) {
        g.destroy();
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

type Warning = "none" | "deteriorating" | "arrest";

/** Drawn from the sim's truth, so the player sees trouble staff haven't spotted yet. */
function warningOf(p: Patient, tick: number): Warning {
  if (p.stage === "collapsed") return "arrest";
  const d = p.deterioration;
  return d && tick >= d.onset && p.stage !== "leaving" ? "deteriorating" : "none";
}

function patientLook(p: Patient, selected: boolean, warning: Warning): string {
  return `${p.category}|${p.mood < UNHAPPY_MOOD}|${selected}|${warning}|${withCrew(p)}|${onTheMove(p)}|${p.death !== null}`;
}

const withCrew = (p: Patient) => p.stage === "awaiting_handover";
const onTheMove = (p: Patient) => p.stage === "transferring";

function drawPatient(g: Graphics, p: Patient, selected: boolean, warning: Warning): void {
  if (p.death) {
    // A plain sheet, nothing more.
    if (selected) g.roundRect(-11, -16, 22, 32, 6).stroke({ width: 2.5, color: SELECTED_RING });
    g.roundRect(-8, -13, 16, 26, 5).fill(0xdfe3e8).stroke({ width: 1.5, color: 0x8a929c });
    return;
  }
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
  } else if (warning === "deteriorating") {
    g.circle(-6, -8, 5).fill(DETERIORATING_MARK).stroke({ width: 1, color: 0x1d232b });
    g.rect(-7, -11, 2, 4).fill(0x1d232b);
    g.rect(-7, -6, 2, 1.5).fill(0x1d232b);
  }
}

function drawStaff(g: Graphics, s: Staff, selected: boolean): void {
  if (selected) g.circle(0, 0, STAFF_RADIUS + 5).stroke({ width: 2.5, color: SELECTED_RING });
  g.circle(0, 0, STAFF_RADIUS).fill(ROLE_COLOURS[s.role]).stroke({ width: 2, color: 0xffffff });
}

/** A parked ambulance: yellow with a band of green and yellow squares (programmer art). */
function drawAmbulance(g: Graphics, a: Ambulance): void {
  const T = TILE_SIZE;
  const { x, y, w, h } = a.space!;
  const pad = T * 0.2;
  const left = x * T + pad;
  const top = y * T + pad;
  const width = w * T - pad * 2;
  const height = h * T - pad * 2;
  g.roundRect(left, top, width, height, 6)
    .fill(AMBULANCE_YELLOW)
    .stroke({ width: 2, color: 0x2b2b2b });
  // Battenburg band along the length.
  const long = height >= width;
  const n = 8;
  for (let i = 0; i < n; i++) {
    if (i % 2 === 1) continue;
    if (long) {
      const bh = height / n;
      g.rect(left + width * 0.15, top + i * bh, width * 0.7, bh).fill(AMBULANCE_GREEN);
    } else {
      const bw = width / n;
      g.rect(left + i * bw, top + height * 0.15, bw, height * 0.7).fill(AMBULANCE_GREEN);
    }
  }
}
