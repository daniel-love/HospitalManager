/**
 * Daily P&L and A&E performance (GAME_DESIGN §8.1, §8.5): today so far, the
 * department right now, and the last week of daily reports.
 */
import { formatMoney } from "@game/tools";
import { net, type FlowStats, type Ledger } from "@sim/agents";
import { report, sidePanel } from "./store";

const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((100 * n) / d)}%`);
const avgMins = (total: number, n: number) => (n === 0 ? "—" : `${Math.round(total / n)} min`);

export function ReportsPanel({ onShow }: { onShow: (at: { x: number; y: number }) => void }) {
  const data = report.value;
  if (sidePanel.value !== "reports" || !data) return null;
  const { today } = data;
  const recent = data.history.slice(-7).reverse();
  return (
    <aside class="panel side-panel" aria-label="Reports">
      <button class="close" title="Close" onClick={() => (sidePanel.value = null)}>
        ×
      </button>
      <div class="side-scroll">
        <h2>Reports</h2>
        <h3>Today so far</h3>
        <MoneyTable ledger={today.ledger} />
        <FlowTable stats={today.stats} />

        {data.fourHourWeek !== null && (
          <p class="dim">
            4-hour standard over the last 7 days: {Math.round(data.fourHourWeek * 100)}% (target
            95%)
          </p>
        )}

        <h3>In the department now</h3>
        {data.now.length === 0 ? (
          <p class="dim">No patients.</p>
        ) : (
          <table class="report-table">
            <tbody>
              {data.now.map((r) => (
                <tr key={r.label}>
                  <td>{r.label}</td>
                  <td class="num">{r.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p class="dim">
          Waiting area seats: {data.waitingSeats.taken} of {data.waitingSeats.total} taken
        </p>
        {(data.wardBeds.total > 0 || data.wardBeds.waiting > 0) && (
          <p class={data.wardBeds.waiting > 0 ? "warn-text" : "dim"}>
            Ward beds: {data.wardBeds.inUse} of {data.wardBeds.total} in use
            {data.wardBeds.waiting > 0 &&
              `, ${data.wardBeds.waiting} admitted ${data.wardBeds.waiting === 1 ? "patient" : "patients"} waiting in A&E`}
          </p>
        )}
        {(data.mortuary.total > 0 || data.mortuary.awaitingReview > 0) && (
          <p class={data.mortuary.taken >= data.mortuary.total ? "warn-text" : "dim"}>
            Mortuary: {data.mortuary.taken} of {data.mortuary.total} spaces in use
            {data.mortuary.awaitingReview > 0 &&
              `, ${data.mortuary.awaitingReview} awaiting Medical Examiner review`}
          </p>
        )}
        {data.ambulances.spaces > 0 && (
          <p class={data.ambulances.waiting > 0 ? "warn-text" : "dim"}>
            Ambulances: {data.ambulances.parked} of {data.ambulances.spaces} bay spaces in use
            {data.ambulances.waiting > 0 && `, ${data.ambulances.waiting} waiting outside`}
          </p>
        )}

        <h3>Patient safety incidents</h3>
        {data.incidents.length === 0 ? (
          <p class="dim">None recorded.</p>
        ) : (
          <ul class="incidents">
            {data.incidents.map((i) => (
              <li key={i.id}>
                <button class="incident-head" title="Show on the map" onClick={() => onShow(i.at)}>
                  <span class="when">{i.when}</span> {i.summary}
                </button>
                <p class="dim">
                  {i.patient} · {i.where}
                </p>
                <ul class="causes">
                  {i.causes.map((c) => (
                    <li key={c}>{c}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}

        <h3>Previous days</h3>
        {recent.length === 0 ? (
          <p class="dim">The first daily report is filed at midnight.</p>
        ) : (
          <table class="report-table days">
            <thead>
              <tr>
                <th>Day</th>
                <th class="num">Seen</th>
                <th class="num">LWBS</th>
                <th class="num" title="Patient safety incidents">
                  Inc.
                </th>
                <th class="num">4-hr</th>
                <th class="num">Net</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((d) => {
                const n = net(d.ledger);
                return (
                  <tr key={d.day}>
                    <td>{d.day}</td>
                    <td class="num">{d.stats.discharged}</td>
                    <td class="num">{d.stats.lwbs}</td>
                    <td class={`num${d.stats.incidents > 0 ? " bad" : ""}`}>{d.stats.incidents}</td>
                    <td class="num">{pct(d.stats.within4h, d.stats.departures)}</td>
                    <td class={`num ${n < 0 ? "bad" : "ok"}`}>{formatMoney(n)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </aside>
  );
}

function MoneyTable({ ledger }: { ledger: Ledger }) {
  const n = net(ledger);
  return (
    <table class="report-table">
      <tbody>
        <tr>
          <td>Tariff income</td>
          <td class="num ok">{formatMoney(ledger.tariff)}</td>
        </tr>
        <tr>
          <td>Salaries</td>
          <td class="num bad">−{formatMoney(ledger.salaries)}</td>
        </tr>
        <tr>
          <td>Equipment upkeep</td>
          <td class="num bad">−{formatMoney(ledger.upkeep)}</td>
        </tr>
        <tr class="total">
          <td>Net</td>
          <td class={`num ${n < 0 ? "bad" : "ok"}`}>{formatMoney(n)}</td>
        </tr>
      </tbody>
    </table>
  );
}

function FlowTable({ stats: s }: { stats: FlowStats }) {
  return (
    <table class="report-table">
      <tbody>
        <tr>
          <td>Arrivals</td>
          <td class="num">{s.arrivals}</td>
        </tr>
        <tr>
          <td>Treated and discharged</td>
          <td class="num">{s.discharged}</td>
        </tr>
        <tr>
          <td title="Left without being seen">Left without being seen</td>
          <td class="num">
            {s.lwbs} <span class="dim">({pct(s.lwbs, s.departures)})</span>
          </td>
        </tr>
        <tr>
          <td>Transferred to intensive care</td>
          <td class="num">{s.transferred}</td>
        </tr>
        <tr>
          <td>Patient safety incidents</td>
          <td class={`num${s.incidents > 0 ? " bad" : ""}`}>{s.incidents}</td>
        </tr>
        <tr>
          <td title="Share of patients leaving within 4 hours of arriving (target 95%)">
            4-hour standard
          </td>
          <td class="num">{pct(s.within4h, s.departures)}</td>
        </tr>
        <tr>
          <td title="Expected deaths (end-of-life care) and unexpected (after resuscitation)">
            Deaths
          </td>
          <td class="num">
            {s.deaths}
            {s.unexpectedDeaths > 0 && <span class="dim"> ({s.unexpectedDeaths} unexpected)</span>}
          </td>
        </tr>
        {s.complaints > 0 && (
          <tr>
            <td title="About how deaths were handled: privacy, breaking news, the route to the mortuary">
              Complaints
            </td>
            <td class="num bad">{s.complaints}</td>
          </tr>
        )}
        <tr>
          <td>Admitted to a ward</td>
          <td class="num">{s.admissions}</td>
        </tr>
        <tr>
          <td title="Decision to admit until leaving A&E for the ward">
            Average wait for a ward bed
          </td>
          <td class="num">{avgMins(s.bedWaitMins, s.admissions)}</td>
        </tr>
        <tr>
          <td title="Admitted patients who waited over 4 hours (and over 12) on an A&E trolley">
            Trolley waits over 4 hours
          </td>
          <td class={`num${s.bedWaitsOver4h > 0 ? " bad" : ""}`}>
            {s.bedWaitsOver4h}
            {s.bedWaitsOver12h > 0 && <span class="dim"> ({s.bedWaitsOver12h} over 12)</span>}
          </td>
        </tr>
        <tr>
          <td>Discharged home from a ward</td>
          <td class="num">{s.wardDischarges}</td>
        </tr>
        {s.transfersOut > 0 && (
          <tr>
            <td title="Needed admitting, but there's no ward">Sent to another hospital</td>
            <td class="num bad">{s.transfersOut}</td>
          </tr>
        )}
        <tr>
          <td>Ambulance arrivals</td>
          <td class="num">{s.ambulances}</td>
        </tr>
        <tr>
          <td title="Ambulance arrival to handover to A&E staff (target 15 min)">
            Average ambulance handover
          </td>
          <td class="num">{avgMins(s.handoverMins, s.handovers)}</td>
        </tr>
        <tr>
          <td title="Handovers taking over 30 minutes (and over 60)">Handovers over 30 min</td>
          <td class={`num${s.handoversOver30 > 0 ? " bad" : ""}`}>
            {s.handoversOver30}
            {s.handoversOver60 > 0 && <span class="dim"> ({s.handoversOver60} over 60)</span>}
          </td>
        </tr>
        <tr>
          <td title="Arrival to start of triage (target 15 min)">Average wait for triage</td>
          <td class="num">{avgMins(s.triageWaitMins, s.triaged)}</td>
        </tr>
        <tr>
          <td>Average time in A&E</td>
          <td class="num">{avgMins(s.timeInDeptMins, s.departures)}</td>
        </tr>
      </tbody>
    </table>
  );
}
