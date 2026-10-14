/**
 * The Hospital dialog (GAME_DESIGN §8.3, §8.4): how the hospital runs.
 * Departments sets each department's status, a crisis lever with a daily
 * cost in income and reputation; Escalation opens escalation beds under
 * pressure; Policies holds hospital-wide choices; Performance is the
 * monthly integrated performance report, KPIs against national standards.
 */
import type { Game } from "@game/game";
import type { HospitalData } from "@game/describeHospital";
import { hospitalData, hospitalTab, type HospitalTab } from "./store";

const noFocus = (e: MouseEvent) => e.preventDefault();

const TABS: { id: HospitalTab; label: string }[] = [
  { id: "departments", label: "Departments" },
  { id: "escalation", label: "Escalation" },
  { id: "policies", label: "Policies" },
  { id: "events", label: "Events" },
  { id: "performance", label: "Performance" },
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
              {t.id === "events" && data.events.active.length > 0 && (
                <span class="tab-badge">{data.events.active.length}</span>
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
        {tab === "events" && <Events game={game} data={data.events} />}
        {tab === "performance" && <Performance data={data.performance} />}
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

const OPEL_NOTES = [
  "",
  "Steady: the hospital is coping.",
  "Moderate pressure: watch the beds and the front door.",
  "Severe pressure: patients are waiting for beds and ambulances are queueing. Time to think about escalation beds.",
  "Extreme pressure: flow has broken down. Consider escalation beds, standing down planned surgery, or diverting.",
];

function Escalation({ game, data }: { game: Game; data: HospitalData }) {
  const e = data.escalation;
  return (
    <>
      <div class={`dept-card opel-${data.opel.level}`}>
        <div class="dept-head">
          <strong>OPEL {data.opel.level}</strong>
          <span class="dim">Operational Pressures Escalation Level</span>
        </div>
        <span class="hire-desc">{OPEL_NOTES[data.opel.level]}</span>
        {data.opel.drivers.length > 0 && (
          <ul class="opel-drivers">
            {data.opel.drivers.map((d) => (
              <li key={d}>{d}</li>
            ))}
          </ul>
        )}
      </div>
      <div class={`dept-card${e.open ? " restricted" : ""}`}>
        <div class="dept-head">
          <strong>Escalation beds</strong>
          <div class="chips" role="radiogroup" aria-label="Escalation beds">
            {([false, true] as const).map((on) => (
              <button
                key={String(on)}
                role="radio"
                aria-checked={e.open === on}
                class={e.open === on ? "active" : ""}
                onMouseDown={noFocus}
                onClick={() => game.setEscalation(on)}
              >
                {on ? "Open" : "Closed"}
              </button>
            ))}
          </div>
        </div>
        <span class="hire-desc">
          Open, admitted patients with no ward bed go to an escalation trolley in a ward or corridor
          rather than waiting on an A&E trolley: corridor care. It frees A&E, but patients on one
          don't settle, and each one there at midnight costs {e.reputationPerPatient} points off
          reputation's daily score. Place escalation trolleys from Equipment → Bedding.
        </span>
        <span class={`small-note${e.trolleys === 0 ? " warn-text" : " dim"}`}>
          {e.trolleys === 0
            ? "No escalation trolleys placed in a ward or corridor yet."
            : `${e.trolleys} escalation ${e.trolleys === 1 ? "trolley" : "trolleys"}, ${e.inUse} in use · ${e.patients} ${e.patients === 1 ? "patient" : "patients"} in corridor care`}
        </span>
      </div>
    </>
  );
}

const GAP_FILLS: { id: HospitalData["policies"]["gapFill"]; label: string }[] = [
  { id: "none", label: "Unfilled" },
  { id: "bank", label: "Bank" },
  { id: "bank_agency", label: "Bank + agency" },
];

function Policies({ game, data }: { game: Game; data: HospitalData }) {
  const p = data.policies;
  const [lo, hi] = p.priceLevels;
  const demand = Math.round(100 * p.priceLevel ** -p.priceElasticity);
  return (
    <>
      <PolicyCard
        title="Visiting hours"
        note="Visitors keep inpatients' spirits up: patients visited lately settle happier, and lift while someone's with them, which shows in reputation. No visiting is for outbreaks."
      >
        <div class="chips visiting-chips" role="radiogroup" aria-label="Visiting hours">
          {p.visitingOptions.map((o) => (
            <button
              key={o.id}
              role="radio"
              aria-checked={p.visiting === o.id}
              class={p.visiting === o.id ? "active" : ""}
              title={o.label}
              onMouseDown={noFocus}
              onClick={() => game.setVisiting(o.id)}
            >
              {o.label.split(",")[0]}
            </button>
          ))}
        </div>
        <span class="dim small-note">
          {p.visitingOptions.find((o) => o.id === p.visiting)!.label}
        </span>
      </PolicyCard>
      <PolicyCard
        title="Staff flu vaccination"
        note={`Each autumn (from October), offer every member of staff the flu vaccine, at about £${p.fluVaccinationCost} a head. It halves the extra sickness a flu season brings among staff.`}
      >
        <Toggle on={p.fluVaccination} onChange={(on) => game.setFluVaccination(on)} />
      </PolicyCard>
      <PolicyCard
        title="Discharge before noon"
        note="In the morning, ward patients fit to go home later that day are reviewed at once, freeing beds before A&E's afternoon peak. The rushed round costs ward doctors and nurses a little morale."
      >
        <Toggle on={p.dischargeBeforeNoon} onChange={(on) => game.setDischargeBeforeNoon(on)} />
      </PolicyCard>
      <PolicyCard
        title="Filling rota gaps"
        note="At each shift start, places short of the cover go to the staff bank, then (if allowed) an agency at twice the cost. (Also in Staff → Rota.)"
      >
        <div class="chips" role="radiogroup" aria-label="Filling rota gaps">
          {GAP_FILLS.map((o) => (
            <button
              key={o.id}
              role="radio"
              aria-checked={p.gapFill === o.id}
              class={p.gapFill === o.id ? "active" : ""}
              onMouseDown={noFocus}
              onClick={() => game.setGapFill(o.id)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </PolicyCard>
      {p.funding !== "nhs" && (
        <PolicyCard
          title="Self-pay prices"
          note="Insurers pay their own rates; self-pay patients pay yours. Higher prices earn more from each but bring fewer."
        >
          <label class="price-level">
            <span>
              {p.priceLevel === 1
                ? "Standard"
                : `${p.priceLevel > 1 ? "+" : "−"}${Math.round(Math.abs(p.priceLevel - 1) * 100)}%`}{" "}
              · self-pay demand at {demand}% of standard
            </span>
            <input
              type="range"
              min={lo}
              max={hi}
              step={0.05}
              value={p.priceLevel}
              onInput={(e) =>
                game.setPriceLevel(Number((e.currentTarget as HTMLInputElement).value))
              }
            />
          </label>
        </PolicyCard>
      )}
      {p.funding === "private" && (
        <PolicyCard
          title="NHS referrals"
          note="NHS patients can choose an independent hospital for planned care, paid at NHS tariff and counted against the 18-week standard. Take them for:"
        >
          <div class="nhs-referrals">
            {p.nhsReferrals.map((sp) => (
              <label key={sp.id} class="setting-choice">
                <input
                  type="checkbox"
                  checked={sp.on}
                  onChange={(e) =>
                    game.setNhsReferrals(sp.id, (e.currentTarget as HTMLInputElement).checked)
                  }
                />
                <span>{sp.name}</span>
              </label>
            ))}
          </div>
        </PolicyCard>
      )}
    </>
  );
}

function PolicyCard(props: { title: string; note: string; children: preact.ComponentChildren }) {
  return (
    <div class="dept-card">
      <div class="dept-head">
        <strong>{props.title}</strong>
      </div>
      <span class="hire-desc">{props.note}</span>
      {props.children}
    </div>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <div class="chips" role="radiogroup">
      {([false, true] as const).map((v) => (
        <button
          key={String(v)}
          role="radio"
          aria-checked={on === v}
          class={on === v ? "active" : ""}
          onMouseDown={noFocus}
          onClick={() => onChange(v)}
        >
          {v ? "On" : "Off"}
        </button>
      ))}
    </div>
  );
}

const RAG_WORDS = { ok: "Meeting the standard", warn: "Short of it", bad: "Well short of it" };

/**
 * The integrated performance report: each KPI this month so far and the
 * months before, rated against its standard.
 */
function Performance({ data }: { data: HospitalData["performance"] }) {
  const sections = [...new Set(data.rows.map((r) => r.section))];
  return (
    <>
      <p class="dim small-note">
        What a trust board sees each month: each measure against its national standard (or the usual
        benchmark), green when it's met, amber when it's short and red when it's well short. This
        month counts the days filed so far, at midnight each day.
      </p>
      <table class="report-table kpi-table">
        <thead>
          <tr>
            <th />
            <th class="num">Standard</th>
            {data.months.map((m, i) => (
              <th key={i} class="num">
                {m.name}
                <span class="dim sub">
                  {i === 0 ? "so far, " : ""}
                  {m.days} {m.days === 1 ? "day" : "days"}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        {sections.map((section) => (
          <tbody key={section}>
            <tr class="kpi-section">
              <td colSpan={2 + data.months.length}>{section}</td>
            </tr>
            {data.rows
              .filter((r) => r.section === section)
              .map((r) => (
                <tr key={r.id}>
                  <td title={r.title}>{r.label}</td>
                  <td class="num dim">{r.standard}</td>
                  {r.cells.map((c, i) => (
                    <td
                      key={i}
                      class={`num kpi-cell ${c.rag}`}
                      title={c.rag === "none" ? undefined : RAG_WORDS[c.rag]}
                    >
                      {c.rag !== "none" && <span class={`rag-dot ${c.rag}`} aria-hidden="true" />}
                      {c.text}
                    </td>
                  ))}
                </tr>
              ))}
          </tbody>
        ))}
      </table>
    </>
  );
}

const FREQUENCY_WORDS = {
  off: "Events are off (Settings).",
  rare: "Events come about half as often as in real life (Settings).",
  realistic:
    "Events follow the calendar at about real-world rates: flu seasons in winter, heatwaves in summer (Settings).",
  frequent: "Events come about twice as often as in real life (Settings).",
};

/** Pressure events forecast or under way, what they do and the levers; and past ones. */
function Events({ game, data }: { game: Game; data: HospitalData["events"] }) {
  const mi = data.majorIncident;
  return (
    <>
      <p class="dim small-note">{FREQUENCY_WORDS[data.frequency]}</p>
      {mi && (
        <div class={`dept-card major-incident${mi.declared ? " declared" : ""}`}>
          <div class="dept-head">
            <strong>
              {mi.declared
                ? "Major incident declared"
                : mi.underWay
                  ? "Major incident: casualties arriving"
                  : "Major incident: standby"}
            </strong>
            {mi.declared ? (
              <button class="small-button" onClick={() => game.standDownMajorIncident()}>
                Stand down
              </button>
            ) : (
              <button class="small-button danger" onClick={() => game.declareMajorIncident()}>
                Declare a major incident
              </button>
            )}
          </div>
          <span class="hire-desc">
            {mi.cause.replace(/^./, (c) => c.toUpperCase())}. {mi.arrived} of about {mi.expected}{" "}
            casualties here so far
            {mi.critical > 0 ? `, ${mi.critical} critically injured still to come` : ""}.
          </span>
          <span class="dim small-note">
            {mi.declared
              ? `${mi.asked === 0 ? "Nobody was off duty to call in." : `${mi.calledIn} of ${mi.asked} off-duty staff have come in${mi.coming > 0 ? `, ${mi.coming} more on their way` : ""}, on overtime.`} Clinics and planned operations are stood down and escalation beds are open. Stand down once A&E has recovered.`
              : "Declaring calls in off-duty staff (about 60% answer, within an hour or so, at time and a half), stands down clinics and planned operations, opens escalation beds, and reviews every ward patient due home within a day. Without it, you face the wave with the staff on shift."}
          </span>
        </div>
      )}
      {data.active.length === 0 && !mi && <p class="dim">Nothing forecast. All quiet, for now.</p>}
      {data.active.map((e) => (
        <div key={e.id} class={`dept-card event-card${e.coming ? " coming" : " restricted"}`}>
          <div class="dept-head">
            <strong>{e.name}</strong>
            <span class="dim">{e.coming ? "Forecast" : "Under way"}</span>
          </div>
          <span class="dim small-note">{e.when}</span>
          {!e.coming && e.shape === "wave" && (
            <div class="meter" title="How strong it is now: it builds, peaks and fades">
              <div class="meter-fill warn" style={{ width: `${Math.round(e.intensity * 100)}%` }} />
            </div>
          )}
          <span class="hire-desc">{e.description}</span>
          <strong class="event-levers-title">What you can do</strong>
          <ul class="event-levers">
            {e.levers.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        </div>
      ))}
      {data.uncooled && (
        <div class="report-group">
          <h4>Rooms without enough cooling</h4>
          {data.uncooled.length === 0 ? (
            <p class="dim small-note">Every room patients wait or stay in is cooled.</p>
          ) : (
            <ul class="event-levers">
              {data.uncooled.map((r) => (
                <li key={r.name}>
                  {r.count} × {r.name}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {data.past.length > 0 && (
        <div class="report-group">
          <h4>Past events</h4>
          <table class="report-table">
            <tbody>
              {data.past.map((p, i) => (
                <tr key={i}>
                  <td>{p.name}</td>
                  <td class="num dim">{p.dates}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
