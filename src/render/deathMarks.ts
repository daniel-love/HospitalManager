/**
 * How the process after a death looks on the map (GAME_DESIGN §5.6). Never
 * graphic: what changes is the setting around them, so every step reads at a
 * glance:
 *
 *   - In the bay: the curtains are drawn round the bed (it's closed). Until
 *     last offices they lie under the bed's blanket; afterwards under a white
 *     sheet with an identification label.
 *   - Above them, a strip of pips, one per step: done steps filled, the step
 *     in hand coloured blue (someone is doing it), amber (waiting for someone
 *     free) or red (blocked: the player needs to fix something, with a "!").
 *   - On the way to the mortuary: a concealment trolley, the porter pushing it
 *     from behind (see pushOffset).
 *   - In the mortuary: a label on their fridge drawer, coloured by what
 *     they're waiting for: the Medical Examiner, the coroner, or collection.
 *   - While a doctor breaks the news, the family sit on the Relatives' Room sofa.
 */
import type { Graphics } from "pixi.js";
import type { Patient, Point, Staff } from "@sim/agents";
import type { PlacedObject, SimState } from "@sim/state";
import {
  deathStatus,
  deathStepDone,
  deathSteps,
  deathStepStatus,
  type DeathProgress,
  type DeathStatus,
} from "@sim/systems/deaths";
import { objectRect } from "@sim/world/objects";
import { TILE_SIZE } from "./constants";
import { CURTAIN_COLOUR, SELECTED_RING } from "./palette";

const T = TILE_SIZE;
const PROGRESS_COLOURS: Record<DeathProgress, number> = {
  underway: 0x6fa8ff,
  waiting: 0xf2c94c,
  blocked: 0xe0504a,
};
const BLANKET = 0xa9c4de;
const SHEET = 0xf4f5f7;
const OUTLINE = 0x8a929c;
const DARK = 0x1d232b;
const CORONER = 0x9b7fd4;
const AWAITING_COLLECTION = 0x6fd08c;
const FAMILY = 0xb48ad6;

/** Each deceased patient's status, worked out once per tick rather than every frame. */
const statusCache = new Map<
  number,
  { tick: number; main: DeathStatus; family: DeathStatus | null }
>();

function statusOf(state: SimState, p: Patient) {
  const hit = statusCache.get(p.id);
  if (hit && hit.tick === state.tick) return hit;
  const d = p.death!;
  const entry = {
    tick: state.tick,
    main: deathStatus(state, p),
    family:
      !d.expected && d.familyTold === null && d.verified !== null
        ? deathStepStatus(state, p, "family")
        : null,
  };
  statusCache.set(p.id, entry);
  if (statusCache.size > 64) {
    for (const id of statusCache.keys()) if (!state.patients[id]) statusCache.delete(id);
  }
  return entry;
}

/** The way the trolley last moved, so it keeps facing that way when it stops. */
const heading = new Map<number, { dx: number; dy: number }>();

function headingOf(a: { id: number; x: number; y: number; prevX: number; prevY: number }) {
  const dx = a.x - a.prevX;
  const dy = a.y - a.prevY;
  const len = Math.hypot(dx, dy);
  if (len > 1e-6) heading.set(a.id, { dx: dx / len, dy: dy / len });
  return heading.get(a.id) ?? { dx: 0, dy: 1 };
}

interface Shape {
  /** Body size in pixels, lengthways along the bed or trolley. */
  w: number;
  h: number;
  /** Curtains round the bed: their size in pixels, or null. */
  curtains: { w: number; h: number } | null;
}

function shapeOf(state: SimState, p: Patient): Shape {
  if (p.stage === "to_mortuary") {
    const { dx, dy } = headingOf(p);
    return Math.abs(dx) > Math.abs(dy)
      ? { w: 32, h: 18, curtains: null }
      : { w: 18, h: 32, curtains: null };
  }
  const bed = p.bed === null ? undefined : state.objects[p.bed];
  if (!bed) return { w: 16, h: 26, curtains: { w: T + 10, h: T * 1.4 } };
  const r = objectRect(bed);
  const along = r.w > r.h;
  return { w: along ? 26 : 16, h: along ? 16 : 26, curtains: bedCurtainSize(bed) };
}

/** Curtains round a bed: their size in pixels, centred on it. */
export function bedCurtainSize(bed: PlacedObject): { w: number; h: number } {
  const r = objectRect(bed);
  return { w: r.w * T + 8, h: r.h * T + 8 };
}

