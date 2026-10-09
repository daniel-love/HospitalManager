/**
 * Daily P&L and A&E performance (GAME_DESIGN §8.1, §8.5): headline figures for
 * today, the department right now, trends over the last fortnight, incidents
 * and the daily reports.
 */
import { formatMoney } from "@game/tools";
import { net, type DayReport, type FlowStats, type Ledger } from "@sim/agents";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { report, sidePanel, type ReportData } from "./store";

/** The constitutional standard and the current interim target. */
const FOUR_HOUR_TARGET = 0.95;
const FOUR_HOUR_INTERIM = 0.78;
/** Ambulance handover and arrival-to-triage targets, in minutes. */
const HANDOVER_TARGET = 15;
const TRIAGE_TARGET = 15;
const TREND_DAYS = 14;
const TABLE_DAYS = 14;

type Status = "ok" | "warn" | "bad" | "none";

const pct = (n: number, d: number) => (d === 0 ? "—" : `${Math.round((100 * n) / d)}%`);
const avg = (total: number, n: number) => (n === 0 ? null : Math.round(total / n));
const mins = (m: number | null) => (m === null ? "—" : `${m} min`);
const share = (n: number, d: number) => (d === 0 ? null : n / d);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function fourHourStatus(s: number | null): Status {
  if (s === null) return "none";
  return s >= FOUR_HOUR_TARGET ? "ok" : s >= FOUR_HOUR_INTERIM ? "warn" : "bad";
}

const STATUS_WORDS: Record<Status, string> = {
  ok: "On target",
  warn: "Below 95%",
  bad: "Below 78%",
  none: "No departures yet",
};

export function ReportsPanel({ onShow }: { onShow: (at: { x: number; y: number }) => void }) {
  const data = report.value;
  const [hovered, setHovered] = useState<number | null>(null);
  if (sidePanel.value !== "reports" || !data) return null;
  const { today } = data;
  const trend = data.history.slice(-TREND_DAYS);
  const recent = data.history.slice(-TABLE_DAYS).reverse();
  return (
    <aside class="panel side-panel reports-panel" aria-label="Reports">
      <button class="close" title="Close" onClick={() => (sidePanel.value = null)}>
        ×
      </button>
      <div class="side-scroll">
        <h2>Reports</h2>
        <Headlines data={data} />

        <div class="reports-cols">
          <div>
            <h3>Today so far</h3>
            <MoneySection ledger={today.ledger} />
            <FlowSections stats={today.stats} />
          </div>
          <div>
            <h3>In the department now</h3>
            <Capacity data={data} />
            <Stages now={data.now} />

            <h3>Last {TREND_DAYS} days</h3>
            {trend.length === 0 ? (
              <p class="dim">Trends appear once the first daily report is filed at midnight.</p>
            ) : (
              <Trends days={trend} hovered={hovered} onHover={setHovered} />
            )}
          </div>
        </div>

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

        <h3>Daily reports</h3>
        {recent.length === 0 ? (
          <p class="dim">The first daily report is filed at midnight.</p>
        ) : (
          <DayTable days={recent} hovered={hovered} onHover={setHovered} />
        )}
      </div>
    </aside>
  );
}

/* ---------- Headline tiles ---------- */

