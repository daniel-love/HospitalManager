/**
 * The Finance dialog (GAME_DESIGN §8.1): the hospital's rating, its loans
 * and borrowing, and grants. Loans: DHSC capital loans for an NHS or Hybrid
 * trust, bank loans for a Private Hospital, priced and limited by the
 * rating. Grants: the offer open now (take it on or turn it down), those
 * under way with their progress, and those finished.
 */
import { useState } from "preact/hooks";
import type { FinanceData } from "@game/describeFinance";
import type { Game } from "@game/game";
import { formatMoney } from "@game/tools";
import { financeData, financeTab, type FinanceTab } from "./store";

const noFocus = (e: MouseEvent) => e.preventDefault();

export function FinanceDialog({ game }: { game: Game }) {
  const tab = financeTab.value;
  const data = financeData.value;
  if (!tab || !data) return null;
  return (
    <section class="panel people-dialog finance-dialog" role="dialog" aria-label="Finance">
      <header class="people-header">
        <div class="tabs" role="tablist">
          {(["loans", "grants"] as FinanceTab[]).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              class={tab === t ? "active" : ""}
              onMouseDown={noFocus}
              onClick={() => game.openFinance(t)}
            >
              {t === "loans" ? "Loans" : "Grants"}
              {t === "grants" && data.grants.offer && <span class="tab-badge">1</span>}
            </button>
          ))}
        </div>
        <button class="close" title="Close (Esc)" onClick={() => (financeTab.value = null)}>
          ×
        </button>
      </header>
      <div class="staff-summary">
        <div class="stat-tiles">
          <div class="stat-tile">
            <span class="stat-value">{formatMoney(data.cash)}</span>
            <span class="stat-label">cash</span>
          </div>
          <div class={`stat-tile${data.rating.bad ? " warn" : ""}`} title={data.rating.note}>
            <span class="stat-value">{data.rating.label.replace(/^.* /, "")}</span>
            <span class="stat-label">{data.rating.label.replace(/ \S+$/, "")}</span>
          </div>
          <div class="stat-tile">
            <span class="stat-value">{formatMoney(data.debt)}</span>
            <span class="stat-label">owed</span>
          </div>
          <div class="stat-tile">
            <span class="stat-value">{formatMoney(data.monthlyRepayments)}</span>
            <span class="stat-label">repaid a month</span>
          </div>
        </div>
        <p class={`small-note${data.rating.bad ? " warn-text" : " dim"}`}>{data.rating.note}</p>
      </div>
      <div class="staff-tab-scroll">
        {tab === "loans" ? <Loans game={game} data={data} /> : <Grants game={game} data={data} />}
      </div>
    </section>
  );
}

