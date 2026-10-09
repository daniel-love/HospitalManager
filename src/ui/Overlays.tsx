/** Small floating bits: the build cursor tooltip, toast messages and the coverage key. */
import { COVER_COLOURS, COVER_SEEN } from "@render/palette";
import { coverageOverlay, cursorInfo, toasts } from "./store";

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

export function CursorInfo() {
  const info = cursorInfo.value;
  if (!info) return null;
  return (
    <div
      class={`cursor-info${info.ok ? "" : " bad"}`}
      style={{ left: `${info.x + 16}px`, top: `${info.y + 18}px` }}
    >
      {info.text}
    </div>
  );
}

export function Toasts() {
  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.value.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

/** Key for the coverage overlay (GAME_DESIGN §7): a strip above the build bar. */
export function CoverageLegend() {
  if (!coverageOverlay.value) return null;
  const rows = [
    { colour: COVER_COLOURS.watched, text: "Watched", hint: "In sight of a staffed nurse station" },
    {
      colour: COVER_COLOURS.remote,
      text: "Monitored",
      hint: "On a staffed central monitor's screens, within walking distance for a nurse to respond",
    },
    {
      colour: COVER_COLOURS.unstaffed,
      text: "Station empty",
      hint: "In sight of a nurse station, but no nurse is at it right now",
    },
    {
      colour: COVER_COLOURS.blind,
      text: "Out of sight",
      hint: "No nurse station can see this bed",
    },
    {
      colour: COVER_SEEN,
      text: "Station can see",
      hint: "Floor in sight of a nurse station. Walls and doors block the view; glazed walls don't.",
    },
  ];
  return (
    <div
      class="panel coverage-legend"
      aria-label="Coverage key"
      title="Majors and Resus beds should all be watched"
    >
      {rows.map((r) => (
        <span key={r.text} class="legend-row" title={r.hint}>
          <span class="legend-swatch" style={{ background: hex(r.colour) }} />
          {r.text}
        </span>
      ))}
    </div>
  );
}
