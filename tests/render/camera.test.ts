import { describe, expect, it } from "vitest";
import { Camera } from "@render/camera";

function makeCamera() {
  const cam = new Camera({ minZoom: 0.5, maxZoom: 4, bounds: { width: 1000, height: 1000 } });
  cam.setViewport(800, 600);
  cam.centreOn(500, 500);
  return cam;
}

describe("Camera", () => {
  it("maps the viewport centre to the camera position", () => {
    const cam = makeCamera();
    expect(cam.screenToWorld(400, 300)).toEqual({ x: 500, y: 500 });
  });

  it("screenToWorld and worldToScreen are inverses", () => {
    const cam = makeCamera();
    cam.zoomAt(100, 100, 2.3);
    const w = cam.screenToWorld(123, 456);
    const s = cam.worldToScreen(w.x, w.y);
    expect(s.x).toBeCloseTo(123);
    expect(s.y).toBeCloseTo(456);
  });

  it("keeps the point under the cursor fixed while zooming", () => {
    const cam = makeCamera();
    const before = cam.screenToWorld(650, 120);
    cam.zoomAt(650, 120, 1.7);
    const after = cam.screenToWorld(650, 120);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it("clamps zoom to the allowed range", () => {
    const cam = makeCamera();
    cam.zoomAt(400, 300, 100);
    expect(cam.zoom).toBe(4);
    cam.zoomAt(400, 300, 0.0001);
    expect(cam.zoom).toBe(0.5);
  });

  it("pans opposite to a drag, scaled by zoom", () => {
    const cam = makeCamera();
    cam.zoomAt(400, 300, 2);
    cam.panByScreen(100, -50);
    expect(cam.x).toBeCloseTo(450);
    expect(cam.y).toBeCloseTo(525);
  });

  it("keeps the camera centre inside the world bounds", () => {
    const cam = makeCamera();
    cam.panByScreen(-100_000, 100_000);
    expect(cam.x).toBe(1000);
    expect(cam.y).toBe(0);
  });
});
