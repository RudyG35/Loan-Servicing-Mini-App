import { useEffect, useState, useCallback } from "react";
import { api } from "./api.js";

const STATUS_COPY = {
  current:          { label: "Current",            className: "pill pill-good" },
  delinquent:       { label: "Delinquent",          className: "pill pill-bad" },
  paid_off:         { label: "Paid off",            className: "pill pill-neutral" },
  late:             { label: "Late",                className: "pill pill-bad" },
  late_within_grace:{ label: "Late (within grace)", className: "pill pill-warn" },
};

const PAYMENT_COPY = {
  on_time: { label: "On time", className: "pill pill-good" },
  late_within_grace: { label: "Late (within grace)", className: "pill pill-warn" },
  late: { label: "Late", className: "pill pill-bad" },
  partial: { label: "Partial", className: "pill pill-bad" },
  brand_new_no_payments_yet: { label: "Brand New (no payments yet)", className: "pill pill-neutral" },
};

function fmtMoney(n) {
  if (n == null) return "—";
  return `$${Number(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtPct(r) {
  if (r == null) return "—";
  return `${Math.round(r * 100)}%`;
}

function fmtRate(r) {
  return `${(r * 100).toFixed(3)}%`;
}

export default function App() {
  const [loans, setLoans] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loan, setLoan] = useState(null);
  const [evaluation, setEvaluation] = useState(null);
  const [payments, setPayments] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api
      .listLoans()
      .then((list) => {
        setLoans(list);
        if (list.length && !selectedId) setSelectedId(list[0].id);
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshDetail = useCallback(async (id) => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [d, e, p] = await Promise.all([
        api.getLoan(id),
        api.getEvaluation(id),
        api.getPayments(id),
      ]);
      setLoan(d);
      setEvaluation(e);
      setPayments(p);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) refreshDetail(selectedId);
  }, [selectedId, refreshDetail]);

  const refreshAll = useCallback(async () => {
    const list = await api.listLoans();
    setLoans(list);
    if (selectedId) await refreshDetail(selectedId);
  }, [selectedId, refreshDetail]);

  return (
    <div className="app">
      <header className="header">
        <h1>Loan Servicing — CSR Console</h1>
      </header>

      {error && <div className="error">{error}</div>}

      <div className="layout">
        <LoanList
          loans={loans}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />

        <main className="detail">
          {loading && <div className="muted">Loading…</div>}
          {!loading && loan && evaluation && (
            <>
              <EvaluationCard loan={loan} evaluation={evaluation} />
              <LoanDetailCard loan={loan} />
              <RecordPaymentForm
                loan={loan}
                evaluation={evaluation}
                nextDueDate={evaluation.nextDueDate}
                onRecorded={refreshAll}
              />
              <PaymentHistory payments={payments} />
            </>
          )}
        </main>
      </div>
    </div>
  );
}

// Pill shown in the loan list sidebar.
// Driven entirely by loan-level status from the API:
//   - partial + dueDate >  10d → status="late"             → red  "Late"
//   - partial + dueDate <= 10d → status="late_within_grace" → yellow "Late (within grace)"
//   - full late_within_grace payment + no missed cycles    → status="current" → green "Current"
function getLoanPill(loan) {
  if (loan.status === "delinquent")        return STATUS_COPY.delinquent;
  if (loan.status === "paid_off")          return STATUS_COPY.paid_off;
  if (loan.status === "late")              return STATUS_COPY.late;
  if (loan.status === "late_within_grace") return STATUS_COPY.late_within_grace;
  return STATUS_COPY.current;
}

function LoanList({ loans, selectedId, onSelect }) {
  return (
    <aside className="loan-list">
      <h2>Loans ({loans.length})</h2>
      <ul>
        {loans.map((l) => {
          const c = getLoanPill(l);
          return (
            <li
              key={l.id}
              className={l.id === selectedId ? "selected" : ""}
              onClick={() => onSelect(l.id)}
            >
              <div className="loan-row-top">
                <span className="loan-id">{l.id}</span>
                <span className={c.className}>{c.label}</span>
              </div>
              <div className="loan-row-bottom">
                <span>{l.borrowerName}</span>
                <span className="muted">{fmtMoney(l.currentBalance)}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function EvaluationCard({ loan, evaluation }) {
  const c = STATUS_COPY[evaluation.status] ?? STATUS_COPY.current;
  return (
    <section className="card eval-card">
      <div className="card-head">
        <h2>{loan.borrowerName}</h2>
        <span className={c.className}>{c.label}</span>
      </div>

      <p className="summary">{evaluation.summary}</p>

      <div className="metrics">
        <Metric
          label="Days past due"
          value={evaluation.daysPastDue || "0"}
          tone={evaluation.daysPastDue > 0 ? "bad" : "neutral"}
        />
        <Metric
          label="Missed cycles"
          value={evaluation.missedCycles || "0"}
          tone={evaluation.missedCycles > 0 ? "bad" : "neutral"}
        />
        <Metric
          label="On-time rate (last 12)"
          value={fmtPct(evaluation.onTimeRate12mo)}
          tone={
            evaluation.onTimeRate12mo == null
              ? "neutral"
              : evaluation.onTimeRate12mo >= 0.95
                ? "good"
                : evaluation.onTimeRate12mo >= 0.8
                  ? "warn"
                  : "bad"
          }
        />
        <Metric label="Next due" value={evaluation.nextDueDate ?? "—"} />
      </div>
    </section>
  );
}

function Metric({ label, value, tone = "neutral" }) {
  return (
    <div className={`metric metric-${tone}`}>
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
    </div>
  );
}

function LoanDetailCard({ loan }) {
  return (
    <section className="card">
      <h3>Loan detail</h3>
      <dl className="detail-grid">
        <dt>Loan ID</dt><dd>{loan.id}</dd>
        <dt>Principal</dt><dd>{fmtMoney(loan.principal)}</dd>
        <dt>Current balance</dt><dd>{fmtMoney(loan.currentBalance)}</dd>
        <dt>Annual rate</dt><dd>{fmtRate(loan.annualRate)}</dd>
        <dt>Term</dt><dd>{loan.termMonths} months</dd>
        <dt>Monthly payment</dt><dd>{fmtMoney(loan.monthlyPayment)}</dd>
        <dt>Origination</dt><dd>{loan.originationDate}</dd>
        <dt>First due</dt><dd>{loan.firstDueDate}</dd>
        <dt>Maturity</dt><dd>{loan.maturityDate}</dd>
        <dt>Next due</dt><dd>{loan.nextDueDate ?? "—"}</dd>
      </dl>
    </section>
  );
}

function RecordPaymentForm({ loan, evaluation, nextDueDate, onRecorded }) {
  const isPaidOff = evaluation?.status === "paid_off";

  const today = new Date().toISOString().slice(0, 10);

  // isPartialPending: last payment was partial AND that cycle is still incomplete.
  //
  // Three sub-cases, all sharing the same lock behaviour (field pinned to the
  // partial's due date until cumulative payments reach the monthly total):
  //
  //   Delinquent / Late with missed cycle — the partial is for the current
  //     firstUncovered cycle (nextDueDate === lastPayment.dueDate). Once
  //     cumulative payments cover it, nextDueDate advances past it and this
  //     flag turns off. If the partial is for a *different* (newer) cycle
  //     while an older one is still uncovered, nextDueDate won't match and
  //     we fall through to the nextDueDateIsPast lock instead.
  //
  //   Late / grace with no missed cycle — the partial itself is the reason
  //     the loan is "late" (paid within grace but short); missedCycles === 0.
  //     Once the cumulative total reaches the monthly payment, status flips
  //     to "current" and this flag turns off via the status !== "current" guard.
  const isPartialPending =
    evaluation?.lastPaymentStatus?.classification === "partial" &&
    evaluation?.status !== "current" &&
    (
      // Partial is for the firstUncovered cycle (delinquent or late with 1 miss).
      ((evaluation?.status === "delinquent" || evaluation?.status === "late") &&
        evaluation?.lastPayment?.dueDate === evaluation?.nextDueDate) ||
      // Partial is the cause of "late/grace" with no separate missed cycle.
      ((evaluation?.status === "late" || evaluation?.status === "late_within_grace") &&
        (evaluation?.missedCycles ?? 0) === 0)
    );

  // isPartialCovered: cumulative partials just reached the monthly total —
  // the cycle is now fully covered. Lock the field to nextDueDate so the
  // CSR is guided straight to the next billing cycle.
  const isPartialCovered =
    evaluation?.lastPaymentStatus?.classification === "partial" &&
    evaluation?.status === "current";

  // nextDueDateIsPast: the oldest unpaid due date has already passed — the CSR
  // must pay that specific date and cannot skip ahead to a future cycle.
  const nextDueDateIsPast = nextDueDate != null && nextDueDate < today;

  // Compute the locked due date value.
  // Priority: partial-pending wins (uses the partial's dueDate);
  // partial-covered and past-due both resolve to nextDueDate.
  const lockedDueDate = isPartialPending
    ? evaluation.lastPayment.dueDate
    : (isPartialCovered || nextDueDateIsPast)
      ? nextDueDate
      : null;

  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(today);
  const [dueDate, setDueDate] = useState(
    lockedDueDate ?? nextDueDate ?? loan.firstDueDate,
  );
  const [result, setResult] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState(null);

  // Full reset when switching to a different loan.
  useEffect(() => {
    setAmount("");
    setDueDate(lockedDueDate ?? nextDueDate ?? loan.firstDueDate);
    setPaidOn(today);
    setResult(null);
    setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loan.id]);

  // When the next unpaid cycle advances — e.g. after cumulative partials cover
  // a due date, or after an overpayment split credits a future cycle — update
  // the due date field only, leaving the payment result visible so the CSR
  // can still see the confirmation while the form is ready for the next cycle.
  useEffect(() => {
    setDueDate(lockedDueDate ?? nextDueDate ?? loan.firstDueDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nextDueDate, lockedDueDate]);

  async function submit(e) {
    e.preventDefault();
    if (isPaidOff) return;
    setSubmitting(true);
    setErr(null);
    try {
      const res = await api.recordPayment(loan.id, {
        amount: Number(amount),
        paidOn,
        dueDate,
      });
      setResult(res);
      // Advance the due date field immediately when the cycle just became
      // fully covered, so the form is ready for the next billing cycle:
      //
      //   Delinquent partial — covered when nextDueDate moves past the cycle
      //     we just paid. For delinquent loans nextDueDate === firstUncovered,
      //     so it stays on March 1 until cumulative payments cover it, then
      //     jumps to April 1. That change is the completion signal.
      //
      //   Late partial — covered when status flips to "current". nextDueDate
      //     is always the next upcoming cycle (e.g. June 1) regardless of the
      //     partial's due date (May 1), so nextDueDate !== dueDate would always
      //     be true and can't be used as the signal here.
      //
      //   Normal payment — advance whenever nextDueDate moved forward.
      const cycleJustCovered = res.evaluation?.nextDueDate && (
        isPartialPending
          ? evaluation?.status === "delinquent"
            ? res.evaluation.nextDueDate !== dueDate      // delinquent: nextDueDate advanced
            : res.evaluation.status === "current"         // late: flipped to current
          : res.evaluation.nextDueDate !== dueDate        // normal: next cycle moved
      );
      if (cycleJustCovered) {
        setDueDate(res.evaluation.nextDueDate);
      }
      await onRecorded();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="card">
      <h3>Record a payment</h3>

      {isPaidOff ? (
        <div className="error">
          This loan is paid off — no further payments can be recorded.
        </div>
      ) : (
        <>
          <form onSubmit={submit} className="payment-form">
            <label>
              Amount
              <input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                placeholder={`e.g. ${loan.monthlyPayment.toFixed(2)}`}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </label>
            <label>
              Paid on
              <input
                type="date"
                value={paidOn}
                readOnly
                style={{ opacity: 0.6, cursor: "not-allowed" }}
                required
              />
            </label>
            <label>
              For due date
              <input
                type="date"
                value={dueDate}
                readOnly
                style={{ opacity: 0.6, cursor: "not-allowed" }}
                required
              />
            </label>
            <button type="submit" disabled={submitting}>
              {submitting ? "Recording…" : "Record payment"}
            </button>
          </form>

          {err && <div className="error">{err}</div>}

          {result && (
            <div className="result">
              <PaymentResult payment={result.payment} />
              {result.splitPayments?.map((sp) => (
                <div key={sp.id} className="split-payment-row">
                  <span className="pill pill-neutral">Applied to {sp.dueDate}</span>
                  <span className="muted">{fmtMoney(sp.amount)} credited to next cycle</span>
                </div>
              ))}
              <p className="muted summary">{result.evaluation.summary}</p>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function PaymentResult({ payment }) {
  const c = PAYMENT_COPY[payment.classification] ?? STATUS_COPY.current;
  return (
    <div className="result-row">
      <span className={c.className}>{c.label}</span>
      <span className="muted">
        {payment.daysLate <= 0
          ? `Paid ${Math.abs(payment.daysLate)} day(s) early or on time`
          : `Paid ${payment.daysLate} day(s) after due date`}
      </span>
      {payment.shortBy > 0 && (
        <span className="muted">Short by {fmtMoney(payment.shortBy)}</span>
      )}
    </div>
  );
}

function PaymentHistory({ payments }) {
  if (!payments.length) {
    return (
      <section className="card">
        <h3>Payment history</h3>
        <p className="muted">No payments on file.</p>
      </section>
    );
  }
  return (
    <section className="card">
      <h3>Payment history ({payments.length})</h3>
      <table className="history">
        <thead>
          <tr>
            <th>Paid on</th>
            <th>Due date</th>
            <th>Amount</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((p) => {
            const c = PAYMENT_COPY[p.classification] ?? PAYMENT_COPY.on_time;
            return (
              <tr key={p.id}>
                <td>{p.paidOn}</td>
                <td>{p.dueDate}</td>
                <td>{fmtMoney(p.amount)}</td>
                <td>
                  <span className={c.className}>{c.label}</span>
                  {p.daysLate > 0 && (
                    <span className="muted"> · {p.daysLate}d</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
