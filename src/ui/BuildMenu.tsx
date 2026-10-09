/**
 * Bottom build bar (Construction / Rooms / Equipment) and the left-hand
 * palette for the open tab. Choosing an entry selects a build tool.
 */
import { content, equipmentSections, roomSections } from "@data/catalogue";
import { FOUNDATION_COST_PER_TILE, surfaces } from "@data/structures";
import { formatMoney, isPlacementTool, sameTool, type Tool } from "@game/tools";
import { WallType } from "@sim/world/grid";
import { CATEGORY_COLOURS, FOOTPATH_COLOUR, ROAD_COLOUR } from "@render/palette";
import { useEffect } from "preact/hooks";
import { equipmentHelp, roomTypeHelp, simpleHelp, type HelpContent } from "./help";
import { ListSection } from "./ListSection";
import {
  buildTab,
  coverageOverlay,
  paletteHelp,
  peopleDialog,
  planning,
  sidePanel,
  tool,
  type BuildTab,
  type PeopleTab,
  type SidePanel,
} from "./store";

const TABS: { id: BuildTab; label: string }[] = [
  { id: "construction", label: "Construction" },
  { id: "rooms", label: "Rooms" },
  { id: "equipment", label: "Equipment" },
];

/** Management buttons: side panels on the left, or tabs of the People dialog. */
const PANELS: ({ kind: "side"; id: SidePanel } | { kind: "people"; id: PeopleTab })[] = [
  { kind: "side", id: "staff" },
  { kind: "people", id: "staff" },
  { kind: "people", id: "patients" },
  { kind: "side", id: "reports" },
  { kind: "side", id: "help" },
];
const PANEL_LABELS = {
  side: { staff: "Hire", reports: "Reports", help: "Help" },
  people: { staff: "Staff", patients: "Patients" },
} as const;
const PANEL_HINTS = {
  side: {
    staff: "Hire new staff",
    reports: "Today's money and A&E performance",
    help: "Help (H): what to build and who to hire next, and how everything works",
  },
  people: { staff: "What every member of staff is doing", patients: "Every patient's status" },
} as const;

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** Build menu swatches for each wall type. */
const WALL_SWATCHES: Record<number, number> = {
  [WallType.Standard]: 0x3b4048,
  [WallType.Glass]: 0x9fd3e6,
  [WallType.Lead]: 0x8c96a3,
};
const noFocus = (e: MouseEvent) => e.preventDefault();

export function BuildBar({
  onTogglePlan,
  onToggleCoverage,
  onPanel,
}: {
  onTogglePlan: () => void;
  onToggleCoverage: () => void;
  /** A management panel was opened or closed, so its data needs refreshing. */
  onPanel: () => void;
}) {
  const open = buildTab.value;
  return (
    <nav class="buildbar" aria-label="Build">
      <button
        class={`plan-toggle${planning.value ? " active" : ""}`}
        aria-pressed={planning.value}
        title="Plan mode (P): lay out changes and see the cost before building anything"
        onMouseDown={noFocus}
        onClick={onTogglePlan}
      >
        Plan
      </button>
      <button
        class={coverageOverlay.value ? "active" : ""}
        aria-pressed={coverageOverlay.value}
        title="Coverage (O): which beds can be seen from a nurse station"
        onMouseDown={noFocus}
        onClick={onToggleCoverage}
      >
        Coverage
      </button>
      <span class="buildbar-divider" aria-hidden="true" />
      {TABS.map((t) => (
        <button
          key={t.id}
          class={open === t.id ? "active" : ""}
          aria-pressed={open === t.id}
          onMouseDown={noFocus}
          onClick={() => {
            buildTab.value = open === t.id ? null : t.id;
            sidePanel.value = null;
            tool.value = null;
          }}
        >
          {t.label}
        </button>
      ))}
      <span class="buildbar-divider" aria-hidden="true" />
      {PANELS.map((p) => {
        const active = p.kind === "side" ? sidePanel.value === p.id : peopleDialog.value === p.id;
        return (
          <button
            key={`${p.kind}-${p.id}`}
            class={active ? "active" : ""}
            aria-pressed={active}
            title={p.kind === "side" ? PANEL_HINTS.side[p.id] : PANEL_HINTS.people[p.id]}
            onMouseDown={noFocus}
            onClick={() => {
              if (p.kind === "side") {
                sidePanel.value = active ? null : p.id;
                buildTab.value = null;
                tool.value = null;
              } else {
                peopleDialog.value = active ? null : p.id;
              }
              onPanel();
            }}
          >
            {p.kind === "side" ? PANEL_LABELS.side[p.id] : PANEL_LABELS.people[p.id]}
          </button>
        );
      })}
    </nav>
  );
}

export function Palette() {
  const tab = buildTab.value;
  // Don't leave a help card behind when the palette closes or switches tab.
  useEffect(() => () => void (paletteHelp.value = null), [tab]);
  if (!tab) return null;
  return (
    <aside class="panel palette">
      <div class="palette-scroll">
        {tab === "construction" && <ConstructionTools />}
        {tab === "rooms" && <RoomTools />}
        {tab === "equipment" && <EquipmentTools />}
      </div>
      <Hint />
    </aside>
  );
}

