/**
 * Wires the pieces together: SimState + fixed-step loop + renderer + camera
 * and build controls + UI signals. Owns the per-frame callback and is the one
 * place that applies player commands to the state.
 */
import { equipmentById, objectDef, roomById } from "@data/catalogue";
import { autosave } from "@save/saveManager";
import { applyCommand, type Command, type CommandResult } from "@sim/commands";
import { tick } from "@sim/sim";
import { createSimState, type SimState } from "@sim/state";
import { clockFromTick, formatClock, TICKS_PER_SECOND_1X } from "@sim/time";
import { itemsAt } from "@sim/world/objects";
import { roomAt } from "@sim/world/rooms";
import { CameraControls, isPanModifier } from "@render/cameraControls";
import type { Renderer } from "@render/renderer";
import {
  buildTab,
  debugStats,
  debugVisible,
  hud,
  inspector,
  mapHelp,
  saveDialogOpen,
  showToast,
  type InspectorData,
} from "@ui/store";
import { tileHelp } from "@ui/help";
import { BuildController } from "./buildController";
import { FixedStepLoop, type Speed } from "./loop";
import { describeAccess } from "./tools";

const HUD_INTERVAL_MS = 100;
/** How long the mouse must rest on something before its help card appears. */
const HOVER_HELP_DELAY_MS = 350;
const FLOOR = 0;

/** Number keys map to speeds, as in the design doc (GAME_DESIGN §4). */
const SPEED_KEYS: Record<string, Speed> = {
  Digit1: 1,
  Digit2: 2,
  Digit3: 4,
  Digit4: 8,
};

export class Game {
  readonly loop: FixedStepLoop;
  private readonly controls: CameraControls;
  private readonly build: BuildController;
  /** Speed to resume to when unpausing with Space. */
  private resumeSpeed: Exclude<Speed, 0> = 1;
  private selectedTile: { x: number; y: number } | null = null;
  private lastHovered = "";
  private hoverSince = 0;
  private lastDay: number;

  // Debug stat accumulators.
  private fps = 0;
  private frameMs = 0;
  private simMs = 0;
  private ticksThisSecond = 0;
  private ticksPerSec = 0;
  private secondStart = 0;
  private ticksDropped = 0;
  private lastHud = 0;

  constructor(
    public state: SimState,
    private readonly renderer: Renderer,
  ) {
    this.loop = new FixedStepLoop(() => tick(this.state), { ticksPerSecond: TICKS_PER_SECOND_1X });
    this.controls = new CameraControls(renderer, {
      canPan: (e) => e.button !== 0 || isPanModifier(e) || !this.build.active,
      onClick: (button, x, y) => {
        renderer.setPointer({ x, y });
        this.onCanvasClick(button);
      },
    });
    this.build = new BuildController(renderer, this);
    this.lastDay = clockFromTick(state.tick).day;
    window.addEventListener("keydown", (e) => this.onKey(e));
    renderer.app.ticker.add((t) => this.frame(t.deltaMS));
    this.publishHud();
  }

  /** Applies a player command, updating the view. `quiet` suppresses error toasts. */
  apply(cmd: Command, quiet = false): CommandResult {
    const result = applyCommand(this.state, cmd);
    if (result.ok) {
      mapHelp.value = null;
      this.renderer.layoutChanged(result.changed);
      this.publishInspector();
      this.publishHud();
    } else if (!quiet) {
      showToast(result.error ?? "Can't do that", "error");
    }
    return result;
  }

  /** Replaces the running game, e.g. after loading. Pauses so the player can get their bearings. */
  loadState(state: SimState): void {
    this.state = state;
    this.lastDay = clockFromTick(state.tick).day;
    this.selectedTile = null;
    this.renderer.setState(state);
    this.build.refresh();
    this.setSpeed(0);
    this.publishInspector();
  }

  newGame(): void {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
    this.loadState(createSimState({ seed }));
  }

  setSpeed(speed: Speed): void {
    if (speed !== 0) this.resumeSpeed = speed;
    this.loop.setSpeed(speed);
    this.publishHud();
  }

  togglePause(): void {
    this.setSpeed(this.loop.paused ? this.resumeSpeed : 0);
  }

  /** Advances exactly one tick; only meaningful while paused. */
  stepOnce(): void {
    this.loop.stepOnce();
    this.publishHud();
  }

  /** Picks up a placed item with the move tool (from the inspector's Move button). */
  startMove(objectId: number): void {
    buildTab.value = "equipment";
    this.select(null);
    this.build.pickUp(objectId);
  }

  select(tile: { x: number; y: number } | null): void {
    this.selectedTile = tile;
    mapHelp.value = null;
    this.publishInspector();
  }

  destroy(): void {
    this.controls.destroy();
    this.build.destroy();
  }