function Headlines({ data }: { data: ReportData }) {
  const s = data.today.stats;
  const l = data.today.ledger;
  const four = share(s.within4h, s.departures);
  const fourStatus = fourHourStatus(four);
  const n = net(l);
  const harm = s.incidents + s.unexpectedDeaths + s.complaints;
  return (
    <div class="kpis">
      <Tile
        label="4-hour standard"
        title="Share of patients leaving A&E within 4 hours of arriving. Constitutional standard 95%, interim target 78%."
        value={four === null ? "—" : `${Math.round(four * 100)}%`}
        status={fourStatus}
        note={
          <>
            {STATUS_WORDS[fourStatus]}
            {data.fourHourWeek !== null && ` · 7 days ${Math.round(data.fourHourWeek * 100)}%`}
          </>
        }
      >
        <div class="kpi-meter">
          <div
            class={`kpi-meter-fill ${fourStatus}`}
            style={{ width: `${Math.round((four ?? 0) * 100)}%` }}
          />
          <span class="kpi-tick" style={{ left: `${FOUR_HOUR_INTERIM * 100}%` }} />
          <span class="kpi-tick" style={{ left: `${FOUR_HOUR_TARGET * 100}%` }} />
        </div>
      </Tile>
      <Tile
        label="Net today"
        value={formatMoney(n)}
        status={n < 0 ? "bad" : n > 0 ? "ok" : "none"}
        note={`${formatMoney(l.tariff)} in · ${formatMoney(l.salaries + l.upkeep + l.transfers)} out`}
      />
      <Tile
        label="Patients"
        value={String(s.arrivals)}
        status="none"
        note={`arrived · ${s.discharged} discharged · ${s.admissions} admitted`}
      />
      <Tile
        label="Safety"
        title="Patient safety incidents, unexpected deaths and complaints today"
        value={String(s.incidents)}
        status={harm > 0 ? "bad" : "ok"}
        note={
          harm === 0
            ? "No incidents"
            : `${s.incidents === 1 ? "incident" : "incidents"} · ${plural(s.deaths, "death")}${s.complaints > 0 ? ` · ${plural(s.complaints, "complaint")}` : ""}`
        }
      />
    </div>
  );
}

function Tile(props: {
  label: string;
  value: string;
  status: Status;
  note: ComponentChildren;
  title?: string;
  children?: ComponentChildren;
}) {
  return (
    <div class={`kpi ${props.status}`} title={props.title}>
      <div class="kpi-label">{props.label}</div>
      <div class="kpi-value">{props.value}</div>
      {props.children}
      <div class="kpi-note">{props.note}</div>
    </div>
  );
}

/* ---------- Today ---------- */

