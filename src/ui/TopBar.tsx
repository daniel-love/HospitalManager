import type { Game } from "@game/game";
import { SPEEDS, type Speed } from "@game/loop";
import { formatMoney } from "@game/tools";
import { settingsOpen } from "./settings";
import { hud, peopleDialog, saveDialogOpen } from "./store";

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
  const { clock, speed, money, patients, fourHour } = hud.value;
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
          peopleDialog.value = peopleDialog.value === "patients" ? null : "patients";
          game.refreshPanels();
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
      <div class="speeds" role="group" aria-label="Game speed">
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
