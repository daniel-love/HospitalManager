/**
 * Starting a new hospital (GAME_DESIGN §2.2): the funding model is chosen
 * here, once, and shapes the whole game.
 */
import { useEffect, useState } from "preact/hooks";
import { STARTING_CASH } from "@data/economy";
import type { Game } from "@game/game";
import { formatMoney } from "@game/tools";
import type { Funding } from "@sim/state";
import { newGameOpen } from "./store";

const MODELS: { id: Funding; name: string; tagline: string; points: string[] }[] = [
  {
    id: "nhs",
    name: "NHS Trust",
    tagline: "Survival under pressure.",
    points: [
      "Run the A&E your catchment depends on, with wards, clinics and theatres behind it.",
      "A block contract pays for the emergency care you're equipped for, with a share of the tariff per patient; planned care is paid in full.",
      "The 4-hour and 18-week standards are yours to meet.",
    ],
  },
  {
    id: "private",
    name: "Private Hospital",
    tagline: "Business growth and a premium experience.",
    points: [
      "Planned care only: clinics, day cases and operations, with no emergency department.",
      "Consultants have practising privileges: no salaries, they bring their patients and bill their own fees, and you earn the facility fee.",
      "Insured and self-pay patients follow your reputation and prices, and you can take NHS patients who choose you.",
      "Private inpatients have a room of their own.",
    ],
  },
  {
    id: "hybrid",
    name: "Hybrid Trust",
    tagline: "An NHS trust with a Private Patient Unit.",
    points: [
      "Everything an NHS Trust does, plus private rooms, wards and theatres in a Private Patient Unit.",
      "Your consultants add private sessions on top of their NHS work, competing with it for rooms and theatres.",
      "Private income can't pass 49% of all income: the regulator keeps an NHS trust's private work from outgrowing its NHS work.",
    ],
  },
];

export function NewGameDialog({ game }: { game: Game }) {
  if (!newGameOpen.value) return null;
  return <NewGameBody game={game} />;
}

function NewGameBody({ game }: { game: Game }) {
  const [funding, setFunding] = useState<Funding>("nhs");
  const close = () => (newGameOpen.value = false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const start = () => {
    game.newGame(funding);
    close();
  };
  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="panel modal new-game" role="dialog" aria-modal="true" aria-labelledby="new-title">
        <button class="close" title="Close (Esc)" onClick={close}>
          ×
        </button>
        <h2 id="new-title">New hospital</h2>
        <p class="dim">
          How your hospital is funded decides what it does and how it earns. You start with{" "}
          {formatMoney(STARTING_CASH)} to build with, and can't change the model later. Anything
          unsaved in the current game will be lost.
        </p>
        <div class="funding-choices" role="radiogroup" aria-label="Funding model">
          {MODELS.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={funding === m.id}
              class={`funding-card${funding === m.id ? " active" : ""}`}
              onClick={() => setFunding(m.id)}
            >
              <strong>{m.name}</strong>
              <span class="funding-tagline">{m.tagline}</span>
              <ul>
                {m.points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </button>
          ))}
        </div>
        <div class="new-game-actions">
          <button onClick={close}>Cancel</button>
          <button class="primary" onClick={start}>
            Start as {MODELS.find((m) => m.id === funding)!.name}
          </button>
        </div>
      </div>
    </div>
  );
}