/** Curtains drawn right round a bed: a faint screen with pleats along each side. */
export function drawBedCurtains(g: Graphics, size: { w: number; h: number }): void {
  const { w: cw, h: ch } = size;
  g.roundRect(-cw / 2, -ch / 2, cw, ch, 6).fill({ color: CURTAIN_COLOUR, alpha: 0.18 });
  const pleat = 6;
  for (let x = -cw / 2; x < cw / 2 - 1; x += pleat) {
    const len = Math.min(pleat - 2, cw / 2 - x);
    g.rect(x, -ch / 2 - 1.5, len, 3).fill(CURTAIN_COLOUR);
    g.rect(x, ch / 2 - 1.5, len, 3).fill(CURTAIN_COLOUR);
  }
  for (let y = -ch / 2; y < ch / 2 - 1; y += pleat) {
    const len = Math.min(pleat - 2, ch / 2 - y);
    g.rect(-cw / 2 - 1.5, y, 3, len).fill(CURTAIN_COLOUR);
    g.rect(cw / 2 - 1.5, y, 3, len).fill(CURTAIN_COLOUR);
  }
}

/** What the drawing depends on, so it's only redrawn when that changes. */
export function deceasedLook(state: SimState, p: Patient, selected: boolean): string {
  if (p.stage === "in_mortuary")
    return `m|${selected}|${tagColour(state, p)}|${tagSpot(state, p).x}`;
  const s = shapeOf(state, p);
  const down = p.stage === "to_mortuary" && headingOf(p).dy > 0;
  return `d|${selected}|${p.stage}|${down}|${s.w}|${s.curtains?.w}x${s.curtains?.h}|${p.death!.lastOffices !== null}|${pips(state, p).join(",")}`;
}

/** Each step's pip: "done", "todo", or the progress of a step in hand. */
function pips(state: SimState, p: Patient): string[] {
  const { main, family } = statusOf(state, p);
  return deathSteps(p).map((step) => {
    if (deathStepDone(p, step)) return "done";
    if (step === main.step) return main.progress;
    if (step === "family" && family) return family.progress;
    return "todo";
  });
}

export function drawDeceased(g: Graphics, state: SimState, p: Patient, selected: boolean): void {
  if (p.stage === "in_mortuary") {
    drawDrawerTag(g, state, p, selected);
    return;
  }
  const shape = shapeOf(state, p);
  const { w, h, curtains } = shape;
  if (curtains) drawBedCurtains(g, curtains);
  if (selected) {
    g.roundRect(-w / 2 - 4, -h / 2 - 4, w + 8, h + 8, 7).stroke({
      width: 2.5,
      color: SELECTED_RING,
    });
  }
  const along = w > h;
  if (p.stage === "to_mortuary") {
    // A concealment trolley: a steel frame with a fitted cover.
    g.roundRect(-w / 2, -h / 2, w, h, 4)
      .fill(0x9aa3ad)
      .stroke({ width: 1.5, color: 0x5b636c });
    g.roundRect(-w / 2 + 3, -h / 2 + 3, w - 6, h - 6, 5).fill(0x5d6b7a);
    if (along) g.rect(-w / 2 + 5, -1, w - 10, 2).fill({ color: 0xffffff, alpha: 0.25 });
    else g.rect(-1, -h / 2 + 5, 2, h - 10).fill({ color: 0xffffff, alpha: 0.25 });
  } else if (p.death!.lastOffices === null) {
    // Still in the bed, under its blanket, pillow at the head.
    if (along) g.roundRect(-w / 2, -h / 2 + 2, 7, h - 4, 3).fill(0xf2f4f6);
    else g.roundRect(-w / 2 + 2, -h / 2, w - 4, 7, 3).fill(0xf2f4f6);
    if (along)
      g.roundRect(-w / 2 + 5, -h / 2, w - 5, h, 4)
        .fill(BLANKET)
        .stroke({ width: 1.5, color: OUTLINE });
    else
      g.roundRect(-w / 2, -h / 2 + 5, w, h - 5, 4)
        .fill(BLANKET)
        .stroke({ width: 1.5, color: OUTLINE });
  } else {
    // Last offices done: a clean white sheet, with the identification label.
    g.roundRect(-w / 2, -h / 2, w, h, 5)
      .fill(SHEET)
      .stroke({ width: 1.5, color: OUTLINE });
    if (along) g.rect(w / 2 - 7, -3, 4, 6).fill(0xf2c94c);
    else g.rect(-3, h / 2 - 7, 6, 4).fill(0xf2c94c);
  }
  // Above them, or for a trolley heading down the screen, below it (the porter is behind).
  const pipsBelow = p.stage === "to_mortuary" && !along && headingOf(p).dy > 0;
  drawPips(g, state, p, pipsBelow ? h / 2 + 9 : -(curtains ? curtains.h / 2 : h / 2) - 9);
}

