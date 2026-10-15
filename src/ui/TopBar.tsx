import { useEffect } from "preact/hooks";
import type { Game } from "@game/game";
import { SPEEDS, type Speed } from "@game/loop";
import { formatMoney } from "@game/tools";
import { settingsOpen } from "./settings";
import type { Census } from "@game/describe";
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

function censusTitle(c: Census): string {
  const beds =
    c.beds > 0
      ? `${c.bedsUsed} of ${c.beds} beds in use (${Math.round((c.bedsUsed / c.beds) * 100)}%)`
      : "no ward beds";
  const lines = [
    `In A&E: ${c.ae} (amber: someone in over 4 hours; red: over 12)`,
    `  waiting to be booked in, triaged or seen: ${c.waiting} (amber: someone past their target; red: twice it)`,
    `  admitted, on a trolley waiting for a ward bed: ${c.awaitingBed} (red: 5 or more, or a 12-hour wait)`,
    `On the wards: ${c.wards}, ${beds} (amber: 92% full; red: 98%)`,
    `In for surgery (Day Surgery, theatre, Recovery): ${c.surgery}`,
    `Outpatients in clinic: ${c.clinics}`,
    "Click for the list",
  ];
  return lines.join("\n");
}

export function TopBar({ game }: { game: Game }) {
  const { name, clock, speed, money, census, fourHour, events, cqc } = hud.value;
  useEffect(() => {
    document.title = name ? `${name} · Hospital Manager` : "Hospital Manager";
  }, [name]);
  return (
    <div class="topbar">
      <span class="hospital-name" title={`${name}: rename in Settings`}>
        {name}
      </span>
      <span class="clock">{clock}</span>
      <span class={`money${money < 0 ? " negative" : ""}`} title="Cash">
        {formatMoney(money)}
      </span>
      <button
        class="census"
        title={censusTitle(census)}
        onMouseDown={noFocus}
        onClick={() => {
          game.togglePatients();
        }}
      >
        <span class="stat">
          <span class="dim">A&amp;E</span> <span class={census.aePressure}>{census.ae}</span>
          {(census.waiting > 0 || census.awaitingBed > 0) && (
            <span class="sub">
              {" ("}
              {census.waiting > 0 && (
                <span class={census.waitingPressure}>{census.waiting} waiting</span>
              )}
              {census.waiting > 0 && census.awaitingBed > 0 && ", "}
              {census.awaitingBed > 0 && (
                <span class={census.awaitingBedPressure}>{census.awaitingBed} need a bed</span>
              )}
              {")"}
            </span>
          )}
        </span>
        <span class="stat">
          <span class="dim">Wards</span>{" "}
          <span class={census.beds > 0 ? census.wardPressure : ""}>{census.wards}</span>
        </span>
        {census.surgery > 0 && (
          <span class="stat">
            <span class="dim">Surgery</span> {census.surgery}
          </span>
        )}
        {census.clinics > 0 && (
          <span class="stat">
            <span class="dim">Clinics</span> {census.clinics}
          </span>
        )}
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
