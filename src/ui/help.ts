/**
 * Content for hover help cards: room types and equipment in the build
 * palette, and rooms, items and doors on the map.
 */
import { content, objectDef, roomById } from "@data/catalogue";
import type { EquipmentDef, RoomDef } from "@data/schema";
import { describeAccess, formatMoney } from "@game/tools";
import type { SimState } from "@sim/state";
import { itemsAt } from "@sim/world/objects";
import { roomAt } from "@sim/world/rooms";

export interface HelpItem {
  text: string;
  /** Shown as ✓ / ✗ when set. */
  ok?: boolean;
}

export interface HelpContent {
  title: string;
  badge?: { text: string; ok: boolean };
  subtitle?: string;
  body?: string;
  sections?: { heading: string; items: HelpItem[] }[];
  footer?: string;
}

export const CATEGORY_NAMES: Record<EquipmentDef["category"], string> = {
  furnishing: "Furnishing",
  bedding: "Beds & couches",
  monitoring: "Monitoring",
  diagnostic: "Diagnostic",
  treatment: "Treatment",
  life_support: "Life support",
  facilities: "Facilities",
  decor: "Décor",
};

const nice = (id: string) => id.replace(/_/g, " ");

/** Which room types list an item among their requirements. */
function roomsNeeding(equipmentId: string): string[] {
  return content.rooms
    .filter((r) => r.required.some((req) => req.anyOf.includes(equipmentId)))
    .map((r) => r.name);
}

/** What a room type needs to be valid, as checklist lines. */
function requirementLines(def: RoomDef): HelpItem[] {
  const lines: HelpItem[] = [];
  const [w, h] = def.minSize;
  if (w * h > 1) lines.push({ text: `At least ${w}×${h} tiles` });
  if (def.enclosed) lines.push({ text: "Walls all round, with a door" });
  for (const req of def.required) {
    lines.push({ text: req.count > 1 ? `${req.count} × ${req.label}` : req.label });
  }
  if (def.minSeats !== undefined) lines.push({ text: `Seating for ${def.minSeats}` });
  if (def.bothBedSides) lines.push({ text: "Clear space both sides of each bed" });
  if (def.observed) lines.push({ text: "Recommended: beds in sight of a nurse station" });
  for (const c of def.connectedTo) lines.push({ text: c.label });
  return lines;
}

export function roomTypeHelp(def: RoomDef): HelpContent {
  const lines = requirementLines(def);
  return {
    title: def.name,
    subtitle: def.department,
    body: def.description,
    sections: [
      { heading: "To be valid", items: lines.length > 0 ? lines : [{ text: "No requirements" }] },
    ],
    footer: "Drag over floor to zone. Rooms are free to zone.",
  };
}

export function equipmentHelp(def: EquipmentDef): HelpContent {
  const needed = roomsNeeding(def.id);
  const details = [
    `${formatMoney(def.cost)} to buy · ${formatMoney(def.upkeep)}/month upkeep`,
    `${def.footprint[0]}×${def.footprint[1]} tiles${def.power ? " · needs power" : ""}`,
  ];
  if (def.seats) details.push(`Seats ${def.seats}`);
  return {
    title: def.name,
    subtitle: `${CATEGORY_NAMES[def.category]} · tier ${def.tier}`,
    body: def.description,
    sections: [
      { heading: "Details", items: details.map((text) => ({ text })) },
      { heading: "Access", items: [{ text: describeAccess(def.access) }] },
      ...(def.capabilities.length > 0
        ? [{ heading: "Provides", items: [{ text: def.capabilities.map(nice).join(", ") }] }]
        : []),
      ...(needed.length > 0
        ? [{ heading: "Needed in", items: [{ text: needed.join(", ") }] }]
        : []),
    ],
  };
}

/** Help for whatever is on a map tile, or null if there's nothing to say. */
export function tileHelp(state: SimState, floor: number, x: number, y: number): HelpContent | null {
  if (!state.floors[floor]) return null;
  const room = roomAt(state, floor, x, y);
  const roomDef = room && roomById.get(room.typeId);

  const [obj, under] = itemsAt(state, floor, x, y);
  const def = obj && objectDef(obj.defId);
  if (def?.kind === "door") {
    return { title: def.def.name, body: def.def.description };
  }
  if (def?.kind === "equipment") {
    const help = equipmentHelp(def.def);
    // On the map, what matters is what it does here, not the shop details.
    help.sections = (help.sections ?? []).filter((s) => s.heading !== "Details");
    if (room && roomDef) {
      const missing = room.checks.filter((c) => !c.ok).length;
      help.footer = `In ${roomDef.name}${room.valid ? " ✓" : ` (${missing} to fix)`}`;
    } else {
      help.footer = "Not inside a room, so it doesn't count towards one";
    }
    if (def.def.mount !== "floor") {
      help.subtitle += def.def.mount === "wall" ? " · wall-mounted" : " · ceiling-mounted";
    }
    const below = under && objectDef(under.defId)?.def.name;
    if (below) help.footer += ` · ${below} below`;
    return help;
  }

  if (!room || !roomDef) return null;
  const failing = room.checks.filter((c) => !c.ok);
  return {
    title: roomDef.name,
    badge: room.valid ? { text: "Valid", ok: true } : { text: "Needs work", ok: false },
    subtitle: `${roomDef.department} · ${room.bounds.w}×${room.bounds.h} (${room.tiles.length} m²)`,
    sections:
      room.checks.length === 0
        ? []
        : [
            failing.length > 0
              ? {
                  heading: "To fix",
                  items: failing.map((c) => ({
                    text: c.detail ? `${c.label} (${c.detail})` : c.label,
                    ok: false,
                  })),
                }
              : { heading: "Requirements", items: [{ text: "All met", ok: true }] },
          ],
    footer: "Click for full details",
  };
}

/** Plain card for entries with just a sentence of help. */
export function simpleHelp(title: string, body: string): HelpContent {
  return { title, body };
}
