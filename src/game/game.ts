/**
 * Wires the pieces together: SimState + fixed-step loop + renderer + camera
 * and build controls + UI signals. Owns the per-frame callback and is the one
 * place that applies player commands to the state.
 *
 * In plan mode, commands go into the build plan instead (see sim/plan.ts), and
 * the map, tools and inspector all show the plan preview ("viewState").
 */
import { equipmentById, objectDef, roomById } from "@data/catalogue";
import {
  autosave,
  loadGame,
  rememberLastSave,
  saveGame,
  saveResumeSnapshot,
} from "@save/saveManager";
import { applyCommand, type Command, type CommandResult } from "@sim/commands";
import { addToPlan, buildPreview, commitPlan, planDiff, type PlanPreview } from "@sim/plan";
import { tick } from "@sim/sim";
import { createSimState, type SimState } from "@sim/state";
import { siteView } from "@sim/world/site";
import { coverageView, stationsSeeing, bedCover } from "@sim/systems/monitoring";
import { applyStaffCommand, type StaffCommand } from "@sim/systems/staffing";
import {
  clockFromTick,
  formatClock,
  START_MINUTE_OF_DAY,
  TICKS_PER_MINUTE,
  TICKS_PER_SECOND_1X,
} from "@sim/time";
import { itemsAt } from "@sim/world/objects";
import { roomAt } from "@sim/world/rooms";
import { CameraControls, isPanModifier } from "@render/cameraControls";
import { TILE_SIZE } from "@render/constants";
import type { Renderer } from "@render/renderer";
import {
  buildTab,
  coverageOverlay,
  debugStats,
  debugVisible,
  hud,
  inspector,
  mapHelp,
  notifications,
  patientTable,
  peopleDialog,
  planning,
  planSummary,
  report,
  roster,
  saveDialogOpen,
  showToast,
  sidePanel,
  staffTable,
  type InspectorData,
} from "@ui/store";
import { tileHelp } from "@ui/help";
import { autosaveOption, settings, settingsOpen } from "@ui/settings";
import { BuildController } from "./buildController";
import {
  describePatient,
  describePatientTable,
  describeReport,
  describeRoster,
  describeStaff,
  describeStaffTable,
  fourHourShare,
  patientsInDept,
} from "./describe";
import { FixedStepLoop, type Speed } from "./loop";
import { describeAccess, formatMoney } from "./tools";

const HUD_INTERVAL_MS = 100;
/** Panels with lots of detail (inspector, staff, reports) refresh less often. */
const PANEL_INTERVAL_MS = 250;
/** Notifications kept in the feed. */
const MAX_NOTIFICATIONS = 40;
/** How close (in tiles) a click must be to a patient or staff member to select them. */
const AGENT_PICK_RADIUS = 0.6;
/** How long the mouse must rest on something before its help card appears. */
const HOVER_HELP_DELAY_MS = 350;
const FLOOR = 0;

const COVER_TEXT = {
  watched: { text: "Watched from a staffed nurse station", ok: true },
  remote: { text: "Covered by a staffed central monitor", ok: true },
  unstaffed: { text: "In sight of a nurse station, but nobody is at it", ok: false },
  blind: { text: "Not visible from any nurse station", ok: false },
} as const;

/** Number keys map to speeds, as in the design doc (GAME_DESIGN §4). */
const SPEED_KEYS: Record<string, Speed> = {
  Digit1: 1,
  Digit2: 2,
  Digit3: 4,
  Digit4: 8,
  Digit5: 16,
};

