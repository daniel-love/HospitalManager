/**
 * Turns mouse input into build commands while a tool is selected.
 *
 * - Area tools (floor, walls, zones, demolish, sell): left-drag a rectangle,
 *   release to apply. Walls follow the rectangle's outline.
 * - Placement tools (equipment, doors): left-click to place; keep the button
 *   held and move to place more (handy for rows of chairs).
 * - Move: click an item to pick it up, click again to put it down. While
 *   carrying, right-click or Escape puts it back where it was.
 * - Ctrl/⌘ + drag pans the camera instead (see CameraControls).
 * - R rotates equipment. Right-click or Escape cancels the drag, then the tool.
 *
 * The ghost preview and cursor tooltip are refreshed on every pointer move
 * using planCommand(), a dry run, so what you see is what you'll pay.
 */
import { isPanModifier } from "@render/cameraControls";
import type { Renderer } from "@render/renderer";
import { NOTHING_TO_CHANGE, planCommand, type Command, type CommandResult } from "@sim/commands";
import type { SimState } from "@sim/state";
import { cursorInfo, planning, rotation, tool } from "@ui/store";
import { objectDef } from "@data/catalogue";
import { objectRect } from "@sim/world/objects";
import { describePlan, equipmentAt, ghostFor, isPlacementTool, toolCommand } from "./tools";

const FLOOR = 0;

export interface BuildHost {
  /** The layout the tools work on: the plan preview while planning. */
  readonly viewState: SimState;
  apply(cmd: Command, quiet?: boolean): CommandResult;
}

export class BuildController {
  private dragStart: { x: number; y: number } | null = null;
  /** Holding the button with a placement tool: last tile we placed on. */
  private painting: string | null = null;
  private pointer = { x: 0, y: 0 };
  private readonly abort = new AbortController();
  private readonly unsubscribe: (() => void)[];

  constructor(
    private readonly renderer: Renderer,
    private readonly host: BuildHost,
  ) {
    const canvas = renderer.app.canvas;
    const opts = { signal: this.abort.signal };
    canvas.addEventListener("pointerdown", (e) => this.onDown(e), opts);
    canvas.addEventListener("pointermove", (e) => this.onMove(e), opts);
    canvas.addEventListener("pointerup", (e) => this.onUp(e), opts);
    canvas.addEventListener("pointerleave", () => this.refresh(), opts);
    this.unsubscribe = [
      tool.subscribe(() => {
        this.dragStart = null;
        this.refresh();
      }),
      rotation.subscribe(() => this.refresh()),
    ];
  }

  get active(): boolean {
    return tool.value !== null;
  }

  /** Cancels the current drag, or failing that the tool. Returns whether it did anything. */
  cancel(): boolean {
    const t = tool.value;
    if (t?.kind === "move" && t.carry) {
      tool.value = { kind: "move", carry: null };
      return true;
    }
    if (this.dragStart) {
      this.dragStart = null;
      this.refresh();
      return true;
    }
    if (tool.value) {
      tool.value = null;
      return true;
    }
    return false;
  }

  /** Picks up a piece of equipment with the move tool, as if it had been clicked. */
  pickUp(objectId: number, grabbed?: { x: number; y: number }): void {
    const obj = this.host.viewState.objects[objectId];
    if (!obj) return;
    rotation.value = obj.rotation;
    tool.value = {
      kind: "move",
      carry: { objectId, dx: grabbed ? grabbed.x - obj.x : 0, dy: grabbed ? grabbed.y - obj.y : 0 },
    };
  }

  rotate(): void {
    rotation.value = ((rotation.value + 1) % 4) as 0 | 1 | 2 | 3;
  }