  private frame(deltaMs: number): void {
    const stats = this.loop.advance(deltaMs);
    this.controls.update(deltaMs);

    // Keyboard panning and zooming move the tile under a still mouse.
    const h = this.renderer.hoveredTile;
    const hovered = h ? `${h.x},${h.y}` : "";
    if (hovered !== this.lastHovered) {
      this.lastHovered = hovered;
      this.hoverSince = performance.now();
      mapHelp.value = null;
      this.build.refresh();
    }
    this.updateHoverHelp();
    this.renderer.render(this.loop.alpha);

    const day = clockFromTick(this.state.tick).day;
    if (day !== this.lastDay) {
      this.lastDay = day;
      autosave(this.state).catch((err: unknown) => {
        console.error(err);
        showToast("Autosave failed", "error");
      });
    }

    // Exponential moving averages keep the debug numbers readable.
    this.fps += (1000 / Math.max(deltaMs, 0.001) - this.fps) * 0.1;
    this.frameMs += (deltaMs - this.frameMs) * 0.1;
    this.simMs += (stats.simMs - this.simMs) * 0.1;
    this.ticksThisSecond += stats.ticksRun;
    this.ticksDropped += stats.ticksDropped;

    const now = performance.now();
    if (now - this.secondStart >= 1000) {
      this.ticksPerSec = (this.ticksThisSecond * 1000) / (now - this.secondStart);
      this.ticksThisSecond = 0;
      this.secondStart = now;
    }
    if (now - this.lastHud >= HUD_INTERVAL_MS) {
      this.lastHud = now;
      this.publishHud();
    }
  }

  /** Shows a help card once the mouse has rested on a room, item or door. */
  private updateHoverHelp(): void {
    const tile = this.renderer.hoveredTile;
    const at = this.renderer.pointerScreen;
    if (this.build.active || this.controls.dragging || saveDialogOpen.value || !tile || !at) {
      if (mapHelp.value) mapHelp.value = null;
      return;
    }
    if (mapHelp.value || performance.now() - this.hoverSince < HOVER_HELP_DELAY_MS) return;
    const content = tileHelp(this.state, FLOOR, tile.x, tile.y);
    if (content) mapHelp.value = { ...at, content };
  }

  private publishHud(): void {
    hud.value = {
      clock: formatClock(clockFromTick(this.state.tick)),
      speed: this.loop.speed,
      money: this.state.money,
    };
    if (!debugVisible.value) return;
    const { camera } = this.renderer;
    const grid = this.state.floors[FLOOR]!;
    debugStats.value = {
      fps: this.fps,
      frameMs: this.frameMs,
      simMs: this.simMs,
      ticksPerSec: this.ticksPerSec,
      ticksDropped: this.ticksDropped,
      tick: this.state.tick,
      seed: this.state.seed,
      zoom: camera.zoom,
      camera: { x: camera.x, y: camera.y },
      hoveredTile: this.renderer.hoveredTile,
      chunksVisible: this.renderer.visibleChunkCount,
      mapSize: { width: grid.width, height: grid.height },
      rooms: this.state.rooms.length,
      objects: Object.keys(this.state.objects).length,
    };
  }

  /** Rebuilds the inspector panel for the selected tile. */
  private publishInspector(): void {
    const tile = this.selectedTile;
    if (!tile) {
      inspector.value = null;
      this.renderer.setSelection(null);
      return;
    }
    const grid = this.state.floors[FLOOR]!;
    const data: InspectorData = { tile };

    const obj = itemsAt(this.state, FLOOR, tile.x, tile.y)[0];
    const def = obj && objectDef(obj.defId);
    if (def) {
      data.object = {
        id: obj.id,
        movable: def.kind === "equipment",
        name: def.def.name,
        description: def.def.description,
        cost: def.def.cost,
        capabilities: def.kind === "equipment" ? def.def.capabilities : [],
        ...(def.kind === "equipment"
          ? { upkeep: def.def.upkeep, access: describeAccess(def.def.access) }
          : {}),
      };
    }

    const room = roomAt(this.state, FLOOR, tile.x, tile.y);
    const roomDef = room && roomById.get(room.typeId);
    if (room && roomDef) {
      const counts = new Map<string, number>();
      for (const id of room.objectIds) {
        const name = equipmentById.get(this.state.objects[id]!.defId)?.name;
        if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      data.room = {
        name: roomDef.name,
        department: roomDef.department,
        description: roomDef.description,
        size: `${room.bounds.w}×${room.bounds.h} (${room.tiles.length} m²)`,
        valid: room.valid,
        checks: room.checks,
        capabilities: room.capabilities,
        items: [...counts].map(([name, count]) => ({ name, count })),
      };
      this.renderer.setSelection(
        room.tiles.map((i) => ({ x: i % grid.width, y: Math.floor(i / grid.width) })),
      );
    } else {
      this.renderer.setSelection([tile]);
    }

    if (!data.object && !data.room) {
      this.selectedTile = null;
      inspector.value = null;
      this.renderer.setSelection(null);
      return;
    }
    inspector.value = data;
  }

  private onCanvasClick(button: number): void {
    if (button === 2) {
      if (!this.build.cancel()) this.select(null);
    } else if (button === 0 && !this.build.active) {
      this.select(this.renderer.hoveredTile);
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.repeat) return;
    const speed = SPEED_KEYS[e.code];
    if (speed !== undefined) {
      this.setSpeed(speed);
    } else if (e.code === "Space") {
      e.preventDefault();
      this.togglePause();
    } else if (e.code === "Period" && this.loop.paused) {
      this.stepOnce();
    } else if (e.code === "KeyR") {
      this.build.rotate();
    } else if (e.code === "Escape") {
      if (!this.build.cancel()) this.select(null);
    } else if (e.code === "F3" || e.code === "Backquote") {
      e.preventDefault();
      debugVisible.value = !debugVisible.value;
      this.publishHud();
    }
  }
}