/** The strip of step pips, centred above them at height `y`. */
function drawPips(g: Graphics, state: SimState, p: Patient, y: number): void {
  const all = pips(state, p);
  const size = 6;
  const gap = 3;
  const width = all.length * size + (all.length - 1) * gap;
  const x0 = -width / 2;
  g.roundRect(x0 - 3, y - size / 2 - 3, width + 6, size + 6, 4).fill({ color: DARK, alpha: 0.85 });
  all.forEach((pip, i) => {
    const x = x0 + i * (size + gap);
    if (pip === "done") g.rect(x, y - size / 2, size, size).fill(0xdfe3e8);
    else if (pip === "todo")
      g.rect(x + 0.75, y - size / 2 + 0.75, size - 1.5, size - 1.5).stroke({
        width: 1.5,
        color: 0x6b737c,
      });
    else
      g.rect(x - 1, y - size / 2 - 1, size + 2, size + 2).fill(
        PROGRESS_COLOURS[pip as DeathProgress],
      );
  });
  if (all.includes("blocked")) {
    // Needs the player: a red "!" beside the strip.
    const bx = width / 2 + 11;
    g.circle(bx, y, 6.5).fill(PROGRESS_COLOURS.blocked).stroke({ width: 1, color: DARK });
    g.rect(bx - 1, y - 4, 2, 5).fill(DARK);
    g.rect(bx - 1, y + 2.5, 2, 1.5).fill(DARK);
  }
}

// ---------- In the mortuary ----------

/** The centre of their fridge drawer, in tiles, or their own position if it's gone. */
export function tagSpot(state: SimState, p: Patient): Point {
  const f = p.death?.fridge;
  const fridge = f ? state.objects[f.objectId] : undefined;
  if (!f || !fridge) return { x: p.x, y: p.y };
  const r = objectRect(fridge);
  // Three drawers along the unit's length.
  const t = (f.slot + 0.5) / 3;
  return r.w >= r.h
    ? { x: r.x - 0.5 + r.w * t, y: r.y - 0.5 + r.h / 2 }
    : { x: r.x - 0.5 + r.w / 2, y: r.y - 0.5 + r.h * t };
}

function tagColour(state: SimState, p: Patient): number {
  const s = statusOf(state, p).main;
  if (s.step === "release") return p.death!.coroner ? CORONER : AWAITING_COLLECTION;
  return PROGRESS_COLOURS[s.progress];
}

function drawDrawerTag(g: Graphics, state: SimState, p: Patient, selected: boolean): void {
  // Drawn relative to where the layer places them (p.x, p.y).
  const spot = tagSpot(state, p);
  const ox = (spot.x - p.x) * T;
  const oy = (spot.y - p.y) * T;
  const colour = tagColour(state, p);
  if (selected)
    g.roundRect(ox - 10, oy - 8, 20, 16, 4).stroke({ width: 2.5, color: SELECTED_RING });
  g.roundRect(ox - 7, oy - 5, 14, 10, 2)
    .fill(colour)
    .stroke({ width: 1.5, color: DARK });
  g.rect(ox - 4, oy - 1, 8, 2).fill({ color: DARK, alpha: 0.6 });
  if (colour === PROGRESS_COLOURS.blocked) {
    g.circle(ox + 9, oy - 7, 5)
      .fill(colour)
      .stroke({ width: 1, color: DARK });
    g.rect(ox + 8.25, oy - 10, 1.5, 3.5).fill(DARK);
    g.rect(ox + 8.25, oy - 5.5, 1.5, 1.2).fill(DARK);
  }
}

// ---------- Others involved ----------

/**
 * A porter wheeling a covered trolley walks behind it: how far to shift
 * them from the trolley (in tiles), or null if they aren't.
 */
export function pushOffset(state: SimState, s: Staff): Point | null {
  const job = s.jobId === null ? undefined : state.jobs[s.jobId];
  if (job?.kind !== "to_mortuary" || job.state !== "working" || job.patientId === null) return null;
  const p = state.patients[job.patientId];
  if (!p || p.stage !== "to_mortuary") return null;
  const { dx, dy } = headingOf(p);
  return { x: -dx * 0.95, y: -dy * 0.95 };
}

/** The families being told, as a look string: which sofas are in use. */
export function familiesLook(state: SimState): string {
  return familySofas(state)
    .map((o) => o.id)
    .join(",");
}

function familySofas(state: SimState) {
  const out = [];
  for (const job of Object.values(state.jobs)) {
    if (job.kind !== "break_news" || job.state !== "working" || job.objectId === null) continue;
    const sofa = state.objects[job.objectId];
    if (sofa) out.push(sofa);
  }
  return out;
}

/** Two relatives sitting on each sofa where a family is being told. */
export function drawFamilies(g: Graphics, state: SimState): void {
  for (const sofa of familySofas(state)) {
    const r = objectRect(sofa);
    const seats =
      r.w >= r.h
        ? [
            { x: r.x + 0.5, y: r.y + 0.5 },
            { x: r.x + r.w - 0.5, y: r.y + 0.5 },
          ]
        : [
            { x: r.x + 0.5, y: r.y + 0.5 },
            { x: r.x + 0.5, y: r.y + r.h - 0.5 },
          ];
    for (const s of seats) {
      g.circle(s.x * T, s.y * T, 7)
        .fill(FAMILY)
        .stroke({ width: 2, color: 0xffffff });
    }
  }
}
