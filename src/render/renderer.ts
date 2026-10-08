/**
 * Owns the Pixi application and the world scene graph. Reads SimState but
 * never modifies it.
 *
 * Layer order (bottom to top): tiles (ground, zones, walls, doors) → objects
 * → room labels → overlays (selection, build ghost, hover box).
 */
import { Application, Container, Graphics } from "pixi.js";
import { objectDef } from "@data/catalogue";
import type { Rotation, SimState } from "@sim/state";
import { inBounds } from "@sim/world/grid";
import { accessRequirements, footprintRect, isStandable } from "@sim/world/objects";
import { outlineTiles, type Rect } from "@sim/world/rect";
import { Camera } from "./camera";
import { TILE_SIZE } from "./constants";
import { drawBlock, drawFixture, ObjectLayer } from "./objectLayer";
import {
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
  private readonly labels = new RoomLabelLayer();
  private readonly overlay = new Container();
  private readonly selection = new Graphics();
  /** Blueprint tint over tiles a plan changes (plan mode only). */
  private readonly planOverlay = new Graphics();
  private readonly ghost = new Graphics();
  private readonly hoverBox = new Graphics();
  /** Tile under the mouse pointer, or null when off-map. */
  hoveredTile: { x: number; y: number } | null = null;
  /** Mouse position in screen pixels, or null when it's off the canvas. */
  pointerScreen: { x: number; y: number } | null = null;

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

    this.tilemap = new TilemapLayer(grid);
    this.hoverBox
      .rect(0, 0, TILE_SIZE, TILE_SIZE)
      .stroke({ width: 2, color: 0xffffff, alpha: 0.9, alignment: 1 });
    this.hoverBox.visible = false;
    this.overlay.addChild(this.planOverlay, this.selection, this.ghost, this.hoverBox);
    this.world.addChild(
      this.tilemap.container,
      this.objects.container,
      this.labels.container,
      this.overlay,
    );
    app.stage.addChild(this.world);
    this.syncContent();

    app.renderer.on("resize", (w: number, h: number) => this.camera.setViewport(w, h));
  }

  static async create(parent: HTMLElement, state: SimState): Promise<Renderer> {
    const app = new Application();
    await app.init({
      resizeTo: window,
      background: 0x1d2a17,
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    });
    parent.appendChild(app.canvas);
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
    const old = this.state.floors[0]!;
    this.state = state;
    const grid = state.floors[0]!;
    this.tilemap.destroy();
    this.tilemap = new TilemapLayer(grid);
    this.world.addChildAt(this.tilemap.container, 0);
    this.objects.clear();
    if (grid.width !== old.width || grid.height !== old.height) {
      this.camera.setBounds(grid.width * TILE_SIZE, grid.height * TILE_SIZE);
    }
    this.setGhost(null);
    this.setSelection(null);
    this.syncContent();
  }

  /** Call after a build command changed the layout. */
  layoutChanged(changed: Rect | null): void {
    if (changed) this.tilemap.markDirty(changed);
    this.syncContent();
  }

  setGhost(ghost: Ghost | null): void {
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

  /** Highlights a set of tiles (the selected room), or clears with null. */
  setSelection(tiles: { x: number; y: number }[] | null): void {
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

  /**
   * Draws a frame. `_alpha` is the fraction between sim ticks, used for agent
   * interpolation once agents exist.
   */
  render(_alpha: number): void {
    const { camera } = this;
    this.world.scale.set(camera.zoom);
    this.world.position.set(
      camera.viewportWidth / 2 - camera.x * camera.zoom,
      camera.viewportHeight / 2 - camera.y * camera.zoom,
    );
    this.tilemap.update(camera.visibleWorldRect(), camera.zoom);
    this.objects.update(camera.zoom);
    this.labels.update(camera.zoom);

    if (this.hoveredTile) {
      this.hoverBox.visible = true;
      this.hoverBox.position.set(this.hoveredTile.x * TILE_SIZE, this.hoveredTile.y * TILE_SIZE);
    } else {
      this.hoverBox.visible = false;
    }
  }

  private syncContent(): void {
    this.objects.sync(this.state);
    this.labels.sync(this.state.rooms);
  }
}
