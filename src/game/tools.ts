/**
 * Build tools: what the player has selected in the build menu, and how a
 * tool plus a drag (or click) becomes a Command and a ghost preview.
 */
import type { Ghost, GhostTone } from "@render/renderer";
import type { Command, CommandResult } from "@sim/commands";
import { objectDef } from "@data/catalogue";
import type { Access } from "@data/schema";
import type { SurfaceId } from "@data/structures";
import type { PlacedObject, Rotation, SimState } from "@sim/state";
import type { FloorGrid, WallType } from "@sim/world/grid";
import {
  doorRotationAt,
  footprintRect,
  itemsAt,
  mountOf,
  objectRect,
  wallMountRotation,
} from "@sim/world/objects";
import { rectFromCorners } from "@sim/world/rect";

export type Tool =
  | { kind: "floor" }
  | { kind: "pave"; surface: SurfaceId }
  | { kind: "remove_floor" }
  | { kind: "wall"; wall: WallType }
  | { kind: "demolish" }
  | { kind: "door"; defId: string }
  | { kind: "zone"; roomType: string | null }
  | { kind: "object"; defId: string }
  | { kind: "sell" }
  /** Pick up equipment and put it down elsewhere. `carry` is the item in hand. */
  | { kind: "move"; carry: Carry | null };

/** An item being moved, and which of its tiles is under the cursor. */
export interface Carry {
  objectId: number;
  dx: number;
  dy: number;
}

export function sameTool(a: Tool | null, b: Tool | null): boolean {
  // Carrying an item is still the move tool.
  if (a?.kind === "move" && b?.kind === "move") return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Click-to-place tools; everything else is drag-a-rectangle. */
export function isPlacementTool(tool: Tool): tool is Extract<Tool, { kind: "door" | "object" }> {
  return tool.kind === "door" || tool.kind === "object";
}

type Tile = { x: number; y: number };

export function toolCommand(
  tool: Tool,
  grid: FloorGrid,
  floor: number,
  start: Tile,
  end: Tile,
  rotation: Rotation,
  state: SimState,
): Command | null {
  const rect = rectFromCorners(start, end);
  switch (tool.kind) {
    case "floor":
      return { type: "build_floor", floor, rect };
    case "pave":
      return { type: "pave", floor, rect, surface: tool.surface };
    case "remove_floor":
      return { type: "remove_floor", floor, rect };
    case "wall":
      return { type: "build_walls", floor, rect, wall: tool.wall };
    case "demolish":
      return { type: "demolish", floor, rect };
    case "zone":
      return { type: "zone", floor, rect, roomType: tool.roomType };
    case "sell":
      return { type: "remove_objects", floor, rect };
    case "door":
      return {
        type: "place_object",
        floor,
        defId: tool.defId,
        ...end,
        rotation: doorRotationAt(grid, end.x, end.y),
      };
    case "object": {
      const rot = fixtureRotation(grid, tool.defId, end, rotation);
      return { type: "place_object", floor, defId: tool.defId, ...end, rotation: rot };
    }
    case "move": {
      const obj = tool.carry && state.objects[tool.carry.objectId];
      if (!tool.carry || !obj) return null;
      // Keep the grabbed tile under the cursor, within the rotated footprint.
      const r = footprintRect(obj.defId, 0, 0, rotation);
      const dx = Math.min(tool.carry.dx, r.w - 1);
      const dy = Math.min(tool.carry.dy, r.h - 1);
      const at = { x: end.x - dx, y: end.y - dy };
      const rot = fixtureRotation(grid, obj.defId, at, rotation);
      return { type: "move_object", floor, id: obj.id, ...at, rotation: rot };
    }
  }
}

/** Equipment (not doors) at a tile, for picking up with the move tool. */
export function equipmentAt(state: SimState, floor: number, tile: Tile): PlacedObject | undefined {
  // Top first, so a wall fixture above a bed head is picked before the bed.
  return itemsAt(state, floor, tile.x, tile.y).find(
    (o) => objectDef(o.defId)?.kind === "equipment",
  );
}

/** Wall fixtures turn to face away from the wall they're next to. */
function fixtureRotation(grid: FloorGrid, defId: string, at: Tile, rotation: Rotation): Rotation {
  if (mountOf(defId) !== "wall") return rotation;
  return wallMountRotation(grid, at.x, at.y, rotation) ?? rotation;
}

const REMOVING = new Set<Command["type"]>([
  "remove_floor",
  "demolish",
  "remove_objects",
  "remove_object",
]);

/** `noop`: the command would change nothing, which isn't worth flagging red. */
export function ghostFor(cmd: Command, plan: CommandResult, state: SimState, noop = false): Ghost {
  const removing = REMOVING.has(cmd.type) || (cmd.type === "zone" && cmd.roomType === null);
  const tone: GhostTone = noop ? "neutral" : !plan.ok ? "bad" : removing ? "remove" : "ok";
  switch (cmd.type) {
    case "place_object":
      return { kind: "object", defId: cmd.defId, x: cmd.x, y: cmd.y, rotation: cmd.rotation, tone };
    case "move_object": {
      const defId = state.objects[cmd.id]?.defId ?? "";
      const at = { x: cmd.x, y: cmd.y, rotation: cmd.rotation };
      return { kind: "object", defId, ...at, tone, ignoreId: cmd.id };
    }
    case "build_walls":
      return { kind: "outline", rect: cmd.rect, tone };
    case "remove_object": {
      // Not produced by any drag tool, but show the item's footprint if asked.
      const obj = state.objects[cmd.id];
      const rect = obj ? objectRect(obj) : { x: 0, y: 0, w: 0, h: 0 };
      return { kind: "area", rect, tone };
    }
    default:
      return { kind: "area", rect: cmd.rect, tone };
  }
}

const gbp = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});

export function formatMoney(amount: number): string {
  return gbp.format(amount);
}

/** One-line description of a planned command for the cursor tooltip. */
export function describePlan(cmd: Command, plan: CommandResult): string {
  const size =
    "rect" in cmd && (cmd.rect.w > 1 || cmd.rect.h > 1) ? `${cmd.rect.w}×${cmd.rect.h}` : "";
  let what: string;
  if (!plan.ok) what = plan.error ?? "Can't build here";
  else if (plan.cost > 0) what = formatMoney(plan.cost);
  else if (plan.cost < 0) what = `Refund ${formatMoney(-plan.cost)}`;
  else if (cmd.type === "move_object") what = "Move here";
  else what = cmd.type === "zone" ? `${plan.count} tiles` : "Free";
  return size ? `${size} · ${what}` : what;
}

/** Plain-English summary of an item's access sides, for the inspector. */
export function describeAccess(access: readonly Access[]): string {
  if (access.length === 0) return "Can face any way";
  const where: Record<Access["side"], string> = {
    front: "at the front",
    back: "behind",
    sides: "at the sides",
  };
  const parts = access.map(({ side, who, need }) => {
    const people = who === "staff" ? "staff" : "patients/visitors";
    const mark = who === "staff" ? "blue" : side === "front" ? "arrow" : "";
    const place =
      side !== "sides"
        ? where[side]
        : need === "either"
          ? "at one side or the other"
          : "at both sides";
    return `${people} ${place}${mark ? ` (${mark})` : ""}`;
  });
  const text = parts.join("; ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
