/**
 * Room name and status labels, centred on each room. Rebuilt whenever rooms
 * are re-detected. Labels keep a readable size when zoomed out.
 */
import { Container, Text } from "pixi.js";
import { roomById } from "@data/catalogue";
import type { Room } from "@sim/state";
import { TILE_SIZE } from "./constants";

const VALID_COLOUR = 0xffffff;
const INVALID_COLOUR = 0xffb4ae;

export class RoomLabelLayer {
  readonly container = new Container();

  sync(rooms: Room[]): void {
    this.container.removeChildren().forEach((c) => c.destroy());
    for (const room of rooms) {
      const def = roomById.get(room.typeId);
      if (!def) continue;
      const missing = room.checks.filter((c) => !c.ok).length;
      const status = room.valid ? "✓" : `✗ ${missing} to fix`;
      const label = new Text({
        // Rooms with no requirements (corridors) just show their name.
        text: room.checks.length === 0 ? def.name : `${def.name}\n${status}`,
        style: {
          fontFamily: "system-ui, sans-serif",
          fontSize: 12,
          fontWeight: "600",
          align: "center",
          fill: room.valid ? VALID_COLOUR : INVALID_COLOUR,
          stroke: { color: 0x101418, width: 3 },
        },
        resolution: 4,
      });
      label.anchor.set(0.5);
      label.position.set(
        (room.bounds.x + room.bounds.w / 2) * TILE_SIZE,
        (room.bounds.y + room.bounds.h / 2) * TILE_SIZE,
      );
      this.container.addChild(label);
    }
  }

  update(zoom: number): void {
    this.container.visible = zoom >= 0.2;
    const s = Math.min(2.5, Math.max(1, 0.9 / zoom));
    for (const label of this.container.children) label.scale.set(s);
  }
}
