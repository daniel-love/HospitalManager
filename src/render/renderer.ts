/**
 * Owns the Pixi application and the world scene graph. Reads SimState but
 * never modifies it.
 *
 * Layer order (bottom to top): tiles (ground, zones, walls, doors) → objects
 * → cleaning marks → room labels → agents → overlays (selection, build
 * ghost, hover box).
 *
 * Frames are drawn on demand, not every tick of the display: render() only
 * draws when something visible has changed (the camera, the hovered tile,
 * the sim moving on, or one of the setters below), so a paused game sitting
 * still costs next to nothing. The game paces frames to 60 fps (FramePacer in
 * game/loop.ts).
 */
import { Application, Container, Graphics } from "pixi.js";
import { objectDef } from "@data/catalogue";
import type { Rotation, SimState } from "@sim/state";
import type { CoverageView } from "@sim/systems/monitoring";
import { inBounds } from "@sim/world/grid";
import { accessRequirements, footprintRect, isStandable } from "@sim/world/objects";
import { outlineTiles, type Rect } from "@sim/world/rect";
import { AgentLayer } from "./agentLayer";
import { CleaningLayer } from "./cleaningLayer";
import { Camera } from "./camera";
import { TILE_SIZE } from "./constants";
import { drawBlock, drawFixture, ObjectLayer } from "./objectLayer";
import {
  COVER_COLOURS,
  COVER_SEEN,
  GHOST_BAD,
  GHOST_OK,
  GHOST_REMOVE,
  PLAN_ADDED,
  PLAN_REMOVED,
  STAFF_COLOUR,
} from "./palette";
import { RoomLabelLayer } from "./roomLabelLayer";
import { TilemapLayer } from "./tilemapLayer";

export type GhostTone = "ok" | "bad" | "remove" | "neutral";

/** Preview of what the active build tool would do. */
export type Ghost =
  | { kind: "area"; rect: Rect; tone: GhostTone }
  | { kind: "outline"; rect: Rect; tone: GhostTone }
  | {
      kind: "object";
      defId: string;
      x: number;
      y: number;
      rotation: Rotation;
      tone: GhostTone;
      /** The object being moved, whose own tiles don't block its front. */
      ignoreId?: number;
    };

const TONES: Record<GhostTone, number> = {
  ok: GHOST_OK,
  bad: GHOST_BAD,
  remove: GHOST_REMOVE,
  neutral: 0xffffff,
};

export class Renderer {
  readonly camera: Camera;
  private readonly world = new Container();
  private tilemap: TilemapLayer;
  private readonly objects = new ObjectLayer();
  private readonly cleaning = new CleaningLayer();
  private readonly agents = new AgentLayer();
  private readonly labels = new RoomLabelLayer();
  private readonly overlay = new Container();
  private readonly selection = new Graphics();
  /** Blueprint tint over tiles a plan changes (plan mode only). */
  private readonly planOverlay = new Graphics();
  /** Council land (the public road), tinted while a build tool is selected. */
  private readonly publicLand = new Graphics();
  /** What nurse stations can see, and how well each bed is watched. */
  private readonly coverage = new Graphics();
  private readonly ghost = new Graphics();
  private readonly hoverBox = new Graphics();
  /** Tile under the mouse pointer, or null when off-map. */
  hoveredTile: { x: number; y: number } | null = null;
  /** Mouse position in screen pixels, or null when it's off the canvas. */
  pointerScreen: { x: number; y: number } | null = null;
  /** Set when something visible changes outside the frame fingerprint (see render()). */
  private dirty = true;
  /** Fingerprint of the last frame drawn. */
  private lastFrame = "";

