/**
 * The Hospital dialog (GAME_DESIGN §8.3, §8.4): how the hospital runs.
 * Departments sets each department's status, a crisis lever with a daily
 * cost in income and reputation; Escalation opens escalation beds under
 * pressure; Policies holds hospital-wide choices.
 */
import type { Game } from "@game/game";
import type { HospitalData } from "@game/describeHospital";
import { hospitalData, hospitalTab, type HospitalTab } from "./store";

const noFocus = (e: MouseEvent) => e.preventDefault();

const TABS: { id: HospitalTab; label: string }[] = [
  { id: "departments", label: "Departments" },
  { id: "escalation", label: "Escalation" },
  { id: "policies", label: "Policies" },
];

export function HospitalDialog({ game }: { game: Game }) {
  const tab = hospitalTab.value;
  const data = hospitalData.value;
  if (!tab || !data) return null;
  return (
    <section class="panel people-dialog hospital-dialog" role="dialog" aria-label="Hospital">
      <header class="people-header">
        <div class="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              class={tab === t.id ? "active" : ""}
              onMouseDown={noFocus}
              onClick={() => game.openHospital(t.id)}
            >
              {t.label}
              {t.id === "departments" && data.departments.some((d) => d.status !== "open") && (
                <span class="tab-badge">!</span>
              )}
            </button>
          ))}
        </div>
        <button class="close" title="Close (Esc)" onClick={() => (hospitalTab.value = null)}>
          ×
        </button>
      </header>
      <div class="staff-tab-scroll">
        {tab === "departments" && <Departments game={game} data={data} />}
        {tab === "escalation" && <Escalation game={game} data={data} />}
        {tab === "policies" && <Policies game={game} data={data} />}
      </div>
    </section>
  );
}

function Departments({ game, data }: { game: Game; data: HospitalData }) {
  return (
    <>
      <p class="dim small-note">
        A crisis lever. Taking a department less than fully open relieves the pressure on it at
        once, but every day costs income and reputation (now {Math.round(data.reputation)}
        {data.statusPenalty > 0 &&
          `, losing ground at ${data.statusPenalty} points a day off its score`}
        ).
      </p>
      {data.departments.map((d) => (
        <div key={d.id} class={`dept-card${d.status !== "open" ? " restricted" : ""}`}>
          <div class="dept-head">
            <strong>{d.name}</strong>
            <div class="chips" role="radiogroup" aria-label={`${d.name} status`}>
              {d.options.map((o) => (
                <button
                  key={o.id}
                  role="radio"
                  aria-checked={d.status === o.id}
                  class={d.status === o.id ? "active" : ""}
                  onMouseDown={noFocus}
                  onClick={() => game.setDepartment(d.id, o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <span class="hire-desc">{d.options.find((o) => o.id === d.status)!.effect}</span>
          {d.note && <span class="dim small-note">{d.note}</span>}
        </div>
      ))}
    </>
  );
}

function Escalation({ data }: { game: Game; data: HospitalData }) {
  return <p class="dim">Coming next. OPEL level {data.opel}.</p>;
}

function Policies(_props: { game: Game; data: HospitalData }) {
  return <p class="dim">Coming next.</p>;
}