export class Game {
  readonly loop: FixedStepLoop;
  private readonly controls: CameraControls;
  private readonly build: BuildController;
  /** Speed to resume to when unpausing with Space. */
  private resumeSpeed: Exclude<Speed, 0> = 1;
  private selectedTile: { x: number; y: number } | null = null;
  /** Selected patient or member of staff (takes priority over the tile). */
  private selectedAgent: number | null = null;
  private nextNotification = 1;
  private lastPanels = 0;
  private lastHovered = "";
  private hoverSince = 0;
  /** Name the hospital was last saved or loaded under; autosaves use it too. */
  saveName = "My hospital";
  /** Tick of the last save or load, so an unchanged game isn't autosaved again. */
  private savedTick: number;
  /** Which autosave interval the clock was in when last checked (see autosavePeriod). */
  private autosavePeriod: number | null;
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
    // Every game starts paused, so the player can look around first.
    this.loop.setSpeed(0);
    this.controls = new CameraControls(renderer, {
      canPan: (e) => e.button !== 0 || isPanModifier(e) || !this.build.active,
      onClick: (button, x, y) => {
        renderer.setPointer({ x, y });
        this.onCanvasClick(button);
      },
    });
    // The build tools see (and edit) the plan preview while planning.
    this.build = new BuildController(renderer, this);
    this.savedTick = state.tick;
    this.autosavePeriod = this.currentAutosavePeriod();
    // A new interval starts the count afresh rather than saving straight away.
    settings.subscribe(() => (this.autosavePeriod = this.currentAutosavePeriod()));
    if (state.plan.length > 0) this.rebuildPreview();
    window.addEventListener("keydown", (e) => this.onKey(e));
    // Keep the game for resuming when the tab is hidden, reloaded or closed.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") this.saveForResume();
    });
    window.addEventListener("pagehide", () => this.saveForResume());
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
      this.refreshCoverage();
      this.publishInspector();
      this.publishHud();
    } else if (!quiet) {
      showToast(result.error ?? "Can't do that", "error");
    }
    return result;
  }

  /**
   * Hires or dismisses staff. Always acts on the real hospital, even in
   * plan mode: plans are for building.
   */
  applyStaff(cmd: StaffCommand): void {
    const result = applyStaffCommand(this.state, cmd);
    if (!result.ok) {
      showToast(result.error, "error");
      return;
    }
    if (cmd.type === "dismiss_staff") {
      showToast(`${result.staff.name} has left`);
      if (this.selectedAgent === cmd.id) this.select(null);
    }
    this.drainEvents();
    this.refreshPanels();
    this.publishHud();
  }

  /** Centres the camera on a tile (e.g. from a notification). */
  focus(at: { x: number; y: number }): void {
    this.renderer.camera.centreOn((at.x + 0.5) * TILE_SIZE, (at.y + 0.5) * TILE_SIZE);
  }

  /** Selects someone and moves the camera to them (e.g. from the People dialog). */
  showAgent(id: number): void {
    const a = this.state.patients[id] ?? this.state.staff[id];
    if (!a) return;
    this.selectAgent(id);
    this.focus({ x: Math.round(a.x), y: Math.round(a.y) });
  }

  /** Selects a patient or member of staff and shows them in the inspector. */
  selectAgent(id: number | null): void {
    this.selectedAgent = id;
    this.selectedTile = null;
    this.renderer.setSelectedAgent(id);
    mapHelp.value = null;
    this.publishInspector();
  }

  /** Shows or hides the coverage overlay (which beds nurse stations can see). */
  toggleCoverage(): void {
    coverageOverlay.value = !coverageOverlay.value;
    this.refreshCoverage();
  }

  /** Redraws the coverage overlay from what the map shows (or hides it). */
  private refreshCoverage(): void {
    this.renderer.setCoverage(coverageOverlay.value ? coverageView(this.viewState) : null);
  }

  /** Enters or leaves plan mode. The plan itself is kept either way. */
  setPlanning(on: boolean): void {
    if (on === planning.value) return;
    if (on) this.rebuildPreview();
    planning.value = on;
    document.body.classList.toggle("planning", on);
    this.renderer.setState(this.viewState);
    this.refreshPlanView();
    this.refreshCoverage();
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

  /** Saves under a name (overwriting a save of the same name) and makes it the one to resume. */
  async save(name: string): Promise<void> {
    await saveGame(this.state, name);
    this.saveName = name;
    this.savedTick = this.state.tick;
  }

  /** Loads a save from the list. */
  async load(id: string): Promise<void> {
    const { name, state } = await loadGame(id);
    this.loadState(state, name);
  }

  /**
   * Replaces the running game, e.g. after loading. Pauses so the player can get
   * their bearings. `name` is what the save was called, if it came from one.
   */
  loadState(state: SimState, name = "My hospital"): void {
    this.state = state;
    this.saveName = name;
    this.savedTick = state.tick;
    this.autosavePeriod = this.currentAutosavePeriod();
    this.selectedTile = null;
    this.selectedAgent = null;
    this.renderer.setSelectedAgent(null);
    this.preview = null;
    notifications.value = [];
    planning.value = false;
    document.body.classList.remove("planning");
    if (state.plan.length > 0) this.rebuildPreview();
    this.refreshPlanView();
    this.renderer.setState(state);
    this.refreshCoverage();
    this.build.refresh();
    this.setSpeed(0);
    this.publishInspector();
  }

  newGame(): void {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
    const state = createSimState({ seed, site: true });
    this.loadState(state);
    if (state.site) this.focus(siteView(state.site));
    // Until it's saved, a reload starts afresh rather than resuming the old hospital.
    rememberLastSave(null);
  }

  /** Sets the population the hospital serves (a sandbox setting saved with the game). */
  setCatchment(population: number): void {
    this.state.settings.catchment = population;
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
    this.selectedAgent = null;
    this.renderer.setSelectedAgent(null);
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

  /**
   * Counts autosave intervals from midnight on day 1, so saves land on round
   * clock times (e.g. 06:00). Null when autosave is off.
   */
  private currentAutosavePeriod(): number | null {
    const every = autosaveOption().minutes;
    if (every === null) return null;
    const minutes = Math.floor(this.state.tick / TICKS_PER_MINUTE) + START_MINUTE_OF_DAY;
    return Math.floor(minutes / every);
  }

  /** Snapshots the game for the next start-up, if it has moved on since it was last saved. */
  private saveForResume(): void {
    if (this.state.tick === this.savedTick) return;
    this.savedTick = this.state.tick;
    saveResumeSnapshot(this.state, this.saveName);
  }

  /** Autosaves if autosave is on and the game has moved on since it was last saved. */
  private autosave(): void {
    if (autosaveOption().minutes === null || this.state.tick === this.savedTick) return;
    this.savedTick = this.state.tick;
    autosave(this.state, this.saveName).catch((err: unknown) => {
      console.error(err);
      showToast("Autosave failed", "error");
    });
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
    this.renderer.render(this.loop.alpha, this.state);
    this.drainEvents();

    const period = this.currentAutosavePeriod();
    if (period !== this.autosavePeriod) {
      this.autosavePeriod = period;
      this.autosave();
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
    if (now - this.lastPanels >= PANEL_INTERVAL_MS) {
      this.lastPanels = now;
      this.refreshPanels();
      // Stations empty and fill as nurses come and go.
      if (coverageOverlay.value) this.refreshCoverage();
      if (this.selectedAgent !== null) this.publishInspector();
    }
  }

  /** Moves new sim events into the notifications feed. */
  private drainEvents(): void {
    const events = this.state.events;
    if (events.length === 0) return;
    const added = events.map((e) => ({
      id: this.nextNotification++,
      when: formatClock(clockFromTick(e.tick)),
      text: e.text,
      severity: e.severity,
      ...(e.at ? { at: e.at } : {}),
    }));
    this.state.events = [];
    notifications.value = [...added.reverse(), ...notifications.value].slice(0, MAX_NOTIFICATIONS);
  }

  /** Refreshes whichever management panel is open. */
  refreshPanels(): void {
    const panel = sidePanel.value;
    roster.value = panel === "staff" ? describeRoster(this.state) : null;
    report.value = panel === "reports" ? describeReport(this.state) : null;
    const people = peopleDialog.value;
    patientTable.value = people === "patients" ? describePatientTable(this.state) : null;
    staffTable.value = people === "staff" ? describeStaffTable(this.state) : null;
  }

  /** The patient or member of staff nearest the mouse pointer, if close enough. */
  private agentUnderPointer(): number | null {
    const at = this.renderer.pointerScreen;
    if (!at) return null;
    const w = this.renderer.camera.screenToWorld(at.x, at.y);
    const x = w.x / TILE_SIZE - 0.5;
    const y = w.y / TILE_SIZE - 0.5;
    let best: number | null = null;
    let bestD = AGENT_PICK_RADIUS;
    for (const a of [...Object.values(this.state.staff), ...Object.values(this.state.patients)]) {
      const d = Math.hypot(a.x - x, a.y - y);
      if (d < bestD) {
        best = a.id;
        bestD = d;
      }
    }
    return best;
  }

  /** Shows a help card once the mouse has rested on a room, item or door. */
  private updateHoverHelp(): void {
    const tile = this.renderer.hoveredTile;
    const at = this.renderer.pointerScreen;
    if (
      this.build.active ||
      this.controls.dragging ||
      saveDialogOpen.value ||
      settingsOpen.value ||
      !tile ||
      !at
    ) {
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
      patients: patientsInDept(this.state),
      fourHour: fourHourShare(this.state.today.stats),
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
      patients: Object.keys(this.state.patients).length,
      staff: Object.keys(this.state.staff).length,
      jobs: Object.keys(this.state.jobs).length,
    };
  }

  /** Rebuilds the inspector panel for the selected tile. */
  private publishInspector(): void {
    if (this.selectedAgent !== null) {
      const id = this.selectedAgent;
      const patient = this.state.patients[id];
      const staff = this.state.staff[id];
      if (patient || staff) {
        inspector.value = {
          tile: { x: Math.round((patient ?? staff)!.x), y: Math.round((patient ?? staff)!.y) },
          agent: patient ? describePatient(this.state, patient) : describeStaff(this.state, staff!),
        };
        this.renderer.setSelection(null);
        return;
      }
      // They've left the hospital.
      this.selectedAgent = null;
      this.renderer.setSelectedAgent(null);
      inspector.value = null;
      return;
    }
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
      if (stationsSeeing(this.viewState).has(obj.id)) {
        data.object.cover = COVER_TEXT[bedCover(this.viewState, obj.id)];
      }
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
      const agent = this.agentUnderPointer();
      if (agent !== null) this.selectAgent(agent);
      else this.select(this.renderer.hoveredTile);
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
    } else if (e.code === "KeyO") {
      this.toggleCoverage();
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
      if (this.build.cancel()) return;
      if (peopleDialog.value) peopleDialog.value = null;
      else if (inspector.value) this.select(null);
      else sidePanel.value = null;
    } else if (e.code === "F3" || e.code === "Backquote") {
      e.preventDefault();
      debugVisible.value = !debugVisible.value;
      this.publishHud();
    }
  }
}