function Entry(props: {
  t: Tool;
  name: string;
  detail?: string;
  swatch?: { colour: number; glyph?: string };
  /** Hover card; a plain string becomes a one-paragraph card. */
  help: HelpContent | string;
}) {
  const selected = sameTool(tool.value, props.t);
  const help = typeof props.help === "string" ? simpleHelp(props.name, props.help) : props.help;
  const show = (e: MouseEvent) => {
    const entry = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const palette = (e.currentTarget as HTMLElement).closest(".palette")!.getBoundingClientRect();
    paletteHelp.value = { x: palette.right + 8, y: entry.top, content: help };
  };
  return (
    <button
      class={`entry${selected ? " selected" : ""}`}
      aria-pressed={selected}
      onMouseEnter={show}
      onMouseLeave={() => (paletteHelp.value = null)}
      onMouseDown={noFocus}
      onClick={() => (tool.value = selected ? null : props.t)}
    >
      {props.swatch && (
        <span class="swatch" style={{ background: hex(props.swatch.colour) }}>
          {props.swatch.glyph}
        </span>
      )}
      <span class="entry-name">{props.name}</span>
      {props.detail && <span class="entry-detail">{props.detail}</span>}
    </button>
  );
}

function ConstructionTools() {
  const wall = (type: WallType) => content.walls.find((w) => w.type === type)!;
  return (
    <>
      <ListSection title="Structure">
        <Entry
          t={{ kind: "floor" }}
          name="Foundations"
          detail={`${formatMoney(FOUNDATION_COST_PER_TILE)}/tile`}
          swatch={{ colour: 0xd9d4c7 }}
          help="Turns grass into buildable floor. Rooms must have floor before you can zone them; walls lay their own."
        />
        {[WallType.Standard, WallType.Glass, WallType.Lead].map((type) => (
          <Entry
            key={type}
            t={{ kind: "wall", wall: type }}
            name={wall(type).name}
            detail={`${formatMoney(wall(type).costPerTile)}/tile`}
            swatch={{ colour: WALL_SWATCHES[type]! }}
            help={wall(type).description}
          />
        ))}
      </ListSection>
      <ListSection title="Outside">
        {surfaces.map((s) => (
          <Entry
            key={s.id}
            t={{ kind: "pave", surface: s.id }}
            name={s.name}
            detail={`${formatMoney(s.costPerTile)}/tile`}
            swatch={{ colour: s.id === "road" ? ROAD_COLOUR : FOOTPATH_COLOUR }}
            help={s.description}
          />
        ))}
      </ListSection>
      <ListSection title="Doors">
        {content.doors.map((d) => (
          <Entry
            key={d.id}
            t={{ kind: "door", defId: d.id }}
            name={d.name}
            detail={formatMoney(d.cost)}
            swatch={{ colour: 0x9a6a3a }}
            help={d.description}
          />
        ))}
      </ListSection>
      <ListSection title="Remove">
        <Entry
          t={{ kind: "demolish" }}
          name="Demolish walls & doors"
          help="Removes walls and doors in the area you drag. Refunds half the build cost."
        />
        <Entry
          t={{ kind: "remove_floor" }}
          name="Remove floor or paving"
          help="Clears everything on the tiles back to grass, including footpaths and access roads. Refunds half."
        />
      </ListSection>
    </>
  );
}

function RoomTools() {
  return (
    <>
      {roomSections().map((section) => (
        <ListSection key={section.id} title={section.name}>
          {section.items.map((r) => (
            <Entry
              key={r.id}
              t={{ kind: "zone", roomType: r.id }}
              name={r.name}
              detail={`min ${r.minSize[0]}×${r.minSize[1]}`}
              swatch={{ colour: r.colour }}
              help={roomTypeHelp(r)}
            />
          ))}
        </ListSection>
      ))}
      <ListSection title="Remove">
        <Entry t={{ kind: "zone", roomType: null }} name="Unzone" help="Clear room zoning" />
      </ListSection>
    </>
  );
}

function EquipmentTools() {
  return (
    <>
      {equipmentSections().map((section) => (
        <ListSection key={section.id} title={section.name}>
          {section.items.map((e) => (
            <Entry
              key={e.id}
              t={{ kind: "object", defId: e.id }}
              name={e.name}
              detail={formatMoney(e.cost)}
              swatch={{ colour: CATEGORY_COLOURS[e.category], glyph: e.glyph }}
              help={equipmentHelp(e)}
            />
          ))}
        </ListSection>
      ))}
      <ListSection title="Rearrange">
        <Entry
          t={{ kind: "move", carry: null }}
          name="Move equipment"
          detail="Free"
          help="Click an item to pick it up, then click where it should go"
        />
        <Entry
          t={{ kind: "sell" }}
          name="Sell equipment"
          help="Drag over items to sell them for half price"
        />
      </ListSection>
    </>
  );
}

function Hint() {
  const t = tool.value;
  let text = "Pick a tool. Click a room to inspect it.";
  if (t?.kind === "move") {
    text = t.carry
      ? "Click to put down · R rotates · right-click puts it back"
      : "Click an item to pick it up";
  } else if (t?.kind === "door") text = "Click a wall to place · right-click to cancel";
  else if (t && isPlacementTool(t))
    text = "Click to place, hold to paint · R rotates · right-click cancels";
  else if (t?.kind === "wall") text = "Drag a rectangle to wall its outline · right-click cancels";
  else if (t) text = "Drag a rectangle · right-click cancels";
  return (
    <p class="hint">
      {text}
      {t && (t.kind === "object" || t.kind === "move") && (
        <>
          <br />
          Arrow = patient side · <span class="staff-mark">blue</span> = staff side. Both must be
          kept clear.
        </>
      )}
      {t && (
        <>
          <br />
          Ctrl/⌘ + drag or right-drag to pan
        </>
      )}
    </p>
  );
}