  /** Recomputes the ghost and tooltip, e.g. after the camera moved. */
  refresh(): void {
    const t = tool.value;
    const tile = this.renderer.hoveredTile;
    if (!t || !tile) {
      this.renderer.setGhost(null);
      cursorInfo.value = null;
      return;
    }
    const cmd = this.command(tile);
    if (!cmd) {
      this.refreshPickUp(tile);
      return;
    }
    const plan = planCommand(this.host.viewState, cmd);
    const noop = plan.error === NOTHING_TO_CHANGE;
    this.renderer.setGhost(ghostFor(cmd, plan, this.host.viewState, noop));
    const prefix = planning.value ? "Plan · " : "";
    cursorInfo.value = noop
      ? null
      : { ...this.pointer, text: prefix + describePlan(cmd, plan), ok: plan.ok };
  }

  /** Move tool with empty hands: highlight what would be picked up. */
  private refreshPickUp(tile: { x: number; y: number }): void {
    const obj = equipmentAt(this.host.viewState, FLOOR, tile);
    if (!obj) {
      this.renderer.setGhost(null);
      cursorInfo.value = { ...this.pointer, text: "Click equipment to pick it up", ok: true };
      return;
    }
    this.renderer.setGhost({ kind: "area", rect: objectRect(obj), tone: "ok" });
    const name = objectDef(obj.defId)?.def.name ?? "item";
    cursorInfo.value = { ...this.pointer, text: `Move ${name}`, ok: true };
  }

  destroy(): void {
    this.abort.abort();
    for (const u of this.unsubscribe) u();
  }

  private command(tile: { x: number; y: number }): Command | null {
    const state = this.host.viewState;
    const grid = state.floors[FLOOR]!;
    const start = this.dragStart ?? tile;
    return toolCommand(tool.value!, grid, FLOOR, start, tile, rotation.value, state);
  }

  /** Tracks the pointer from the event itself, not whichever listener ran first. */
  private track(e: PointerEvent): void {
    this.pointer = { x: e.clientX, y: e.clientY };
    this.renderer.setPointer({ x: e.offsetX, y: e.offsetY });
  }

  private onDown(e: PointerEvent): void {
    this.track(e);
    const t = tool.value;
    const tile = this.renderer.hoveredTile;
    if (e.button !== 0 || !t || !tile || isPanModifier(e)) return;
    if (t.kind === "move") {
      if (!t.carry) {
        const obj = equipmentAt(this.host.viewState, FLOOR, tile);
        if (obj) this.pickUp(obj.id, tile);
      } else {
        const cmd = this.command(tile)!;
        // Dropping it where it already was just puts it down.
        const unchanged = planCommand(this.host.viewState, cmd).error === NOTHING_TO_CHANGE;
        if (unchanged || this.host.apply(cmd).ok) tool.value = { kind: "move", carry: null };
      }
      this.refresh();
      return;
    }
    if (isPlacementTool(t)) {
      this.host.apply(this.command(tile)!);
      this.painting = `${tile.x},${tile.y}`;
    } else {
      this.dragStart = tile;
    }
    // Keep receiving the drag even if the pointer strays over a UI panel.
    this.renderer.app.canvas.setPointerCapture(e.pointerId);
    this.refresh();
  }

  private onMove(e: PointerEvent): void {
    this.track(e);
    const tile = this.renderer.hoveredTile;
    if (this.painting && tile && tool.value && `${tile.x},${tile.y}` !== this.painting) {
      this.painting = `${tile.x},${tile.y}`;
      const cmd = this.command(tile)!;
      // While painting, silently skip tiles where the item doesn't fit.
      if (planCommand(this.host.viewState, cmd).ok) this.host.apply(cmd, true);
    }
    this.refresh();
  }

  private onUp(e: PointerEvent): void {
    if (e.button !== 0) return;
    this.track(e);
    const canvas = this.renderer.app.canvas;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    this.painting = null;
    const tile = this.renderer.hoveredTile;
    const cmd = this.dragStart && tile && tool.value ? this.command(tile) : null;
    if (cmd) this.host.apply(cmd);
    this.dragStart = null;
    this.refresh();
  }
}