function Loans({ game, data }: { game: Game; data: FinanceData }) {
  const b = data.borrow;
  const [lo, hi] = b.terms;
  const [amount, setAmount] = useState(Math.min(1_000_000, Math.max(b.min, b.limit)));
  const [years, setYears] = useState(Math.min(hi, Math.max(lo, 10)));
  const r = b.rate / 12;
  const months = years * 12;
  const payment = r === 0 ? amount / months : (amount * r) / (1 - (1 + r) ** -months);
  const tooMuch = amount > b.limit;
  const blocked = b.blocked ?? (tooMuch ? `At most ${formatMoney(b.limit)} now` : null);
  return (
    <>
      <div class="report-group">
        <h4>Borrow</h4>
        <p class="dim small-note">
          {data.funding === "private"
            ? `A ${b.name.toLowerCase()} at ${(b.rate * 100).toFixed(1)}% a year, set by your credit rating. Repaid in equal monthly instalments at the start of each month; miss three and the hospital goes into administration.`
            : `A ${b.name} at the National Loans Fund rate, ${(b.rate * 100).toFixed(1)}% a year, for building. Repaid in equal monthly instalments at the start of each month. If cash runs out, the DHSC lends revenue support by itself, which puts the trust under closer oversight.`}
        </p>
        <div class="borrow-form">
          <label>
            Amount
            <input
              type="range"
              min={b.min}
              max={Math.max(b.min, b.limit)}
              step={50_000}
              value={amount}
              disabled={b.limit < b.min}
              onInput={(e) => setAmount(Number((e.currentTarget as HTMLInputElement).value))}
            />
            <strong>{formatMoney(amount)}</strong>
          </label>
          <label>
            Over
            <input
              type="range"
              min={lo}
              max={hi}
              step={1}
              value={years}
              onInput={(e) => setYears(Number((e.currentTarget as HTMLInputElement).value))}
            />
            <strong>{years} years</strong>
          </label>
          <p class="dim small-note">
            {formatMoney(payment)} a month · {formatMoney(payment * months - amount)} interest in
            all · up to {formatMoney(b.limit)} available
          </p>
          {blocked && <p class="warn-text small-note">{blocked}</p>}
          <button
            class="primary"
            disabled={!!blocked}
            onMouseDown={noFocus}
            onClick={() => game.borrow(b.kind, amount, years)}
          >
            Borrow {formatMoney(amount)}
          </button>
        </div>
      </div>
      <div class="report-group">
        <h4>Loans</h4>
        {data.loans.length === 0 ? (
          <p class="dim">No loans.</p>
        ) : (
          <table class="report-table">
            <thead>
              <tr>
                <th>Loan</th>
                <th class="num">Owed</th>
                <th class="num">Rate</th>
                <th class="num">A month</th>
                <th class="num">Left</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.loans.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.kind}
                    <span class="dim"> of {formatMoney(l.principal)}</span>
                    {l.missed > 0 && <span class="bad-text"> · {l.missed} missed</span>}
                  </td>
                  <td class="num">{formatMoney(l.balance)}</td>
                  <td class="num">{(l.rate * 100).toFixed(1)}%</td>
                  <td class="num">{formatMoney(l.payment)}</td>
                  <td class="num">
                    {Number.isFinite(l.monthsLeft) ? `${l.monthsLeft} months` : "—"}
                  </td>
                  <td>
                    <button
                      class="small-button"
                      disabled={data.cash < l.balance}
                      title={data.cash < l.balance ? "Not enough cash" : "Pay it off now"}
                      onMouseDown={noFocus}
                      onClick={() => game.repayLoan(l.id)}
                    >
                      Pay off
                    </button>
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

function Grants({ game, data }: { game: Game; data: FinanceData }) {
  const g = data.grants;
  return (
    <>
      <div class="report-group">
        <h4>On offer</h4>
        {g.offer ? (
          <div class="grant-card offer">
            <div class="grant-head">
              <strong>{g.offer.name}</strong>
              <span class="grant-amount">{formatMoney(g.offer.amount)}</span>
            </div>
            <span class="dim">
              From {g.offer.funder} · {g.offer.weeks} weeks to meet the condition · offer closes in{" "}
              {g.offer.closesIn} {g.offer.closesIn === 1 ? "day" : "days"}
            </span>
            <p>{g.offer.description}</p>
            <p class="dim small-note">
              The money arrives when you take it on. Meet the condition in time and it's yours, with
              a little reputation; miss it and it's clawed back, and reputation falls.
            </p>
            {!g.offer.canAccept && (
              <p class="warn-text small-note">
                At most {g.maxActive} grants at once: finish one first.
              </p>
            )}
            <div class="grant-actions">
              <button onMouseDown={noFocus} onClick={() => game.declineGrant()}>
                Turn down
              </button>
              <button
                class="primary"
                disabled={!g.offer.canAccept}
                onMouseDown={noFocus}
                onClick={() => game.acceptGrant()}
              >
                Take it on
              </button>
            </div>
          </div>
        ) : (
          <p class="dim">
            Nothing on offer now. Grants and investment are offered every few weeks, to fit what
            you've built and what needs improving.
          </p>
        )}
      </div>
      <div class="report-group">
        <h4>Under way</h4>
        {g.active.length === 0 ? (
          <p class="dim">None.</p>
        ) : (
          g.active.map((a) => (
            <div key={a.name} class="grant-card">
              <div class="grant-head">
                <strong>{a.name}</strong>
                <span class="grant-amount">{formatMoney(a.amount)}</span>
              </div>
              <span class="dim">{a.description}</span>
              <div class="meter" title={`${Math.round(a.share * 100)}%`}>
                <div
                  class={`meter-fill${a.daysLeft < 14 && a.share < 1 ? " warn" : ""}`}
                  style={{ width: `${Math.round(a.share * 100)}%` }}
                />
              </div>
              <span class="small-note">
                {a.progress} · {a.daysLeft} {a.daysLeft === 1 ? "day" : "days"} left
              </span>
            </div>
          ))
        )}
      </div>
      {g.done.length > 0 && (
        <div class="report-group">
          <h4>Finished</h4>
          <table class="report-table">
            <tbody>
              {g.done.map((d, i) => (
                <tr key={i}>
                  <td>{d.name}</td>
                  <td class={d.met ? "ok-text" : "bad-text"}>
                    {d.met ? "Met: kept" : "Missed: repaid"}
                  </td>
                  <td class="num dim">{d.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
