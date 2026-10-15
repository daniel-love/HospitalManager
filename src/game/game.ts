/**
 * Wires the pieces together: SimState + fixed-step loop + renderer + camera
 * and build controls + UI signals. Owns the per-frame callback and is the one
 * place that applies player commands to the state.
 *
 * In plan mode, commands go into the build plan instead (see sim/plan.ts), and
 * the map, tools and inspector all show the plan preview ("viewState").
 */
import { buildDistrictHospital, DISTRICT_MAP } from "./maps/districtHospital";
import { scenarioById, type ScenarioId } from "@data/scenarios";
import { describeGoals, lockReason, startScenario } from "@sim/systems/scenarios";
import { openingCampaign } from "@sim/systems/recruitment";
import { RATING_NAMES } from "@data/cqc";
import { equipmentCondition, setEssentialRoom } from "@sim/systems/maintenance";
import { roomClosure, setRoomClosed } from "@sim/systems/outbreaks";
import { declare, standDown } from "@sim/systems/majorIncident";
import type { EventFrequency } from "@data/pressure";
import { content, equipmentById, objectDef, roomById } from "@data/catalogue";
import type { SpecialtyId } from "@data/schema";
import {
  autosave,
  loadGame,
  rememberLastSave,
  saveGame,
  saveResumeSnapshot,
} from "@save/saveManager";
import { onSite } from "@sim/agents";
import { applyCommand, type Command, type CommandResult } from "@sim/commands";
import { addToPlan, buildPreview, commitPlan, planDiff, type PlanPreview } from "@sim/plan";
import { roomsPatientsCantReach } from "@sim/places";
import { tick } from "@sim/sim";
import {
  createSimState,
  type Funding,
  type GapFill,
  type SimState,
  type Visiting,
} from "@sim/state";
import { siteView } from "@sim/world/site";
import { coverageView, stationsSeeing, bedCover } from "@sim/systems/monitoring";
import { acceptGrant, declineGrant } from "@sim/systems/grants";
import { borrow, cantBorrow, repayEarly } from "@sim/systems/loans";
import { setCover } from "@sim/systems/rota";
import { eventChips } from "./describeEvents";
import { describeFinance } from "./describeFinance";
import { describeHospital } from "./describeHospital";
import { setDepartment, type Department } from "@sim/systems/departments";
import { applyStaffCommand, type StaffCommand } from "@sim/systems/staffing";
import {
  clockFromTick,
  formatClock,
  START_MINUTE_OF_DAY,
  TICKS_PER_MINUTE,
  TICKS_PER_SECOND_1X,
} from "@sim/time";
import { itemsAt } from "@sim/world/objects";
import {
  PRIVATE_ROOM_TYPES,
  roomAt,
  setEmergencyTheatre,
  setPrivateRoom,
  setRoomSpecialty,
} from "@sim/world/rooms";
import { PRIVATE } from "@data/economy";
import { CameraControls, isPanModifier } from "@render/cameraControls";
import { TILE_SIZE } from "@render/constants";
import { tagSpot } from "@render/deathMarks";
import type { Renderer } from "@render/renderer";
import {
  advice,
  buildTab,
  coverageOverlay,
  debugStats,
  debugVisible,
  hud,
  inspector,
  mapHelp,
  notifications,
  patientTable,
  administrationDismissed,
  financeData,
  hospitalData,
  hospitalTab,
  financeTab,
  patientsOpen,
  planning,
  planSummary,
  report,
  roster,
  saveDialogOpen,
  showToast,
  sidePanel,
  staffHighlight,
  staffScreen,
  staffTable,
  type FinanceTab,
  type HospitalTab,
  type StaffTab,
  tool,
  type InspectorData,
  goals,
  lockedItems,
  scenarioBriefing,
} from "@ui/store";
import { tileHelp } from "@ui/help";
import { autosaveOption, settings, settingsOpen } from "@ui/settings";
import { describeAdvice } from "./advice";
import { BuildController } from "./buildController";
import {
  describeOutpatient,
  describePatient,
  describePatientTable,
  describeReport,
  describeRoster,
  describeStaff,
  describeStaffTable,
  fourHourShare,
  patientsInDept,
} from "./describe";
import { FixedStepLoop, FramePacer, type Speed } from "./loop";
import { describeAccess, formatMoney } from "./tools";

