/**
 * The Help panel: recommendations (what to build and hire next, checked
 * against the hospital as it is) and a reference to every room, staff role
 * and condition, built from the game data.
 */
import type { AdviceData, AdviceItem } from "@game/advice";
import { signal } from "@preact/signals";
import { useMemo, useState } from "preact/hooks";
import { conditionGuide, roomGuide, staffGuide, type GuideSection } from "./handbook";
import { advice, sidePanel } from "./store";

type HelpTab = "advice" | "rooms" | "staff" | "conditions";
const TABS: { id: HelpTab; label: string }[] = [
  { id: "advice", label: "Recommendations" },
  { id: "rooms", label: "Rooms" },
  { id: "staff", label: "Staff" },
  { id: "conditions", label: "Conditions" },
];
/** Kept between openings. */
const helpTab = signal<HelpTab>("advice");

const noFocus = (e: MouseEvent) => e.preventDefault();

export function HelpPanel() {
  if (sidePanel.value !== "help") return null;
  const tab = helpTab.value;
  return (
    <aside class="panel side-panel help-panel" aria-label="Help">
      <header class="help-header">
        <div class="tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              class={tab === t.id ? "active" : ""}
              onMouseDown={noFocus}
              onClick={() => (helpTab.value = t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button class="close" title="Close (H)" onClick={() => (sidePanel.value = null)}>
          ×
        </button>
      </header>
      <div class="side-scroll" key={tab}>
        {tab === "advice" ? (
          advice.value && <Advice data={advice.value} />
        ) : (
          <Guide key={tab} tab={tab} />
        )}
      </div>
    </aside>
  );
}

/* ---------- Recommendations ---------- */

const MARKS = { ok: "✓", todo: "○", optional: "+" } as const;

function Advice({ data }: { data: AdviceData }) {
  const { walkIns, ambulances, catchment } = data.demand;
  return (
    <>
      {data.next ? (
        <div class="advice-next">
          <h3>Next step</h3>
          <p class="advice-next-text">{data.next.text}</p>
          <p class="dim">{data.next.detail}</p>
        </div>
      ) : (
        <div class="advice-next done">
          <p class="advice-next-text">Everything on the checklist is in place.</p>
          <p class="dim">Check the suggested numbers below as demand grows.</p>
        </div>
      )}

      {data.groups.map((g) => {
        const done = g.items.filter((i) => i.status === "ok").length;
        const complete = !g.items.some((i) => i.status === "todo");
        return (
          <section key={g.heading} class="advice-group">
            <h3>
              {g.heading}
              <span class={`advice-count${complete ? " ok-text" : ""}`}>
                {done} of {g.items.length}
              </span>
            </h3>
            <p class="dim">{g.intro}</p>
            <ul class="advice-list">
              {g.items.map((i) => (
                <Item key={i.text} item={i} />
              ))}
            </ul>
          </section>
        );
      })}

      <section class="advice-group">
        <h3>Suggested numbers</h3>
        <p class="dim">
          A catchment of {catchment.toLocaleString("en-GB")} people brings about {walkIns} walk-ins
          and {ambulances} ambulances a day, busiest from late morning to early evening. A rough
          guide for that peak; until shift rotas arrive, everyone works round the clock.
        </p>
        <table class="capacity-table">
          <thead>
            <tr>
              <th scope="col">For the whole catchment</th>
              <th scope="col">You have</th>
              <th scope="col">Suggested</th>
            </tr>
          </thead>
          <tbody>
            {data.capacity.map((r) => (
              <tr key={r.label} title={r.note}>
                <th scope="row">
                  {r.label}
                  <div class="dim">{r.note}</div>
                </th>
                <td class={r.recommended !== null && r.have < r.recommended ? "warn-text" : ""}>
                  {r.have}
                </td>
                <td>{r.recommended ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

function Item({ item }: { item: AdviceItem }) {
  return (
    <li class={`advice-item ${item.status}`}>
      <span
        class="advice-mark"
        aria-label={item.status === "ok" ? "Done" : item.status === "todo" ? "To do" : "Optional"}
      >
        {MARKS[item.status]}
      </span>
      <div>
        <div class="advice-text">
          {item.text}
          {item.status === "optional" && <span class="dim"> (recommended)</span>}
        </div>
        <div class="dim">{item.detail}</div>
      </div>
    </li>
  );
}

/* ---------- Reference ---------- */

const GUIDES: Record<Exclude<HelpTab, "advice">, { intro: string; build: () => GuideSection[] }> = {
  rooms: {
    intro:
      "Zone a room, then furnish it: it works only when every requirement is met. Hover a room on the map to see what it's missing.",
    build: roomGuide,
  },
  staff: {
    intro: "Who does what, and what they need to do it. Hire from the Hire panel.",
    build: staffGuide,
  },
  conditions: {
    intro:
      "Every walk-in books in and is triaged first; ambulance patients are handed over to a nurse. Then each condition follows its own treatment.",
    build: conditionGuide,
  },
};

function Guide({ tab }: { tab: Exclude<HelpTab, "advice"> }) {
  const guide = GUIDES[tab];
  const sections = useMemo(guide.build, [guide]);
  const [filter, setFilter] = useState("");
  const q = filter.trim().toLowerCase();
  const matches = (text: string) => text.toLowerCase().includes(q);
  const shown = sections
    .map((s) => ({
      ...s,
      entries: s.entries.filter(
        (e) =>
          q === "" ||
          matches(e.title) ||
          matches(e.body) ||
          e.sections.some((x) => x.items.some(matches)),
      ),
    }))
    .filter((s) => s.entries.length > 0);
  return (
    <>
      <p class="dim">{guide.intro}</p>
      <input
        class="help-filter"
        type="search"
        placeholder="Filter"
        aria-label="Filter"
        value={filter}
        onInput={(e) => setFilter(e.currentTarget.value)}
      />
      {shown.length === 0 && <p class="dim">Nothing matches.</p>}
      {shown.map((s) => (
        <section key={s.name} class="guide-section">
          <h3>{s.name}</h3>
          {s.entries.map((e) => (
            <details key={e.id} class="guide-entry" open={q !== ""}>
              <summary>
                <span class="guide-title">{e.title}</span>
                <span class="dim"> {e.subtitle}</span>
              </summary>
              <p>{e.body}</p>
              {e.sections.map((x) => (
                <div key={x.heading} class="help-section">
                  <h4>{x.heading}</h4>
                  <ul>
                    {x.items.map((i) => (
                      <li key={i}>{i}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </details>
          ))}
        </section>
      ))}
    </>
  );
}