  private constructor(
    readonly app: Application,
    private state: SimState,
  ) {
    const grid = state.floors[0]!;
    this.camera = new Camera({
      minZoom: 0.1,
      maxZoom: 4,
      bounds: { width: grid.width * TILE_SIZE, height: grid.height * TILE_SIZE },
    });
    this.camera.setViewport(app.screen.width, app.screen.height);
    this.camera.centreOn((grid.width * TILE_SIZE) / 2, (grid.height * TILE_SIZE) / 2);

    this.tilemap = new TilemapLayer(grid, state.site);
    this.hoverBox
      .rect(0, 0, TILE_SIZE, TILE_SIZE)
      .stroke({ width: 2, color: 0xffffff, alpha: 0.9, alignment: 1 });
    this.hoverBox.visible = false;
    this.publicLand.visible = false;
    this.drawPublicLand(state);
    this.overlay.addChild(
      this.publicLand,
      this.coverage,
      this.planOverlay,
      this.selection,
      this.ghost,
      this.hoverBox,
    );
    this.world.addChild(
      this.tilemap.container,
      this.objects.container,
      this.cleaning.container,
      this.labels.container,
      this.agents.container,
      this.overlay,
    );
    app.stage.addChild(this.world);
    this.syncContent();

    app.renderer.on("resize", (w: number, h: number) => this.camera.setViewport(w, h));
    // Text is drawn once its font has loaded.
    void document.fonts?.ready.then(() => (this.dirty = true));
  }

