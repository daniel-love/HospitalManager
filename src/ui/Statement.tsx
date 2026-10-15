/**
 * The financial statement (GAME_DESIGN §8.1), shared by the Reports panel
 * and Finance → Statement: ledger lines with their labels and colours, and
 * a table of periods side by side.
 */
import { formatMoney } from "@game/tools";
import { costs, income, net, type CashFlows, type Ledger } from "@sim/agents";
import type { ComponentChildren } from "preact";
import type { StatementMonth } from "./store";

export const INCOME_LINES: { key: keyof Ledger; kind: string; label: string; title: string }[] = [
  {
    key: "block",
    kind: "block",
    label: "PHS block contract",
    title:
      "A fixed share of the expected value of the emergency care you're equipped to provide for your catchment, paid daily at midnight",
  },
  {
    key: "tariff",
    kind: "income",
    label: "Emergency tariff",
    title:
      "Each A&E attendance, emergency admission and operation, at the marginal rate on top of the block",
  },
  {
    key: "elective",
    kind: "elective",
    label: "Planned operations",
    title: "Day cases and planned inpatient stays, at full tariff",
  },
  {
    key: "outpatients",
    kind: "outpatients",
    label: "Outpatient tariff",
    title: "Clinic appointments, at full tariff",
  },
  {
    key: "private",
    kind: "private",
    label: "Private patients",
    title: "Facility fees from insurers and self-pay patients (consultants bill their own fees)",
  },
];
export const COST_LINES: { key: keyof Ledger; kind: string; label: string }[] = [
  { key: "salaries", kind: "salaries", label: "Salaries" },
  { key: "bank", kind: "salaries", label: "Bank staff" },
  { key: "agency", kind: "salaries", label: "Agency staff" },
  { key: "upkeep", kind: "upkeep", label: "Equipment upkeep" },
  { key: "supplies", kind: "supplies", label: "Drugs and supplies" },
  { key: "estates", kind: "estates", label: "Estates and utilities" },
  { key: "interest", kind: "estates", label: "Loan interest" },
  { key: "transfers", kind: "transport", label: "Transfer ambulances" },
];

/** Cash beyond income and running costs, in the statement: building, loans, grants. */
const FLOW_LINES: { key: keyof CashFlows; label: string; title: string; sign: 1 | -1 }[] = [
  {
    key: "building",
    label: "Building and equipment",
    title:
      "Building work and equipment bought, less anything sold: paid from cash, not a running cost",
    sign: -1,
  },
  { key: "borrowed", label: "Borrowed", title: "Loans taken out (Finance)", sign: 1 },
  {
    key: "repaid",
    label: "Loans repaid",
    title: "Loan principal paid back (the interest is a running cost)",
    sign: -1,
  },
  { key: "grants", label: "Grants", title: "Grants and investment received (Finance)", sign: 1 },
  {
    key: "clawedBack",
    label: "Grants clawed back",
    title: "Grants returned when their conditions weren't met",
    sign: -1,
  },
];

/**
 * The financial statement for some months (or a year to date), side by
 * side, line by line: income, running costs, the surplus or deficit, cash
 * in and out beyond them, and cash at each period's end.
 */
export function StatementTable({ cols: months }: { cols: StatementMonth[] }) {
  const cols = months.map((m) => ({ title: m.name, m }));
  const used = (key: keyof Ledger) => cols.some((c) => c.m.ledger[key] > 0);
  return (
    <table class="report-table statement">
      <thead>
        <tr>
          <th />
          {cols.map((c) => (
            <th key={c.title} class="num">
              {c.title}
              <span class="dim sub">
                {c.m.days} {c.m.days === 1 ? "day" : "days"}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {INCOME_LINES.filter((line) => used(line.key)).map((line) => (
          <tr key={line.key}>
            <td title={line.title}>
              <Swatch kind={line.kind}>{line.label}</Swatch>
            </td>
            {cols.map((c) => (
              <td key={c.title} class="num">
                {formatMoney(c.m.ledger[line.key])}
              </td>
            ))}
          </tr>
        ))}
        <tr class="subtotal">
          <td>Income</td>
          {cols.map((c) => (
            <td key={c.title} class="num">
              {formatMoney(income(c.m.ledger))}
            </td>
          ))}
        </tr>
        {COST_LINES.filter((line) => used(line.key)).map((line) => (
          <tr key={line.key}>
            <td>
              <Swatch kind={line.kind}>{line.label}</Swatch>
            </td>
            {cols.map((c) => (
              <td key={c.title} class="num">
                −{formatMoney(c.m.ledger[line.key])}
              </td>
            ))}
          </tr>
        ))}
        <tr class="subtotal">
          <td>Costs</td>
          {cols.map((c) => (
            <td key={c.title} class="num">
              −{formatMoney(costs(c.m.ledger))}
            </td>
          ))}
        </tr>
        <tr class="total">
          <td>Surplus or deficit</td>
          {cols.map((c) => {
            const n = net(c.m.ledger);
            return (
              <td key={c.title} class={`num ${n < 0 ? "bad" : "ok"}`}>
                {formatMoney(n)}
              </td>
            );
          })}
        </tr>
        {FLOW_LINES.filter(
          (line) => line.key === "building" || cols.some((c) => Math.abs(c.m.flows[line.key]) >= 1),
        ).map((line) => (
          <tr key={line.key}>
            <td title={line.title}>{line.label}</td>
            {cols.map((c) => {
              const v = c.m.flows[line.key] * line.sign;
              return (
                <td key={c.title} class="num">
                  {Math.abs(v) < 1 ? "—" : `${v < 0 ? "−" : ""}${formatMoney(Math.abs(v))}`}
                </td>
              );
            })}
          </tr>
        ))}
        <tr>
          <td>Cash at the end</td>
          {cols.map((c) => (
            <td key={c.title} class="num">
              {formatMoney(c.m.closingCash)}
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  );
}

export function Swatch({ kind, children }: { kind: string; children: ComponentChildren }) {
  return (
    <span class="swatch-label">
      <span class={`money-swatch ${kind}`} />
      {children}
    </span>
  );
}