const HUD_INTERVAL_MS = 100;
/** Panels with lots of detail (inspector, staff, reports) refresh less often. */
const PANEL_INTERVAL_MS = 250;
/** How far back the debug overlay's stutter figures look. */
const GAP_WINDOW_MS = 5000;
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
  curtained: { text: "Curtains drawn: hidden from the nurse station", ok: false },
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

/** What giving a room a specialty means, by room type. */
const SPECIALTY_NOTES: Record<string, string> = {
  ward: "Patients go to their own specialty's ward first, then one for any specialty, and only then to another specialty's ward (an outlier).",
  outpatient_clinic:
    "Clinic sessions use a room of their own specialty first, then one open to any specialty.",
  theatre:
    "Theatre lists use a theatre of their own specialty first, then one open to any specialty.",
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
    // At most 60 frames a second, evenly paced even on a 120 Hz display.
    const pacer = new FramePacer(60);
    renderer.app.ticker.add((t) => {
      const start = performance.now();
      const dt = pacer.next(t.deltaMS);
      if (dt !== null) this.frame(dt);
      this.noteGap(start, performance.now() - start);
    });
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
    if (cmd.type !== "hire_staff" && cmd.type !== "dismiss_staff") this.publishInspector();
  }

  /** Sets a rota group's cover levels; the rota changes from the next shift. */
  setCover(group: string, day: number, night: number): void {
    setCover(this.state, group, { day, night });
    this.refreshPanels();
  }

  /** Sets how rota gaps are filled at the start of each shift (a hospital policy). */
  setGapFill(fill: GapFill): void {
    this.state.policies.gapFill = fill;
    this.refreshPanels();
  }

  /** Turns shifts and rotas on or off (a setting saved with the game). */
  setRotas(on: boolean): void {
    this.state.settings.rotas = on;
    this.refreshPanels();
  }

  /**
   * Gives the selected ward or clinic room to a specialty (null: any). Like
   * staffing, a setting for the real hospital, even in plan mode.
   */
  setRoomSpecialty(specialty: SpecialtyId | null): void {
    const tile = this.selectedTile;
    const room = tile && roomAt(this.state, FLOOR, tile.x, tile.y);
    if (!room || !roomById.get(room.typeId)?.specialty) return;
    setRoomSpecialty(this.state, room, specialty);
    if (this.preview) this.rebuildPreview();
    this.publishInspector();
  }

  /** Keeps the selected theatre for emergencies, or opens it to planned lists. */
  setEmergencyTheatre(on: boolean): void {
    const tile = this.selectedTile;
    const room = tile && roomAt(this.state, FLOOR, tile.x, tile.y);
    if (!room || room.typeId !== "theatre") return;
    setEmergencyTheatre(this.state, room, on);
    if (this.preview) this.rebuildPreview();
    this.publishInspector();
  }

  /** Closes the selected ward room or side room to admissions, or reopens it. */
  setRoomClosed(closed: boolean): void {
    const tile = this.selectedTile;
    const room = tile && roomAt(this.state, FLOOR, tile.x, tile.y);
    if (!room || (room.typeId !== "ward" && room.typeId !== "side_room")) return;
    setRoomClosed(this.state, room, closed, "player");
    this.publishInspector();
  }

  /** Puts the selected room on the essential supply, or takes it off. */
  setEssentialRoom(on: boolean): void {
    const tile = this.selectedTile;
    const room = tile && roomAt(this.state, FLOOR, tile.x, tile.y);
    if (!room) return;
    setEssentialRoom(this.state, room, on);
    this.publishInspector();
  }

  /** Enhanced infection control (Hospital → Policies). */
  setInfectionControl(on: boolean): void {
    this.state.policies.infectionControl = on;
    this.afterMoney();
  }

  /** Who closes rooms in an outbreak (Hospital → Policies). */
  setOutbreakClosures(by: "ipc" | "manual"): void {
    this.state.policies.outbreakClosures = by;
    this.afterMoney();
  }

  /** Hybrid trusts: puts the selected room in the Private Patient Unit, or takes it out. */
  setPrivateRoom(on: boolean): void {
    const tile = this.selectedTile;
    const room = tile && roomAt(this.state, FLOOR, tile.x, tile.y);
    if (!room || this.state.funding !== "hybrid" || !PRIVATE_ROOM_TYPES.has(room.typeId)) return;
    setPrivateRoom(this.state, room, on);
    if (this.preview) this.rebuildPreview();
    this.publishInspector();
  }

  /** Private care: the self-pay price level (a hospital policy). */
  setPriceLevel(level: number): void {
    const [lo, hi] = PRIVATE.priceLevels;
    this.state.policies.priceLevel = Math.max(lo, Math.min(hi, level));
    this.refreshPanels();
  }

  /** Private Hospitals: whether to take NHS referrals for a specialty. */
  setNhsReferrals(specialty: SpecialtyId, on: boolean): void {
    if (on) this.state.policies.nhsReferrals[specialty] = true;
    else delete this.state.policies.nhsReferrals[specialty];
    this.refreshPanels();
  }

  /** Centres the camera on a tile (e.g. from a notification). */
  focus(at: { x: number; y: number }): void {
    this.renderer.camera.centreOn((at.x + 0.5) * TILE_SIZE, (at.y + 0.5) * TILE_SIZE);
  }

  /** Selects someone and moves the camera to them (e.g. from the Patients dialog or Staff screen). */
  showAgent(id: number): void {
    const a = this.state.patients[id] ?? this.state.staff[id] ?? this.state.outpatients[id];
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
    administrationDismissed.value = false;
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

  /** A new sandbox game, with the New hospital dialog's settings. */
  newGame(opts: SandboxOptions = {}): void {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
    const state = createSimState({
      seed,
      site: true,
      rotas: true,
      funding: opts.funding ?? "nhs",
      ...(opts.money !== undefined ? { money: opts.money } : {}),
      ...(opts.catchment !== undefined ? { catchment: opts.catchment } : {}),
      ...(opts.patientVolume !== undefined ? { patientVolume: opts.patientVolume } : {}),
      eventFrequency: opts.eventFrequency ?? "realistic",
      recruitment: opts.recruitment ?? true,
      failStates: opts.failStates ?? false,
    });
    if (state.settings.recruitment) openingCampaign(state);
    this.loadState(state);
    if (state.site) this.focus(siteView(state.site));
    // Until it's saved, a reload starts afresh rather than resuming the old hospital.
    rememberLastSave(null);
  }

  /** A new game of a scenario. */
  newScenario(id: ScenarioId): void {
    const def = scenarioById.get(id)!;
    const seed = crypto.getRandomValues(new Uint32Array(1))[0]!;
    const prebuilt = def.start === "district_hospital";
    const state = createSimState({
      seed,
      // A pre-built hospital fits its own road in below it.
      site: !prebuilt,
      ...(prebuilt ? DISTRICT_MAP : {}),
      rotas: true,
      funding: def.funding,
      money: def.money,
      catchment: def.catchment,
      startDay: def.startDay,
      eventFrequency: def.eventFrequency,
      recruitment: true,
    });
    if (prebuilt) buildDistrictHospital(state);
    startScenario(state, def);
    openingCampaign(state);
    this.loadState(state);
    if (state.site) this.focus(siteView(state.site));
    rememberLastSave(null);
    scenarioBriefing.value = true;
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

  /**
   * Refreshes over the last few seconds, for spotting stutter in the debug
   * overlay: the real gap since the previous one (timed here, as Pixi caps
   * its own at 100 ms) and the time our code spent in it.
   */
  private gaps: { at: number; ms: number; workMs: number }[] = [];
  private lastRefresh = 0;

  private noteGap(at: number, workMs: number): void {
    const ms = this.lastRefresh > 0 ? at - this.lastRefresh : 0;
    this.lastRefresh = at;
    this.gaps.push({ at, ms, workMs });
    while (this.gaps.length > 0 && at - this.gaps[0]!.at > GAP_WINDOW_MS) this.gaps.shift();
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
      ...(e.staff ? { staff: e.staff } : {}),
      ...(e.finance ? { finance: e.finance } : {}),
      ...(e.hospital ? { hospital: e.hospital } : {}),
    }));
    this.state.events = [];
    notifications.value = [...added.reverse(), ...notifications.value].slice(0, MAX_NOTIFICATIONS);
  }

  /** Opens or closes the Help panel, in place of the build palette or another panel. */
  toggleHelp(): void {
    sidePanel.value = sidePanel.value === "help" ? null : "help";
    buildTab.value = null;
    tool.value = null;
    this.refreshPanels();
  }

  /**
   * Opens the Staff screen at a tab (closing the Patients dialog, which
   * sits in the same place), optionally picking out one member of staff.
   */
  openStaff(tab: StaffTab, highlight: number | null = null): void {
    this.closeCentred();
    staffScreen.value = tab;
    staffHighlight.value = highlight;
    this.refreshPanels();
  }

  /** Opens or closes the Patients dialog (closing the Staff screen). */
  togglePatients(): void {
    const open = !patientsOpen.value;
    this.closeCentred();
    patientsOpen.value = open;
    this.refreshPanels();
  }

  /** Opens the Finance dialog at a tab (closing the others in the same place). */
  openFinance(tab: FinanceTab): void {
    this.closeCentred();
    financeTab.value = tab;
    this.refreshPanels();
  }

  /** Opens the Hospital dialog at a tab (closing the others in the same place). */
  openHospital(tab: HospitalTab): void {
    this.closeCentred();
    hospitalTab.value = tab;
    this.refreshPanels();
  }

  /** Closes the dialogs that sit in the middle of the screen. */
  private closeCentred(): void {
    staffScreen.value = null;
    patientsOpen.value = false;
    financeTab.value = null;
    hospitalTab.value = null;
  }

  /** Opens or closes escalation beds (Hospital → Escalation). */
  setEscalation(on: boolean): void {
    this.state.policies.escalation = on;
    this.afterMoney();
  }

  /** Declares a major incident (Hospital → Events). */
  declareMajorIncident(): void {
    declare(this.state);
    this.afterMoney();
  }

  /** Stands a declared major incident down (Hospital → Events). */
  standDownMajorIncident(): void {
    standDown(this.state);
    this.afterMoney();
  }

  /** The staff flu vaccination policy (Hospital → Policies). */
  setFluVaccination(on: boolean): void {
    this.state.policies.fluVaccination = on;
    this.afterMoney();
  }

  /** Hiring from applicants, or instantly (Settings). Switching on starts a recruitment campaign. */
  setRecruitment(on: boolean): void {
    this.state.settings.recruitment = on;
    if (on && this.state.applicants.length === 0) openingCampaign(this.state);
    this.refreshPanels();
  }

  /** How often pressure events come (Settings). */
  setEventFrequency(frequency: EventFrequency): void {
    this.state.settings.eventFrequency = frequency;
  }

  setDischargeBeforeNoon(on: boolean): void {
    this.state.policies.dischargeBeforeNoon = on;
    this.afterMoney();
  }

  setVisiting(visiting: Visiting): void {
    this.state.policies.visiting = visiting;
    this.afterMoney();
  }

  /** Sets a department's status (Hospital → Departments). */
  setDepartment(dept: Department, status: string): void {
    setDepartment(this.state, dept, status as never);
    this.afterMoney();
  }

  /** Takes out a loan (Finance → Loans). */
  borrow(kind: "capital" | "bank", amount: number, years: number): void {
    const why = cantBorrow(this.state, kind, amount, years);
    if (why) {
      showToast(why, "error");
      return;
    }
    borrow(this.state, kind, amount, years);
    showToast(`Borrowed ${formatMoney(amount)}`);
    this.afterMoney();
  }

  /** Pays a loan off early. */
  repayLoan(id: number): void {
    const why = repayEarly(this.state, id);
    if (why) showToast(why, "error");
    this.afterMoney();
  }

  /** Takes on the grant on offer. */
  acceptGrant(): void {
    const why = acceptGrant(this.state);
    if (why) showToast(why, "error");
    this.afterMoney();
  }

  /** Turns down the grant on offer. */
  declineGrant(): void {
    declineGrant(this.state);
    this.afterMoney();
  }

  private afterMoney(): void {
    this.drainEvents();
    this.refreshPanels();
    this.publishHud();
  }

  private lastGoals = "";

  /** The scenario's objectives and locks, when they change. */
  private publishGoals(): void {
    const g = describeGoals(this.state);
    const locks: Record<string, string> = {};
    for (const room of content.rooms) {
      const why = lockReason(this.state, room.id);
      if (why) locks[room.id] = why;
    }
    for (const e of content.equipment) {
      const why = lockReason(this.state, e.id);
      if (why) locks[e.id] = why;
    }
    const key = JSON.stringify([g, locks]);
    if (key === this.lastGoals) return;
    this.lastGoals = key;
    goals.value = g;
    lockedItems.value = locks;
  }

  /** Refreshes whichever management panel is open. */
  refreshPanels(): void {
    const panel = sidePanel.value;
    const staff = staffScreen.value !== null;
    roster.value = staff ? describeRoster(this.state) : null;
    staffTable.value = staff ? describeStaffTable(this.state) : null;
    report.value = panel === "reports" ? describeReport(this.state) : null;
    advice.value = panel === "help" ? describeAdvice(this.state) : null;
    patientTable.value = patientsOpen.value ? describePatientTable(this.state) : null;
    financeData.value = financeTab.value ? describeFinance(this.state) : null;
    hospitalData.value = hospitalTab.value ? describeHospital(this.state) : null;
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
    const here = Object.values(this.state.staff).filter(onSite);
    const people = [
      ...here,
      ...Object.values(this.state.patients),
      ...Object.values(this.state.outpatients),
    ];
    for (const a of people) {
      // In the mortuary they're shown as a label on their fridge drawer.
      const at = "stage" in a && a.stage === "in_mortuary" ? tagSpot(this.state, a) : a;
      const d = Math.hypot(at.x - x, at.y - y);
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
    this.publishGoals();
    hud.value = {
      clock: formatClock(clockFromTick(this.state.tick)),
      speed: this.loop.speed,
      money: this.state.money,
      patients: patientsInDept(this.state),
      fourHour: fourHourShare(this.state.today.stats),
      administration: this.state.rating.administration !== null,
      events: eventChips(this.state),
      cqc: {
        rating: this.state.cqc.overall,
        label: this.state.cqc.overall && RATING_NAMES[this.state.cqc.overall],
        underWay: this.state.cqc.visit !== null,
      },
    };
    if (!debugVisible.value) return;
    const { camera } = this.renderer;
    const grid = this.state.floors[FLOOR]!;
    debugStats.value = {
      fps: this.fps,
      frameMs: this.frameMs,
      worstGapMs: this.gaps.reduce((m, g) => Math.max(m, g.ms), 0),
      worstWorkMs: this.gaps.reduce((m, g) => Math.max(m, g.workMs), 0),
      longGaps: this.gaps.filter((g) => g.ms > 25).length,
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
      const outpatient = this.state.outpatients[id];
      const who = patient ?? staff ?? outpatient;
      if (who) {
        inspector.value = {
          tile: { x: Math.round(who.x), y: Math.round(who.y) },
          agent: patient
            ? describePatient(this.state, patient)
            : staff
              ? describeStaff(this.state, staff)
              : describeOutpatient(this.state, outpatient!),
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
      const condition = equipmentCondition(this.viewState, obj.id);
      if (condition) data.object.condition = condition;
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
        forConditions: room.forConditions,
        patientsCantReach: roomsPatientsCantReach(this.viewState).includes(room),
        capabilities: room.capabilities,
        items: [...counts].map(([name, count]) => ({ name, count })),
        ...(roomDef.specialty
          ? {
              specialty: {
                value: room.specialty,
                // Clinic rooms and theatres: only specialties that use them.
                options: content.specialties
                  .filter((sp) => room.typeId !== "outpatient_clinic" || sp.outpatients)
                  .filter((sp) => room.typeId !== "theatre" || sp.surgery)
                  .map((sp) => ({ id: sp.id, name: sp.name })),
                note: SPECIALTY_NOTES[room.typeId] ?? "",
              },
            }
          : {}),
        ...(room.typeId === "theatre" ? { emergency: room.emergency } : {}),
        ...(room.objectIds.some((id) => equipmentById.get(this.viewState.objects[id]!.defId)?.power)
          ? { essential: room.essential }
          : {}),
        ...(room.typeId === "ward" || room.typeId === "side_room"
          ? { closure: roomClosure(this.state, room) }
          : {}),
        ...(this.state.funding === "hybrid" && PRIVATE_ROOM_TYPES.has(room.typeId)
          ? { private: room.private }
          : {}),
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
    } else if (e.code === "KeyH") {
      this.toggleHelp();
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
      if (hospitalTab.value) hospitalTab.value = null;
      else if (financeTab.value) financeTab.value = null;
      else if (staffScreen.value) staffScreen.value = null;
      else if (patientsOpen.value) patientsOpen.value = false;
      else if (inspector.value) this.select(null);
      else sidePanel.value = null;
    } else if (e.code === "F3" || e.code === "Backquote") {
      e.preventDefault();
      debugVisible.value = !debugVisible.value;
      this.publishHud();
    }
  }
}

/** The New hospital dialog's sandbox settings. */
export interface SandboxOptions {
  funding?: Funding;
  money?: number;
  catchment?: number;
  patientVolume?: number;
  eventFrequency?: EventFrequency;
  recruitment?: boolean;
  failStates?: boolean;
}
