/**
 * Every room type must be buildable at its minimum size: some placement of its
 * required equipment has to satisfy every placement and room rule. This guards
 * against data changes (new requirements, bigger items, stricter access rules)
 * that would make a room impossible to build at the size the game advertises.
 */
import { describe, expect, it } from "vitest";
import { content } from "@data/catalogue";
import { fitRoom } from "./roomFit";

describe("room minimum sizes are achievable", () => {
  for (const room of content.rooms) {
    const [w, h] = room.minSize;
    const sizes: [number, number][] =
      w === h
        ? [[w, h]]
        : [
            [w, h],
            [h, w],
          ];
    for (const [rw, rh] of sizes) {
      // "walled": no relying on equipment facing out of an open side.
      for (const walled of [false, true]) {
        it(`${room.name} at ${rw}×${rh}${walled ? ", walled all round" : ""}`, () => {
          const fit = fitRoom(room.id, rw, rh, { walled });
          expect(fit, `failing: ${fit.failing.join(", ")}`).toMatchObject({
            ok: true,
            exhausted: false,
          });
        });
      }
    }
  }
});
