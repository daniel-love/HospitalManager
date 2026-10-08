/**
 * Wires the pieces together: SimState + fixed-step loop + renderer + camera
 * and build controls + UI signals. Owns the per-frame callback and is the one
 * place that applies player commands to the state.
 *
 * In plan mode, commands go into the build plan instead (see sim/plan.ts), and
 * the map, tools and inspector all show the plan preview ("viewState").
 */
import { equipmentById, objectDef, roomById } from "@data/catalogue";
import { autosave } from "@save/saveManager";
import { applyCommand, type Command, type CommandResult } from "@sim/commands";
import { addToPlan, buildPreview, commitPlan, planDiff, type PlanPreview } from "@sim/plan";
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
  planning,
  planSummary,
  saveDialogOpen,
  showToast,
  type InspectorData,
} from "@ui/store";
import { tileHelp } from "@ui/help";
import { BuildController } from "./buildController";
import { FixedStepLoop, type Speed } from "./loop";
import { describeAccess, formatMoney } from "./tools";

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
  /** The plan applied to a copy of the state; null when there's no plan. */
  private preview: PlanPreview | null = null;

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
    // The build tools see (and edit) the plan preview while planning.
    this.build = new BuildController(renderer, this);
    this.lastDay = clockFromTick(state.tick).day;
    if (state.plan.length > 0) this.rebuildPreview();
    window.addEventListener("keydown", (e) => this.onKey(e));
    renderer.app.ticker.add((t) => this.frame(t.deltaMS));
    this.publishHud();
  }

  /** What the map shows: the plan preview while planning, otherwise the real hospital. */
  get viewState(): SimState {
    return planning.value && this.preview ? this.preview.state : this.state;
  }

  /**
   * Applies a player command (or, in plan mode, adds it to the plan), updating
   * the view. `quiet` suppresses error toasts.
   */
  apply(cmd: Command, quiet = false): CommandResult {
    const result = planning.value
      ? addToPlan(this.state, this.ensurePreview(), cmd)
      : applyCommand(this.state, cmd);
    if (result.ok) {
      mapHelp.value = null;
      this.renderer.layoutChanged(result.changed);
      // Real building can get in the way of planned steps (or shift item ids).
      if (!planning.value && this.state.plan.length > 0) this.rebuildPreview();
      this.refreshPlanView();
      this.publishInspector();
      this.publishHud();
    } else if (!quiet) {
      showToast(result.error ?? "Can't do that", "error");
    }
    return result;
  }

  /** Enters or leaves plan mode. The plan itself is kept either way. */
  setPlanning(on: boolean): void {
    if (on === planning.value) return;
    if (on) this.rebuildPreview();
    planning.value = on;
    document.body.classList.toggle("planning", on);
    this.renderer.setState(this.viewState);
    this.refreshPlanView();
    this.build.refresh();
    this.publishInspector();
  }

  undoPlan(): void {
    if (this.state.plan.length === 0) return;
    this.state.plan.pop();
    this.rebuildPreview();
  }

  clearPlan(): void {
    this.state.plan = [];
    this.rebuildPreview();
  }

  /** Builds the whole plan for real (if affordable) and leaves plan mode. */
  buildPlan(): void {
    const result = commitPlan(this.state);
    if (!result.ok) {
      const cost = this.preview?.cost ?? 0;
      showToast(
        cost > this.state.money
          ? `The plan costs ${formatMoney(cost)}; you have ${formatMoney(this.state.money)}`
          : result.error,
        "error",
      );
      return;
    }
    this.preview = null;
    this.setPlanning(false);
    this.renderer.setState(this.state);
    this.refreshPlanView();
    this.publishInspector();
    this.publishHud();
    const what = result.steps === 1 ? "1 planned change" : `${result.steps} planned changes`;
    showToast(`Built ${what} for ${formatMoney(result.cost)}`);
  }

  /** Replaces the running game, e.g. after loading. Pauses so the player can get their bearings. */
  loadState(state: SimState): void {
    this.state = state;
    this.lastDay = clockFromTick(state.tick).day;
    this.selectedTile = null;
    this.preview = null;
    planning.value = false;
    document.body.classList.remove("planning");
    if (state.plan.length > 0) this.rebuildPreview();
    this.refreshPlanView();
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

  private ensurePreview(): PlanPreview {
    if (!this.preview) this.rebuildPreview();
    return this.preview!;
  }

  /** Recomputes the preview from the real state, dropping steps that no longer fit. */
  private rebuildPreview(): void {
    const { preview, dropped } = buildPreview(this.state);
    this.preview = preview;
    if (dropped > 0) {
      const what =
        dropped === 1
          ? "1 planned change no longer fits and was"
          : `${dropped} planned changes no longer fit and were`;
      showToast(`${what} removed from the plan`, "error");
    }
    if (planning.value) this.renderer.setState(preview.state);
    this.refreshPlanView();
    this.publishInspector();
  }

  /** Updates the blueprint tint and the plan bar. */
  private refreshPlanView(): void {
    const steps = this.state.plan.length;
    planSummary.value = { steps, cost: steps > 0 ? (this.preview?.cost ?? 0) : 0 };
    this.renderer.setPlanOverlay(
      planning.value && this.preview ? planDiff(this.state, this.preview.state) : null,
    );
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
    const content = tileHelp(this.viewState, FLOOR, tile.x, tile.y);
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
      rooms: this.viewState.rooms.length,
      objects: Object.keys(this.viewState.objects).length,
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
    const grid = this.viewState.floors[FLOOR]!;
    const data: InspectorData = { tile };

    const obj = itemsAt(this.viewState, FLOOR, tile.x, tile.y)[0];
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

    const room = roomAt(this.viewState, FLOOR, tile.x, tile.y);
    const roomDef = room && roomById.get(room.typeId);
    if (room && roomDef) {
      const counts = new Map<string, number>();
      for (const id of room.objectIds) {
        const name = equipmentById.get(this.viewState.objects[id]!.defId)?.name;
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
    if (e.code === "KeyZ" && (e.ctrlKey || e.metaKey) && planning.value) {
      e.preventDefault();
      this.undoPlan();
      return;
    }
    // Leave browser shortcuts (⌘R, Ctrl+P…) alone.
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const speed = SPEED_KEYS[e.code];
    if (e.code === "KeyP") {
      this.setPlanning(!planning.value);
    } else if (speed !== undefined) {
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