  /**
   * `antialias` smooths edges; at retina resolution it's the costliest part
   * of drawing and made Safari stall about once a second (see the player's
   * setting, ui/settings.ts).
   */
  static async create(
    parent: HTMLElement,
    state: SimState,
    opts: { antialias: boolean },
  ): Promise<Renderer> {
    const app = new Application();
    await app.init({
      resizeTo: window,
      background: 0x1d2a17,
      antialias: opts.antialias,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    parent.appendChild(app.canvas);
    // Draw on demand from render() rather than on every tick of the display.
    app.ticker.remove(app.render, app);
    return new Renderer(app, state);
  }

  get visibleChunkCount(): number {
    return this.tilemap.visibleChunkCount;
  }

  /**
   * Switches to a different state: after loading, starting anew, or swapping
   * between the real hospital and the plan preview. The camera only resets if
   * the map size changed.
   */
  setState(state: SimState): void {
    this.dirty = true;
    const old = this.state.floors[0]!;
    this.state = state;
    const grid = state.floors[0]!;
    this.tilemap.destroy();
    this.tilemap = new TilemapLayer(grid, state.site);
    this.world.addChildAt(this.tilemap.container, 0);
    this.objects.clear();
    this.cleaning.clear();
    this.agents.clear();
    if (grid.width !== old.width || grid.height !== old.height) {
      this.camera.setBounds(grid.width * TILE_SIZE, grid.height * TILE_SIZE);
    }
    this.setGhost(null);
    this.setSelection(null);
    this.drawPublicLand(state);
    this.syncContent();
  }

  /** Shows which land is the council's (not buildable), e.g. while a build tool is selected. */
  setPublicLand(visible: boolean): void {
    this.dirty = true;
    this.publicLand.visible = visible;
  }

  private drawPublicLand(state: SimState): void {
    const g = this.publicLand.clear();
    const site = state.site;
    if (!site) return;
    const T = TILE_SIZE;
    const top = site.pavements[0];
    const bottom = site.pavements[1];
    const band = { x: top.x, y: top.y, w: top.w, h: bottom.y + bottom.h - top.y };
    g.rect(band.x * T, band.y * T, band.w * T, band.h * T).fill({ color: GHOST_BAD, alpha: 0.1 });
    for (const y of [band.y, band.y + band.h]) {
      for (let x = band.x; x < band.x + band.w; x += 2) {
        g.rect(x * T, y * T - 1.5, T, 3).fill({ color: GHOST_BAD, alpha: 0.7 });
      }
    }
  }

  /** Call after a build command changed the layout. */
  layoutChanged(changed: Rect | null): void {
    this.dirty = true;
    if (changed) this.tilemap.markDirty(changed);
    this.syncContent();
  }

  setGhost(ghost: Ghost | null): void {
    this.dirty = true;
    const g = this.ghost.clear();
    if (!ghost) return;
    const colour = TONES[ghost.tone];
    const T = TILE_SIZE;
    if (ghost.kind === "area") {
      const { x, y, w, h } = ghost.rect;
      g.rect(x * T, y * T, w * T, h * T).fill({ color: colour, alpha: 0.22 });
      g.rect(x * T, y * T, w * T, h * T).stroke({ width: 2, color: colour, alignment: 1 });
    } else if (ghost.kind === "outline") {
      for (const t of outlineTiles(ghost.rect)) {
        g.rect(t.x * T, t.y * T, T, T).fill({ color: colour, alpha: 0.55 });
      }
    } else {
      const r = footprintRect(ghost.defId, ghost.x, ghost.y, ghost.rotation);
      const def = objectDef(ghost.defId);
      if (def?.kind === "door") {
        g.rect(r.x * T, r.y * T, r.w * T, r.h * T).fill({ color: colour, alpha: 0.6 });
      } else if (def && def.def.mount !== "floor") {
        drawFixture(g, r, ghost.rotation, def.def.mount, colour, 0.75);
        // Show the tile's outline too: fixtures are small and easy to lose.
        g.rect(r.x * T, r.y * T, r.w * T, r.h * T).stroke({
          width: 1.5,
          color: colour,
          alpha: 0.6,
        });
      } else if (def) {
        this.drawAccess(g, r, ghost);
        drawBlock(g, r, ghost.rotation, colour, 0.65, def.def.access);
      }
    }
  }

  /**
   * Outlines the tiles a ghost item needs clear: user tiles in green, staff
   * tiles in blue, and any that are blocked in red. Each tile shows its own
   * state, independent of whether the placement as a whole is valid.
   */
  private drawAccess(g: Graphics, r: Rect, ghost: Extract<Ghost, { kind: "object" }>): void {
    const T = TILE_SIZE;
    const grid = this.state.floors[0]!;
    const clear = (t: { x: number; y: number }) => isStandable(grid, t.x, t.y, ghost.ignoreId);
    for (const req of accessRequirements(ghost.defId, r, ghost.rotation)) {
      const okColour = req.who === "staff" ? STAFF_COLOUR : GHOST_OK;
      // When an "either side" rule is met, only the usable side(s) are shown.
      const met = req.options.filter((o) => o.every(clear));
      for (const t of (met.length > 0 ? met : req.options).flat()) {
        if (!inBounds(grid, t.x, t.y)) continue;
        const c = clear(t) ? okColour : GHOST_BAD;
        g.rect(t.x * T + 2, t.y * T + 2, T - 4, T - 4)
          .fill({ color: c, alpha: 0.15 })
          .stroke({ width: 1.5, color: c, alpha: 0.7 });
      }
    }
  }

  /**
   * Tints the tiles a plan would change: blue where it adds or alters
   * something, red where it removes something. Null clears it.
   */
  setPlanOverlay(diff: { added: number[]; removed: number[] } | null): void {
    this.dirty = true;
    const g = this.planOverlay.clear();
    if (!diff) return;
    const width = this.state.floors[0]!.width;
    const T = TILE_SIZE;
    const draw = (tiles: number[], colour: number) => {
      for (const i of tiles) {
        const x = i % width;
        const y = (i - x) / width;
        g.rect(x * T, y * T, T, T);
      }
      g.fill({ color: colour, alpha: 0.3 });
    };
    draw(diff.added, PLAN_ADDED);
    draw(diff.removed, PLAN_REMOVED);
  }

  /**
   * The coverage overlay: floor in sight of a nurse station tinted blue,
   * each bed that should be watched green (watched), amber (in sight, but the
   * station is empty) or red (out of sight), and stations ringed. Null hides it.
   */
  setCoverage(view: CoverageView | null): void {
    this.dirty = true;
    const g = this.coverage.clear();
    if (!view) return;
    const width = this.state.floors[0]!.width;
    const T = TILE_SIZE;
    for (const i of view.seen) {
      const x = i % width;
      g.rect(x * T, ((i - x) / width) * T, T, T);
    }
    g.fill({ color: COVER_SEEN, alpha: 0.16 });
    for (const b of view.beds) {
      const c = COVER_COLOURS[b.cover];
      g.rect(b.x * T + 1, b.y * T + 1, b.w * T - 2, b.h * T - 2)
        .fill({ color: c, alpha: 0.45 })
        .stroke({ width: 3, color: c, alpha: 0.95, alignment: 1 });
    }
    for (const s of view.stations) {
      const cx = (s.at.x + 0.5) * T;
      const cy = (s.at.y + 0.5) * T;
      g.circle(cx, cy, T * 0.38).stroke({ width: 3, color: COVER_SEEN, alpha: 0.95 });
      // Central monitors: a second ring, in the remote-coverage colour.
      if (s.central) {
        g.circle(cx, cy, T * 0.5).stroke({ width: 2, color: COVER_COLOURS.remote, alpha: 0.95 });
      }
      if (s.staffed) g.circle(cx, cy, T * 0.18).fill({ color: COVER_SEEN, alpha: 0.95 });
    }
  }

  /** Highlights a set of tiles (the selected room), or clears with null. */
  setSelection(tiles: { x: number; y: number }[] | null): void {
    this.dirty = true;
    const g = this.selection.clear();
    if (!tiles) return;
    for (const t of tiles) {
      g.rect(t.x * TILE_SIZE, t.y * TILE_SIZE, TILE_SIZE, TILE_SIZE).fill({
        color: 0xffffff,
        alpha: 0.18,
      });
    }
  }

  /** Updates the hovered tile from a screen position (or clears it with null). */
  setPointer(screen: { x: number; y: number } | null): void {
    this.pointerScreen = screen;
    if (!screen) {
      this.hoveredTile = null;
      return;
    }
    const w = this.camera.screenToWorld(screen.x, screen.y);
    const tx = Math.floor(w.x / TILE_SIZE);
    const ty = Math.floor(w.y / TILE_SIZE);
    this.hoveredTile = inBounds(this.state.floors[0]!, tx, ty) ? { x: tx, y: ty } : null;
  }

  /** Highlights a patient or member of staff (null for none). */
  setSelectedAgent(id: number | null): void {
    this.dirty = true;
    this.agents.selectedId = id;
  }

  /**
   * Draws a frame. Agents come from `live` (the real hospital, even while the
   * map shows a plan preview) and are drawn `alpha` of the way between the
   * last two sim ticks.
   */
  render(alpha: number, live: SimState): void {
    const { camera } = this;
    const hovered = this.hoveredTile ? `${this.hoveredTile.x},${this.hoveredTile.y}` : "";
    // Hiring or dismissing while paused changes who's on the map without a tick.
    const people = `${Object.keys(live.patients).length},${Object.keys(live.staff).length},${Object.keys(live.ambulances).length}`;
    const frame = `${camera.x},${camera.y},${camera.zoom},${camera.viewportWidth},${camera.viewportHeight}|${hovered}|${live.tick},${alpha}|${people}`;
    if (!this.dirty && frame === this.lastFrame) return;
    this.dirty = false;
    this.lastFrame = frame;
    this.world.scale.set(camera.zoom);
    this.world.position.set(
      camera.viewportWidth / 2 - camera.x * camera.zoom,
      camera.viewportHeight / 2 - camera.y * camera.zoom,
    );
    this.tilemap.update(camera.visibleWorldRect(), camera.zoom);
    this.objects.update(camera.zoom);
    this.cleaning.update(live);
    this.agents.update(live, alpha);
    this.labels.update(camera.zoom);

    if (this.hoveredTile) {
      this.hoverBox.visible = true;
      this.hoverBox.position.set(this.hoveredTile.x * TILE_SIZE, this.hoveredTile.y * TILE_SIZE);
    } else {
      this.hoverBox.visible = false;
    }
    this.app.render();
  }

  private syncContent(): void {
    this.objects.sync(this.state);
    this.labels.sync(this.state.rooms);
  }
}
