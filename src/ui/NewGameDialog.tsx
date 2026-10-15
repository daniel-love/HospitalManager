/**
 * Starting a new hospital (GAME_DESIGN §2.2, §2.3): a sandbox game, with
 * the funding model (chosen once; it shapes the whole game) and the
 * sandbox settings, or a scenario.
 */
import { useEffect, useState } from "preact/hooks";
import { STARTING_CASH } from "@data/economy";
import type { Game } from "@game/game";
import { formatMoney } from "@game/tools";
import type { Funding } from "@sim/state";
import { CATCHMENTS, DEFAULT_CATCHMENT } from "@data/patients";
import type { EventFrequency } from "@data/pressure";
import { SCENARIOS, scenarioById, type ScenarioId } from "@data/scenarios";
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

const CASH_OPTIONS = [2_000_000, STARTING_CASH, 5_000_000, 10_000_000];
const VOLUMES = [
  { value: 0.7, label: "Quieter" },
  { value: 1, label: "Real-world" },
  { value: 1.3, label: "Busier" },
];
const EVENTS: { value: EventFrequency; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "rare", label: "Rare" },
  { value: "realistic", label: "Realistic" },
  { value: "frequent", label: "Frequent" },
];

function Chips<T extends string | number | boolean>(props: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div class="sandbox-row">
      <span class="sandbox-label">{props.label}</span>
      <div class="chips" role="radiogroup" aria-label={props.label}>
        {props.options.map((o) => (
          <button
            key={String(o.value)}
            role="radio"
            aria-checked={props.value === o.value}
            class={props.value === o.value ? "active" : ""}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function NewGameBody({ game }: { game: Game }) {
  const [mode, setMode] = useState<"sandbox" | "scenario">("sandbox");
  const [funding, setFunding] = useState<Funding>("nhs");
  const [money, setMoney] = useState(STARTING_CASH);
  const [catchment, setCatchment] = useState<number>(DEFAULT_CATCHMENT);
  const [volume, setVolume] = useState(1);
  const [events, setEvents] = useState<EventFrequency>("realistic");
  const [recruitment, setRecruitment] = useState(true);
  const [failStates, setFailStates] = useState(false);
  const [scenario, setScenario] = useState<ScenarioId>(SCENARIOS[0]!.id);
  const close = () => (newGameOpen.value = false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const start = () => {
    if (mode === "scenario") game.newScenario(scenario);
    else {
      game.newGame({
        funding,
        money,
        catchment,
        patientVolume: volume,
        eventFrequency: events,
        recruitment,
        failStates,
      });
    }
    close();
  };
  const chosen = scenarioById.get(scenario)!;
  return (
    <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
      <div class="panel modal new-game" role="dialog" aria-modal="true" aria-labelledby="new-title">
        <button class="close" title="Close (Esc)" onClick={close}>
          ×
        </button>
        <h2 id="new-title">New hospital</h2>
        <div class="tabs" role="tablist">
          {(
            [
              ["sandbox", "Sandbox"],
              ["scenario", "Scenarios"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={mode === id}
              class={mode === id ? "active" : ""}
              onClick={() => setMode(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "sandbox" ? (
          <>
            <p class="dim">
              Build and run a hospital your way, with everything unlocked. How it's funded decides
              what it does and how it earns, and can't change later. Anything unsaved in the current
              game will be lost.
            </p>
            <p class="small-note">
              New to the game?{" "}
              <button
                class="link-button"
                onClick={() => {
                  setMode("scenario");
                  setScenario("tutorial");
                }}
              >
                Start with the tutorial
              </button>
              .
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
            <div class="sandbox-settings">
              <Chips
                label="Starting cash"
                value={money}
                options={CASH_OPTIONS.map((v) => ({ value: v, label: formatMoney(v) }))}
                onChange={setMoney}
              />
              <Chips
                label="Catchment"
                value={catchment}
                options={CATCHMENTS.map((c) => ({
                  value: c.population as number,
                  label: `${c.name} ${c.population / 1000}k`,
                }))}
                onChange={setCatchment}
              />
              <Chips label="Patient volume" value={volume} options={VOLUMES} onChange={setVolume} />
              <Chips label="Events" value={events} options={EVENTS} onChange={setEvents} />
              <Chips
                label="Recruitment"
                value={recruitment}
                options={[
                  { value: true, label: "From applicants" },
                  { value: false, label: "Hire instantly" },
                ]}
                onChange={setRecruitment}
              />
              <Chips
                label="Can be lost"
                value={failStates}
                options={[
                  { value: false, label: "No" },
                  { value: true, label: "Yes" },
                ]}
                onChange={setFailStates}
              />
              {failStates && (
                <p class="dim small-note">
                  Lost after three months in NHS oversight segment 4, in administration (a Private
                  Hospital), or with two Inadequate CQC ratings in a row.
                </p>
              )}
            </div>
          </>
        ) : (
          <div class="scenario-pick">
            <div class="scenario-list" role="radiogroup" aria-label="Scenario">
              {SCENARIOS.map((sc) => (
                <button
                  key={sc.id}
                  role="radio"
                  aria-checked={scenario === sc.id}
                  class={`funding-card${scenario === sc.id ? " active" : ""}`}
                  onClick={() => setScenario(sc.id)}
                >
                  <strong>{sc.name}</strong>
                  <span class="funding-tagline">{sc.summary}</span>
                </button>
              ))}
            </div>
            <div class="scenario-briefing">
              {chosen.briefing.map((p) => (
                <p key={p}>{p}</p>
              ))}
              <h4>To win</h4>
              <ul>
                {chosen.objectives.map((o) => (
                  <li key={o.id}>{o.text}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <div class="new-game-actions">
          <button onClick={close}>Cancel</button>
          <button class="primary" onClick={start}>
            {mode === "scenario"
              ? `Start: ${chosen.name}`
              : `Start as ${MODELS.find((m) => m.id === funding)!.name}`}
          </button>
        </div>
      </div>
    </div>
  );
}
