/**
 * The Patients dialog: everyone in the hospital as a patient, at a glance:
 * each patient's condition, triage category, where they are in their visit
 * and how they're doing against their targets. The game keeps running behind
 * it. Clicking a name shows that patient on the map and in the inspector.
 * (Staff have the Staff screen.)
 */
import type { Game } from "@game/game";
import { useState } from "preact/hooks";
import { MoodMeter } from "./Inspector";
import { patientsOpen, patientTable, type PatientRow } from "./store";

const noFocus = (e: MouseEvent) => e.preventDefault();

export function PatientsDialog({ game }: { game: Game }) {
  if (!patientsOpen.value) return null;
  // Show the patient, and get the dialog out of the way.
  const show = (id: number) => {
    patientsOpen.value = false;
    game.showAgent(id);
  };
  return (
    <section class="panel people-dialog" role="dialog" aria-label="Patients">
      <header class="people-header">
        <h2>Patients</h2>
        <button class="close" title="Close (Esc)" onClick={() => (patientsOpen.value = false)}>
          ×
        </button>
      </header>
      <PatientsTab onShow={show} />
    </section>
  );
}

// ---------- Patients ----------

type PatientFilter = "all" | "waiting" | "treatment" | "ward" | "attention";
type PatientSort = "urgency" | "wait" | "mood";

const PATIENT_FILTERS: { id: PatientFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "waiting", label: "Waiting" },
  { id: "treatment", label: "Being seen" },
  { id: "ward", label: "On wards" },
  { id: "attention", label: "Needs attention" },
];

/**
 * Something needs doing: a clinical alert, an overdue target, unhappy, or an
 * unmet need. On a ward only the alerts count: a 4-hour breach or low mood
 * there is left over from A&E (and mood recovers on the ward).
 */
const needsAttention = (r: PatientRow) =>
  r.alerts.length > 0 ||
  (r.group !== "ward" &&
    (r.overdue || r.breached || r.mood < 30 || r.needs.some((n) => n !== "At the toilet")));

function PatientsTab({ onShow }: { onShow: (id: number) => void }) {
  const [filter, setFilter] = useState<PatientFilter>("all");
  const [sort, setSort] = useState<PatientSort>("urgency");
  const data = patientTable.value;
  if (!data) return null;
  const c = data.counts;
  let rows = data.rows.filter((r) =>
    filter === "all"
      ? r.group !== "ward"
      : filter === "ward"
        ? r.group === "ward"
        : filter === "attention"
          ? needsAttention(r)
          : filter === "waiting"
            ? r.group === "waiting" || r.group === "arriving"
            : r.group === "treatment",
  );
  if (sort === "wait") rows = [...rows].sort((a, b) => b.inDeptMins - a.inDeptMins);
  if (sort === "mood") rows = [...rows].sort((a, b) => a.mood - b.mood);

  return (
    <>
      <p class="people-summary">
        <strong>{c.total}</strong> in A&E · {c.arriving} arriving · {c.waiting} waiting ·{" "}
        {c.treatment} being seen
        {c.breached > 0 && <span class="bad-text"> · {c.breached} over 4 hours</span>}
        {c.ward > 0 && <span> · {c.ward} on wards</span>}
        {data.longestWait && <span class="dim"> · longest stay {data.longestWait}</span>}
      </p>
      <div class="people-controls">
        <div class="chips" role="group" aria-label="Filter">
          {PATIENT_FILTERS.map((f) => (
            <button
              key={f.id}
              class={filter === f.id ? "active" : ""}
              aria-pressed={filter === f.id}
              onMouseDown={noFocus}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <label class="sort">
          Sort{" "}
          <select
            value={sort}
            onChange={(e) => setSort((e.currentTarget as HTMLSelectElement).value as PatientSort)}
          >
            <option value="urgency">Most urgent</option>
            <option value="wait">Longest in A&E</option>
            <option value="mood">Unhappiest</option>
          </select>
        </label>
      </div>
      <div class="people-scroll">
        {rows.length === 0 ? (
          <p class="dim empty">{c.total === 0 ? "No patients in A&E." : "No one matches."}</p>
        ) : (
          <table class="people-table">
            <thead>
              <tr>
                <th>Patient</th>
                <th>Triage</th>
                <th>Status</th>
                <th>Target</th>
                <th class="num">In A&E</th>
                <th>Mood</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} onClick={() => onShow(r.id)} title="Show on the map">
                  <td>
                    <strong>{r.name}</strong>
                    <span class="sub">{r.condition}</span>
                  </td>
                  <td>
                    {r.admittedTo ? (
                      <>
                        Inpatient
                        <span class="sub">{r.admittedTo}</span>
                      </>
                    ) : r.category ? (
                      <span
                        class="triage-chip"
                        style={{ background: r.category.colour }}
                        title={`To be seen ${r.category.target}`}
                      >
                        {r.category.label}
                      </span>
                    ) : (
                      <span class="dim">Not yet</span>
                    )}
                  </td>
                  <td>
                    {r.status}
                    <span class="sub">{r.where}</span>
                    {r.alerts.map((a) => (
                      <span key={a} class="sub bad-text">
                        {a}
                      </span>
                    ))}
                    {r.reason && <span class="sub warn-text">{r.reason}</span>}
                  </td>
                  <td class={r.overdue ? "bad-text" : r.target === "Seen" ? "ok-text" : ""}>
                    {r.target}
                  </td>
                  {r.group === "ward" ? (
                    <td
                      class="num dim"
                      title={r.breached ? "Breached the 4-hour standard in A&E" : undefined}
                    >
                      {r.inDept}
                    </td>
                  ) : (
                    <td class={`num${r.breached ? " bad-text" : ""}`}>{r.inDept}</td>
                  )}
                  <td>
                    <MoodMeter mood={r.mood} small />
                    {r.needs.length > 0 && <span class="sub warn-text">{r.needs.join(" · ")}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
