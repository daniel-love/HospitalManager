import { debugStats, debugVisible } from "./store";

export function DebugOverlay() {
  const s = debugStats.value;
  if (!debugVisible.value || !s) return null;
  const tile = s.hoveredTile ? `${s.hoveredTile.x}, ${s.hoveredTile.y}` : "—";
  return (
    <pre class="debug">
      {`FPS        ${s.fps.toFixed(0)}  (${s.frameMs.toFixed(1)} ms)
sim/frame  ${s.simMs.toFixed(2)} ms
ticks/s    ${s.ticksPerSec.toFixed(0)}
dropped    ${s.ticksDropped}
tick       ${s.tick}
seed       ${s.seed}
zoom       ${s.zoom.toFixed(2)}
camera     ${s.camera.x.toFixed(0)}, ${s.camera.y.toFixed(0)}
tile       ${tile}
chunks     ${s.chunksVisible} visible
map        ${s.mapSize.width}×${s.mapSize.height}
rooms      ${s.rooms}
objects    ${s.objects}

F3/\` toggle · . step when paused`}
    </pre>
  );
}
