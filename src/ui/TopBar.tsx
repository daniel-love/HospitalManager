import type { Game } from "@game/game";
import { SPEEDS, type Speed } from "@game/loop";
import { formatMoney } from "@game/tools";
import { settingsOpen } from "./settings";
import { hud, saveDialogOpen, tutorialHighlight } from "./store";

const LABELS: Record<Speed, string> = {
  0: "❚❚",
  1: "1×",
  2: "2×",
  4: "4×",
  8: "8×",
  16: "16×",
};
const HINTS: Record<Speed, string> = {
  0: "Pause (Space)",
  1: "Normal: 1 game minute per second (1)",
  2: "Fast (2)",
  4: "Faster (3)",
  8: "Very fast (4)",
  16: "Skip ahead, e.g. overnight (5)",
};

// Don't take focus on click, or Space (pause) would re-press the button.
const noFocus = (e: MouseEvent) => e.preventDefault();

export function TopBar({ game }: { game: Game }) {
  const { clock, speed, money, patients, fourHour, events, cqc } = hud.value;
  return (
    <div class="topbar">
      <span class="clock">{clock}</span>
      <span class={`money${money < 0 ? " negative" : ""}`} title="Cash">
        {formatMoney(money)}
      </span>
      <button
        class="census"
        title="Patients in A&E now: click for the list"
        onMouseDown={noFocus}
        onClick={() => {
          game.togglePatients();
        }}
      >
        {patients} {patients === 1 ? "patient" : "patients"}
      </button>
      <span
        class={`four-hour ${fourHour === null ? "" : fourHour >= 0.95 ? "ok" : fourHour >= 0.78 ? "warn" : "bad"}`}
        title="Today's 4-hour standard: patients leaving A&E within 4 hours of arriving. The constitutional standard is 95%; the current interim target is 78%."
      >
        4-hr {fourHour === null ? "—" : `${Math.round(fourHour * 100)}%`}
      </span>
      {(cqc.label || cqc.underWay) && (
        <button
          class="cqc-chip"
          title="Care Quality Commission rating: click for the report"
          onMouseDown={noFocus}
          onClick={() => game.openHospital("inspections")}
        >
          {cqc.underWay ? (
            <span class="event-chip">CQC inspecting</span>
          ) : (
            <span class={`cqc-badge ${cqc.rating}`}>CQC {cqc.label}</span>
          )}
        </button>
      )}
      {events.map((e) => (
        <button
          key={e.id}
          class={`event-chip${e.coming ? " coming" : ""}`}
          title={`${e.label} ${e.coming ? "forecast" : "under way"}: click for what to do`}
          onMouseDown={noFocus}
          onClick={() => game.openHospital("events")}
        >
          {e.label} <span class="dim">{e.when}</span>
        </button>
      ))}
      <div
        class={`speeds${tutorialHighlight.value === "speed" ? " tutorial-glow" : ""}`}
        role="group"
        aria-label="Game speed"
      >
        {SPEEDS.map((s) => (
          <button
            key={s}
            class={s === speed ? "active" : ""}
            title={HINTS[s]}
            aria-pressed={s === speed}
            onMouseDown={noFocus}
            onClick={() => game.setSpeed(s)}
          >
            {LABELS[s]}
          </button>
        ))}
      </div>
      <button
        class="menu-button"
        onMouseDown={noFocus}
        onClick={() => (saveDialogOpen.value = true)}
      >
        Save / Load
      </button>
      <button class="menu-button" onMouseDown={noFocus} onClick={() => (settingsOpen.value = true)}>
        Settings
      </button>
    </div>
  );
}
