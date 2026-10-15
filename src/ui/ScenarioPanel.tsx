/**
 * A scenario's objectives (systems/scenarios.ts): a card under the top bar
 * with each objective's status and progress, the briefing (shown when the
 * scenario starts, and from the card), and the end: won or lost.
 */
import { useState } from "preact/hooks";
import { scenarioById } from "@data/scenarios";
import type { Game } from "@game/game";
import { goals, inspector, newGameOpen, scenarioBriefing } from "./store";

const MARK = { met: "✓", failed: "✗", pending: "○" } as const;

export function ScenarioPanel({ game }: { game: Game }) {
  const g = goals.value;
  const [dismissed, setDismissed] = useState<number | null>(null);
  if (!g) return null;
  const def = game.state.goals.scenario ? scenarioById.get(game.state.goals.scenario) : undefined;
  const t = g.tutorial;
  // The card sits top right, clear of the build palette and the middle of
  // the map; the inspector opens in the same corner, so step left of it.
  const aside = inspector.value ? " beside-inspector" : "";
  return (
    <>
      {t ? (
        <div class={`panel scenario-card tutorial-card${aside}`}>
          <span class="dim small-note">
            Step {t.step} of {t.of}
          </span>
          <strong>{t.text}</strong>
          <p>{t.hint}</p>
          <ul>
            {g.objectives.map((o) => (
              <li key={o.text} class={o.status}>
                <span aria-hidden="true">{MARK[o.status as keyof typeof MARK]}</span> {o.text}
              </li>
            ))}
          </ul>
          <button class="link-button small-note" onClick={() => (scenarioBriefing.value = true)}>
            Show the introduction again
          </button>
        </div>
      ) : (
        <button
          class={`panel scenario-card${aside}`}
          title="Show the briefing"
          onClick={() => (scenarioBriefing.value = true)}
        >
          <strong>{g.name}</strong>
          <ul>
            {g.objectives.map((o) => (
              <li key={o.text} class={o.status}>
                <span aria-hidden="true">{MARK[o.status as keyof typeof MARK]}</span> {o.text}
                {o.progress && <span class="dim"> · {o.progress}</span>}
              </li>
            ))}
          </ul>
          <span class="dim small-note">Ends {g.ends}</span>
        </button>
      )}
      {scenarioBriefing.value && def && (
        <div
          class="modal-backdrop"
          onClick={(e) => e.target === e.currentTarget && (scenarioBriefing.value = false)}
        >
          <div class="panel modal scenario-modal" role="dialog" aria-modal="true">
            <h2>{def.name}</h2>
            {def.briefing.map((p) => (
              <p key={p}>{p}</p>
            ))}
            <h4>{def.tutorial ? "The steps" : "To win"}</h4>
            <ul>
              {def.objectives.map((o) => (
                <li key={o.id}>{o.text}</li>
              ))}
            </ul>
            <div class="new-game-actions">
              <button class="primary" onClick={() => (scenarioBriefing.value = false)}>
                {def.tutorial ? "Let's start" : "Got it"}
              </button>
            </div>
          </div>
        </div>
      )}
      {g.outcome && dismissed !== g.outcome.tick && (
        <div class="modal-backdrop">
          <div class="panel modal scenario-modal" role="dialog" aria-modal="true">
            <h2>
              {def?.tutorial
                ? "Tutorial complete"
                : g.outcome.won
                  ? "Scenario complete"
                  : "Scenario failed"}
            </h2>
            <p>
              {def?.tutorial
                ? "Your A&E is open and treating patients. From here you can grow it: Majors and Resus for sicker patients, an Ambulance Bay, X-ray and a lab, a ward to admit to. The Help panel's checklist suggests what to add next."
                : g.outcome.text}
            </p>
            <p class="dim">
              You can keep playing this hospital as a sandbox game, or start another.
            </p>
            <div class="new-game-actions">
              <button onClick={() => setDismissed(g.outcome!.tick)}>Keep playing</button>
              <button
                class="primary"
                onClick={() => {
                  setDismissed(g.outcome!.tick);
                  newGameOpen.value = true;
                }}
              >
                New game
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