function MoneySection({ ledger }: { ledger: Ledger }) {
  const n = net(ledger);
  const costs = ledger.salaries + ledger.upkeep + ledger.transfers;
  const scale = Math.max(ledger.tariff, costs, 1);
  return (
    <div class="report-group">
      <h4>Finance</h4>
      <div class="money-bars" aria-hidden="true">
        <div class="money-bar">
          <span class="money-fill income" style={{ width: `${(100 * ledger.tariff) / scale}%` }} />
        </div>
        <div class="money-bar">
          <span
            class="money-fill salaries"
            style={{ width: `${(100 * ledger.salaries) / scale}%` }}
          />
          <span class="money-fill upkeep" style={{ width: `${(100 * ledger.upkeep) / scale}%` }} />
          <span
            class="money-fill transport"
            style={{ width: `${(100 * ledger.transfers) / scale}%` }}
          />
        </div>
      </div>
      <table class="report-table">
        <tbody>
          <Row
            label={<Swatch kind="income">Tariff income</Swatch>}
            value={formatMoney(ledger.tariff)}
          />
          <Row
            label={<Swatch kind="salaries">Salaries</Swatch>}
            value={`−${formatMoney(ledger.salaries)}`}
          />
          <Row
            label={<Swatch kind="upkeep">Equipment upkeep</Swatch>}
            value={`−${formatMoney(ledger.upkeep)}`}
          />
          {ledger.transfers > 0 && (
            <Row
              label={<Swatch kind="transport">Transfer ambulances</Swatch>}
              value={`−${formatMoney(ledger.transfers)}`}
            />
          )}
          <tr class="total">
            <td>Net</td>
            <td class={`num ${n < 0 ? "bad" : "ok"}`}>{formatMoney(n)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Swatch({ kind, children }: { kind: string; children: ComponentChildren }) {
  return (
    <span class="swatch-label">
      <span class={`money-swatch ${kind}`} />
      {children}
    </span>
  );
}

function FlowSections({ stats: s }: { stats: FlowStats }) {
  const handover = avg(s.handoverMins, s.handovers);
  const triage = avg(s.triageWaitMins, s.triaged);
  return (
    <>
      <div class="report-group">
        <h4>Front door</h4>
        <table class="report-table">
          <tbody>
            <Row label="Arrivals" value={s.arrivals} />
            <Row label="By ambulance" value={s.ambulances} />
            {s.deflected > 0 && (
              <Row
                label="Sent elsewhere by ambulance control"
                title="Ambulance control took them to another hospital because crews were already queueing outside"
                value={s.deflected}
                bad
              />
            )}
            <Row
              label="Average ambulance handover"
              title={`Ambulance arrival to handover to A&E staff (target ${HANDOVER_TARGET} min)`}
              value={mins(handover)}
              target={`${HANDOVER_TARGET}`}
              bad={handover !== null && handover > HANDOVER_TARGET}
            />
            <Row
              label="Handovers over 30 min"
              title="Handovers taking over 30 minutes (and over 60)"
              value={s.handoversOver30}
              extra={s.handoversOver60 > 0 ? `${s.handoversOver60} over 60` : undefined}
              bad={s.handoversOver30 > 0}
            />
            <Row
              label="Average wait for triage"
              title={`Arrival to start of triage (target ${TRIAGE_TARGET} min)`}
              value={mins(triage)}
              target={`${TRIAGE_TARGET}`}
              bad={triage !== null && triage > TRIAGE_TARGET}
            />
          </tbody>
        </table>
      </div>

      <div class="report-group">
        <h4>Outcomes</h4>
        <table class="report-table">
          <tbody>
            <Row label="Treated and discharged" value={s.discharged} />
            <Row
              label="Left without being seen"
              value={s.lwbs}
              extra={pct(s.lwbs, s.departures)}
              bad={s.lwbs > 0}
            />
            <Row label="Transferred to intensive care" value={s.transferred} />
            <Row label="Average time in A&E" value={mins(avg(s.timeInDeptMins, s.departures))} />
          </tbody>
        </table>
      </div>

      <div class="report-group">
        <h4>Admissions</h4>
        <table class="report-table">
          <tbody>
            <Row
              label="Specialty reviews in A&E"
              title="Referred patients reviewed by a specialty registrar or consultant"
              value={s.referrals}
            />
            {s.referrals > 0 && (
              <Row
                label="Average referral to decision"
                title="From referral to the specialty until their review ends in a decision to admit"
                value={mins(avg(s.referralMins, s.referrals))}
              />
            )}
            <Row label="Admitted to a ward" value={s.admissions} />
            <Row
              label="Average wait for a ward bed"
              title="Decision to admit until leaving A&E for the ward"
              value={mins(avg(s.bedWaitMins, s.admissions))}
            />
            <Row
              label="Trolley waits over 4 hours"
              title="Admitted patients who waited over 4 hours (and over 12) on an A&E trolley"
              value={s.bedWaitsOver4h}
              extra={s.bedWaitsOver12h > 0 ? `${s.bedWaitsOver12h} over 12` : undefined}
              bad={s.bedWaitsOver4h > 0}
            />
            {s.transfersOut > 0 && (
              <>
                <Row
                  label="Transferred to another hospital"
                  title="Couldn't be treated or admitted here"
                  value={s.transfersOut}
                  bad
                />
                <Row
                  label="Average wait to be transferred"
                  title="Decision to transfer until the transfer ambulance took them"
                  value={mins(avg(s.transferWaitMins, s.transfersOut))}
                />
              </>
            )}
            {s.outliers > 0 && (
              <Row
                label="Outliers"
                title="Admitted to another specialty's ward because theirs was full"
                value={s.outliers}
                bad
              />
            )}
            <Row label="Discharged home from a ward" value={s.wardDischarges} />
          </tbody>
        </table>
      </div>

      <div class="report-group">
        <h4>Diagnostics</h4>
        <table class="report-table">
          <tbody>
            <Row label="X-rays" value={s.xrays} />
            <Row label="CT scans" value={s.ctScans} />
            {s.ctScans > 0 && (
              <>
                <Row
                  label="Average arrival to CT"
                  title="From arriving in A&E to the CT scan starting"
                  value={mins(avg(s.doorToCtMins, s.ctScans))}
                />
                <Row
                  label="CT within an hour of request"
                  title="NICE: a CT head within an hour for head injuries that need one"
                  value={`${Math.round((100 * s.ctWithinTarget) / s.ctScans)}%`}
                  bad={s.ctWithinTarget < s.ctScans}
                />
              </>
            )}
            <Row label="Blood results" value={s.bloodResults} />
            {s.bloodResults > 0 && (
              <Row
                label="Average blood turnaround"
                title="From the sample being taken to the results being back"
                value={mins(avg(s.bloodResultMins, s.bloodResults))}
              />
            )}
          </tbody>
        </table>
      </div>

      <div class="report-group">
        <h4>Safety</h4>
        <table class="report-table">
          <tbody>
            <Row label="Patient safety incidents" value={s.incidents} bad={s.incidents > 0} />
            <Row
              label="Deaths"
              title="Expected deaths (end-of-life care) and unexpected (after resuscitation)"
              value={s.deaths}
              extra={s.unexpectedDeaths > 0 ? `${s.unexpectedDeaths} unexpected` : undefined}
            />
            {s.complaints > 0 && (
              <Row
                label="Complaints"
                title="About how deaths were handled: privacy, breaking news, the route to the mortuary"
                value={s.complaints}
                bad
              />
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Row(props: {
  label: ComponentChildren;
  value: string | number;
  title?: string;
  /** Shown dimmed after the value, e.g. a breakdown. */
  extra?: string | undefined;
  /** Shown as "target N" under a value measured against one. */
  target?: string;
  bad?: boolean;
}) {
  return (
    <tr>
      <td title={props.title}>{props.label}</td>
      <td class={`num${props.bad ? " bad" : ""}`}>
        {props.value}
        {props.extra && <span class="dim"> ({props.extra})</span>}
        {props.target && <span class="dim target"> / {props.target}</span>}
      </td>
    </tr>
  );
}

/* ---------- The department now ---------- */

function Capacity({ data }: { data: ReportData }) {
  const { waitingSeats: seats, wardBeds: beds, mortuary, ambulances } = data;
  return (
    <div class="capacity">
      <Gauge label="Waiting area seats" used={seats.taken} total={seats.total} />
      {(beds.total > 0 || beds.waiting > 0) && (
        <Gauge
          label="Ward beds"
          used={beds.inUse}
          total={beds.total}
          alert={
            beds.waiting > 0
              ? `${plural(beds.waiting, "admitted patient")} waiting in A&E`
              : undefined
          }
        />
      )}
      {(mortuary.total > 0 || mortuary.awaitingReview > 0) && (
        <Gauge
          label="Mortuary spaces"
          used={mortuary.taken}
          total={mortuary.total}
          note={
            mortuary.awaitingReview > 0
              ? `${mortuary.awaitingReview} awaiting Medical Examiner review`
              : undefined
          }
        />
      )}
      {ambulances.spaces > 0 && (
        <Gauge
          label="Ambulance bay spaces"
          used={ambulances.parked}
          total={ambulances.spaces}
          alert={ambulances.waiting > 0 ? `${ambulances.waiting} waiting outside` : undefined}
        />
      )}
    </div>
  );
}

function Gauge(props: {
  label: string;
  used: number;
  total: number;
  note?: string | undefined;
  alert?: string | undefined;
}) {
  const f = props.total === 0 ? (props.used > 0 ? 1 : 0) : props.used / props.total;
  const status: Status = props.alert || f >= 1 ? "bad" : f >= 0.85 ? "warn" : "ok";
  return (
    <div class="gauge">
      <div class="gauge-head">
        <span>{props.label}</span>
        <span class="gauge-count">
          {props.used} <span class="dim">of {props.total}</span>
        </span>
      </div>
      <div class="gauge-track">
        <div class={`gauge-fill ${status}`} style={{ width: `${Math.min(1, f) * 100}%` }} />
      </div>
      {props.alert && <div class="gauge-note bad-text">⚠ {props.alert}</div>}
      {props.note && <div class="gauge-note dim">{props.note}</div>}
    </div>
  );
}

function Stages({ now }: { now: ReportData["now"] }) {
  const total = now.reduce((t, r) => t + r.count, 0);
  if (total === 0) return <p class="dim">No patients in the department.</p>;
  const most = Math.max(...now.map((r) => r.count));
  return (
    <div class="stages">
      <div class="stages-head">
        <h4>Where patients are</h4>
        <span class="dim">{plural(total, "patient")}</span>
      </div>
      {now.map((r) => (
        <div class="stage-row" key={r.label}>
          <span class="stage-label">{r.label}</span>
          <span class="stage-bar">
            <span style={{ width: `${(100 * r.count) / most}%` }} />
          </span>
          <span class="stage-count">{r.count}</span>
        </div>
      ))}
    </div>
  );
}

/* ---------- Trends ---------- */

const CHART_W = 320;
const CHART_H = 96;
const AXIS_W = 34;

function Trends(props: {
  days: DayReport[];
  hovered: number | null;
  onHover: (day: number | null) => void;
}) {
  const { days, hovered, onHover } = props;
  const focus = days.find((d) => d.day === hovered) ?? days[days.length - 1]!;
  const four = share(focus.stats.within4h, focus.stats.departures);
  const n = net(focus.ledger);
  return (
    <div class="trends" onMouseLeave={() => onHover(null)}>
      <div class="trend-readout">
        <strong>Day {focus.day}</strong>
        <span>4-hr {four === null ? "—" : `${Math.round(four * 100)}%`}</span>
        <span class={n < 0 ? "bad-text" : "ok-text"}>{formatMoney(n)}</span>
        <span class="dim">
          {focus.stats.arrivals} arrived · {focus.stats.discharged} seen
        </span>
      </div>
      <h4>4-hour standard</h4>
      <FourHourChart days={days} hovered={focus.day} onHover={onHover} />
      <h4>Net income</h4>
      <NetChart days={days} hovered={focus.day} onHover={onHover} />
    </div>
  );
}

/** Day slots across the plot area, with a hover target over each. */
function slots(count: number) {
  const plot = CHART_W - AXIS_W;
  const step = plot / Math.max(count, 7);
  const bar = Math.max(4, Math.min(18, step - 4));
  return { step, bar, x: (i: number) => AXIS_W + i * step + (step - bar) / 2 };
}

function HitTargets(props: { days: DayReport[]; onHover: (day: number) => void; step: number }) {
  return (
    <>
      {props.days.map((d, i) => (
        <rect
          key={d.day}
          class="hit"
          x={AXIS_W + i * props.step}
          y={0}
          width={props.step}
          height={CHART_H}
          onMouseEnter={() => props.onHover(d.day)}
        />
      ))}
    </>
  );
}

function FourHourChart(props: {
  days: DayReport[];
  hovered: number;
  onHover: (day: number) => void;
}) {
  const top = 6;
  const bottom = CHART_H - 14;
  const y = (f: number) => bottom - f * (bottom - top);
  const { step, bar, x } = slots(props.days.length);
  return (
    <svg
      class="chart"
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      role="img"
      aria-label="4-hour standard by day"
    >
      <line class="axis" x1={AXIS_W} x2={CHART_W} y1={bottom} y2={bottom} />
      {[
        [FOUR_HOUR_TARGET, "95%"],
        [FOUR_HOUR_INTERIM, "78%"],
      ].map(([f, label]) => (
        <g key={label}>
          <line class="target" x1={AXIS_W} x2={CHART_W} y1={y(f as number)} y2={y(f as number)} />
          <text class="tick" x={AXIS_W - 4} y={y(f as number) + 3} text-anchor="end">
            {label}
          </text>
        </g>
      ))}
      {props.days.map((d, i) => {
        const f = share(d.stats.within4h, d.stats.departures);
        if (f === null) return null;
        const h = Math.max(2, bottom - y(f));
        return (
          <path
            key={d.day}
            class={`bar ${fourHourStatus(f)}${d.day === props.hovered ? " focus" : ""}`}
            d={roundedTop(x(i), bottom - h, bar, h)}
          />
        );
      })}
      <DayLabels days={props.days} x={x} bar={bar} y={CHART_H - 2} />
      <HitTargets days={props.days} onHover={props.onHover} step={step} />
    </svg>
  );
}

function NetChart(props: { days: DayReport[]; hovered: number; onHover: (day: number) => void }) {
  const values = props.days.map((d) => net(d.ledger));
  const max = Math.max(...values.map(Math.abs), 1);
  const top = 6;
  const bottom = CHART_H - 14;
  const zero = (top + bottom) / 2;
  const half = (bottom - top) / 2;
  const { step, bar, x } = slots(props.days.length);
  return (
    <svg
      class="chart"
      viewBox={`0 0 ${CHART_W} ${CHART_H}`}
      role="img"
      aria-label="Net income by day"
    >
      <text class="tick" x={AXIS_W - 4} y={top + 6} text-anchor="end">
        {compactMoney(max)}
      </text>
      <text class="tick" x={AXIS_W - 4} y={zero + 3} text-anchor="end">
        £0
      </text>
      <text class="tick" x={AXIS_W - 4} y={bottom} text-anchor="end">
        −{compactMoney(max)}
      </text>
      <line class="axis" x1={AXIS_W} x2={CHART_W} y1={zero} y2={zero} />
      {values.map((v, i) => {
        const h = Math.max(2, (Math.abs(v) / max) * half);
        const cls = `bar ${v < 0 ? "bad" : "ok"}${props.days[i]!.day === props.hovered ? " focus" : ""}`;
        return v >= 0 ? (
          <path key={i} class={cls} d={roundedTop(x(i), zero - h, bar, h)} />
        ) : (
          <path key={i} class={cls} d={roundedBottom(x(i), zero, bar, h)} />
        );
      })}
      <DayLabels days={props.days} x={x} bar={bar} y={CHART_H - 2} />
      <HitTargets days={props.days} onHover={props.onHover} step={step} />
    </svg>
  );
}

function DayLabels(props: { days: DayReport[]; x: (i: number) => number; bar: number; y: number }) {
  // Label every other day once the chart fills up, always including the latest.
  const every = props.days.length > 8 ? 2 : 1;
  const last = props.days.length - 1;
  return (
    <>
      {props.days.map((d, i) =>
        (last - i) % every === 0 ? (
          <text
            key={d.day}
            class="tick"
            x={props.x(i) + props.bar / 2}
            y={props.y}
            text-anchor="middle"
          >
            {d.day}
          </text>
        ) : null,
      )}
    </>
  );
}

function compactMoney(n: number): string {
  if (n >= 1_000_000) return `£${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1000) return `£${Math.round(n / 1000)}k`;
  return `£${Math.round(n)}`;
}

/** A bar rising from its baseline, with rounded top corners. */
function roundedTop(x: number, y: number, w: number, h: number): string {
  const r = Math.min(3, w / 2, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

/** A bar hanging from its baseline, with rounded bottom corners. */
function roundedBottom(x: number, y: number, w: number, h: number): string {
  const r = Math.min(3, w / 2, h);
  return `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
}

/* ---------- Daily reports ---------- */

function DayTable(props: {
  days: DayReport[];
  hovered: number | null;
  onHover: (day: number | null) => void;
}) {
  return (
    <table class="report-table days" onMouseLeave={() => props.onHover(null)}>
      <thead>
        <tr>
          <th>Day</th>
          <th class="num">Arrived</th>
          <th class="num">Seen</th>
          <th class="num" title="Left without being seen">
            LWBS
          </th>
          <th class="num">Admitted</th>
          <th class="num" title="Patient safety incidents">
            Incidents
          </th>
          <th class="num">Deaths</th>
          <th class="num">4-hr</th>
          <th class="num">Net</th>
        </tr>
      </thead>
      <tbody>
        {props.days.map((d) => {
          const n = net(d.ledger);
          const f = share(d.stats.within4h, d.stats.departures);
          const status = fourHourStatus(f);
          return (
            <tr
              key={d.day}
              class={d.day === props.hovered ? "focus" : undefined}
              onMouseEnter={() => props.onHover(d.day)}
            >
              <td>{d.day}</td>
              <td class="num">{d.stats.arrivals}</td>
              <td class="num">{d.stats.discharged}</td>
              <td class={`num${d.stats.lwbs > 0 ? " bad" : ""}`}>{d.stats.lwbs}</td>
              <td class="num">{d.stats.admissions}</td>
              <td class={`num${d.stats.incidents > 0 ? " bad" : ""}`}>{d.stats.incidents}</td>
              <td class="num">{d.stats.deaths}</td>
              <td class={`num ${status === "none" ? "" : status}`}>
                {pct(d.stats.within4h, d.stats.departures)}
              </td>
              <td class={`num ${n < 0 ? "bad" : "ok"}`}>{formatMoney(n)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
