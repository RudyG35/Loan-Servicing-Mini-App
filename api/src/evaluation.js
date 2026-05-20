// Loan evaluation: status, days-past-due, on-time rate, and a CSR-friendly summary.
//
// A single routine — evaluateLoan() — classifies every loan in the portfolio.
// Edge cases covered (mirrors seed-data.json _notes.edgeCasesCovered):
//
//   L-1003  DELINQUENT          2+ consecutive missed payments (past grace, uncovered)
//   L-1004  PAID OFF            last payment on the maturity date
//   L-1005  CURRENT / late pay  full payment 12 days late — cycle covered, loan current
//   L-1006  LATE / partial      partial payment within grace; cycle not yet fully covered
//   L-1007  CURRENT / grace     full payment 8 days late — within grace, loan current
//   L-1008  CURRENT / new       first due date still in the future; no payments yet
//   L-1009–L-1020  CURRENT      healthy loans with varied vintages, terms, and rates
//
// Additional rules the routine enforces:
//
//   Partial + late timing   A partial payment is always classified as "partial"
//                           regardless of timing — amount shortfall takes priority.
//
//   Cumulative partials     Multiple partial payments on the same due date are
//                           summed; once they reach monthlyPayment the cycle is
//                           fully covered and the loan flips to "current".
//
//   Overpayment carry       Excess above monthlyPayment for a cycle is carried
//                           forward to the next scheduled cycle at evaluation time
//                           (pure derivation — no payment records are modified).
//
//   Truncated history       Coverage is only evaluated for cycles at or after the
//                           earliest payment on file. Long-lived loans whose early
//                           history is absent are not falsely flagged as delinquent.
//
//   nextDueDate accuracy    For current loans, nextDueDate skips any future cycle
//                           that has already been fully paid (e.g. via overpayment
//                           split), pointing the form to the first genuinely unpaid
//                           upcoming cycle.
//
//   On-time rate            Window: evaluated cycles with dueDate ≥ today − 12 months.
//                           Missed cycles ≤ 12 months old count in the denominator as
//                           not on-time; missed cycles > 12 months old are excluded.
//                           A cycle is on time when the cumulative total first reaches
//                           monthlyPayment within GRACE_DAYS of the due date.
//                           A completing payment past grace leaves the cycle not on-time.
//                           Lump-sum override: if any single paidOn date has total
//                           payments ≥ 12 × monthlyPayment, rate resets to 100%.
//                           Returns null when no evaluated cycles fall in the window.

export const GRACE_DAYS = 10;
const COVERAGE_TOLERANCE = 0.01; // dollars — rounding tolerance throughout

// ---------- date helpers (UTC, no timezone surprises) ----------

export function parseDate(s) {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

export function addMonths(date, months) {
  // Adds N calendar months, clamping the day to the target month's last day
  // (e.g. Jan 31 + 1 month → Feb 28/29, not an invalid Feb 31).
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth();
  const d = date.getUTCDate();
  const target = new Date(Date.UTC(y, m + months, 1));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth();
  const lastDay = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return new Date(Date.UTC(ty, tm, Math.min(d, lastDay)));
}

export function daysBetween(a, b) {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

// ---------- schedule + coverage ----------

export function buildSchedule(loan) {
  // Monthly billing dates from firstDueDate through maturityDate.
  const first = parseDate(loan.firstDueDate);
  const out = [];
  for (let i = 0; i < loan.termMonths; i++) {
    out.push(addMonths(first, i));
  }
  return out;
}

function coverageByDueDate(payments) {
  // Map of dueDate → { total, earliestPaidOn }.
  // total: sum of all payment amounts tagged to this due date (supports
  //   cumulative partials — several small payments covering one cycle).
  // earliestPaidOn: date of the first payment received for this cycle,
  //   used to decide whether a partial payment was within the grace window.
  const m = new Map();
  for (const p of payments) {
    const cur = m.get(p.dueDate) ?? { total: 0, earliestPaidOn: null };
    cur.total += p.amount;
    if (!cur.earliestPaidOn || p.paidOn < cur.earliestPaidOn) {
      cur.earliestPaidOn = p.paidOn;
    }
    m.set(p.dueDate, cur);
  }
  return m;
}

function redistributeOverages(coverage, schedule, monthlyPayment) {
  // Overpayment carry-forward: if a cycle's cumulative total exceeds
  // monthlyPayment, cap it and credit the excess to the next cycle.
  // Cascades: an overage on cycle N can propagate through N+1, N+2, …
  // The earliest paid-on date travels with the carry so grace-period logic
  // for the receiving cycle knows when the prepayment was received.
  for (let i = 0; i < schedule.length - 1; i++) {
    const key = formatDate(schedule[i]);
    const entry = coverage.get(key);
    if (!entry) continue;
    const overage = entry.total - monthlyPayment;
    if (overage <= COVERAGE_TOLERANCE) continue;
    entry.total = monthlyPayment;
    const nextKey = formatDate(schedule[i + 1]);
    const nextEntry = coverage.get(nextKey) ?? { total: 0, earliestPaidOn: null };
    nextEntry.total += overage;
    if (
      entry.earliestPaidOn &&
      (!nextEntry.earliestPaidOn || entry.earliestPaidOn < nextEntry.earliestPaidOn)
    ) {
      nextEntry.earliestPaidOn = entry.earliestPaidOn;
    }
    coverage.set(nextKey, nextEntry);
  }
}

function earliestPaymentDueDate(payments) {
  // Truncated-history guard: the oldest due date with a payment on file.
  // Cycles before this date are excluded from coverage evaluation so that
  // loans with partial history (e.g. L-1001) are not falsely flagged.
  let earliest = null;
  for (const p of payments) {
    const d = parseDate(p.dueDate);
    if (!earliest || d < earliest) earliest = d;
  }
  return earliest;
}

// ---------- amortization (for currentBalance) ----------

export function computeCurrentBalance(loan, payments) {
  // Simple amortization walk: interest = balance × (annualRate/12);
  // principal = max(0, payment − interest); balance -= principal (floor 0).
  // Sorted by dueDate so the walk follows the billing schedule order rather
  // than the order payments were received. Accurate for full scheduled
  // payments; approximate for partials.
  const sorted = [...payments].sort((a, b) =>
    a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0,
  );
  const monthlyRate = loan.annualRate / 12;
  let balance = loan.principal;
  for (const p of sorted) {
    const interest = balance * monthlyRate;
    const principal = Math.max(0, p.amount - interest);
    balance = Math.max(0, balance - principal);
  }
  return Math.round(balance * 100) / 100;
}

// ---------- payment classification ----------

// classification ∈ "on_time" | "late_within_grace" | "late" | "partial"
//
// Priority order (highest first):
//   1. partial (any timing)  → "partial"           (amount shortfall wins)
//   2. on time (≤ 0 days)   → "on_time"
//   3. within grace (1–10d) → "late_within_grace"
//   4. past grace (>10d)    → "late"
export function classifyPayment(payment, loan) {
  const due  = parseDate(payment.dueDate);
  const paid = parseDate(payment.paidOn);
  const daysLate = daysBetween(due, paid);
  const shortBy  = Math.max(0, loan.monthlyPayment - payment.amount);
  const isPartial = shortBy > COVERAGE_TOLERANCE;

  let classification;
  if (isPartial) {
    classification = "partial";           // amount shortfall takes priority over timing
  } else if (daysLate <= 0) {
    classification = "on_time";
  } else if (daysLate <= GRACE_DAYS) {
    classification = "late_within_grace"; // 1–10 days late
  } else {
    classification = "late";              // >10 days late
  }

  return {
    classification,
    onTime: classification === "on_time" || classification === "late_within_grace",
    daysLate,
    expectedAmount: loan.monthlyPayment,
    shortBy: Math.round(shortBy * 100) / 100,
  };
}

// ---------- the main evaluator ----------

export function evaluateLoan(loan, payments, today = new Date()) {
  const todayUtc  = toUtcMidnight(today);
  const maturity  = parseDate(loan.maturityDate);
  const schedule  = buildSchedule(loan);
  const coverage  = coverageByDueDate(payments);
  redistributeOverages(coverage, schedule, loan.monthlyPayment); // carry overpayments forward
  const earliestPaid = earliestPaymentDueDate(payments);
  const evalCutoff   = todayUtc < maturity ? todayUtc : maturity;

  // --- Step 1: count missed cycles ---
  // Evaluate every scheduled cycle that has passed (up to today or maturity)
  // and is on or after the earliest visible payment (truncated-history guard).
  // A cycle is "covered" — and does NOT count as missed — when:
  //   (a) cumulative payments ≥ monthlyPayment (full payment, any timing), OR
  //   (b) any payment arrived within the grace window (on-time partial keeps
  //       the loan current rather than triggering delinquency).
  // A partial paid OUTSIDE the grace window does not cover the cycle.
  const evaluatedCycles = schedule.filter((d) => {
    if (d > evalCutoff) return false;
    if (earliestPaid && d < earliestPaid) return false; // truncated-history guard
    return true;
  });

  let firstUncovered = null;
  let missedCycles   = 0;

  for (const d of evaluatedCycles) {
    const entry    = coverage.get(formatDate(d)) ?? { total: 0, earliestPaidOn: null };
    const paid     = entry.total;
    const pastGrace = daysBetween(d, todayUtc) > GRACE_DAYS;

    const fullyPaid = paid + COVERAGE_TOLERANCE >= loan.monthlyPayment;
    const firstPaymentDaysLate = entry.earliestPaidOn
      ? daysBetween(d, parseDate(entry.earliestPaidOn))
      : Infinity;
    const paidWithinGrace = paid > COVERAGE_TOLERANCE && firstPaymentDaysLate <= GRACE_DAYS;
    const covered = fullyPaid || paidWithinGrace;

    if (!covered && pastGrace) {
      if (!firstUncovered) firstUncovered = d;
      missedCycles++;
    }
  }

  // --- Step 2: on-time rate + last payment ---
  // Computed before status so partial-payment and missed-cycle rules can
  // reference lastPaymentStatus during status determination below.
  const sortedDesc = [...payments].sort((a, b) =>
    a.paidOn < b.paidOn ? 1 : a.paidOn > b.paidOn ? -1 : 0,
  );

  // On-time rate: share of evaluated cycles whose dueDate falls in the last 12 months
  // that were paid in full within GRACE_DAYS of the due date.
  //
  // Denominator: evaluated cycles (respects truncated-history guard) with dueDate ≥ today − 12 months.
  //   · Missed cycles with dueDate ≤ 12 months ago → included; counted as NOT on-time.
  //   · Missed cycles with dueDate > 12 months ago → excluded from denominator entirely.
  //   · Cycles with payments are graded on cumulative coverage and timing (see below).
  // A cycle is on-time when the cumulative total for that dueDate first reaches
  // monthlyPayment, and the payment that completed coverage arrived within GRACE_DAYS.
  // Partial payments accumulate; a completing payment within grace makes the cycle on-time.
  // A completing payment past grace leaves the cycle not on-time.
  // Lump-sum override: if any single paidOn date has total payments ≥ 12 × monthlyPayment,
  // the rate is immediately set to 100% — the large prepayment resets the borrower's standing.
  // Returns null when no evaluated cycles fall within the window.

  // Build payment index by dueDate sorted by paidOn for on-time grading.
  const paymentsByDueDate = new Map();
  for (const p of payments) {
    const list = paymentsByDueDate.get(p.dueDate) ?? [];
    list.push(p);
    paymentsByDueDate.set(p.dueDate, list);
  }
  for (const list of paymentsByDueDate.values()) {
    list.sort((a, b) => (a.paidOn < b.paidOn ? -1 : a.paidOn > b.paidOn ? 1 : 0));
  }

  const twelveMonthsAgo = addMonths(todayUtc, -12);
  const recentEvaluatedCycles = evaluatedCycles.filter(d => d >= twelveMonthsAgo);

  const onTimeCount12mo = recentEvaluatedCycles.filter(d => {
    const pmts = paymentsByDueDate.get(formatDate(d));
    if (!pmts) return false; // missed cycle → not on-time
    // Walk payments in paidOn order; cycle is on-time when cumulative first reaches
    // monthlyPayment and the completing payment was within GRACE_DAYS of the due date.
    let running = 0;
    for (const p of pmts) {
      running += p.amount;
      if (running + COVERAGE_TOLERANCE >= loan.monthlyPayment) {
        return daysBetween(d, parseDate(p.paidOn)) <= GRACE_DAYS;
      }
    }
    return false; // full coverage never reached
  }).length;

  // Lump-sum override: if any single paidOn date has total payments ≥ 12 × monthlyPayment,
  // the borrower has pre-paid at least a full year in one transaction — rate resets to 100%.
  const totalByDate = new Map();
  for (const p of payments) {
    totalByDate.set(p.paidOn, (totalByDate.get(p.paidOn) ?? 0) + p.amount);
  }
  const lumpSumCovers12Months = [...totalByDate.values()].some(
    t => t + COVERAGE_TOLERANCE >= 12 * loan.monthlyPayment,
  );

  const onTimeRate12mo = lumpSumCovers12Months
    ? 1
    : recentEvaluatedCycles.length === 0
      ? null
      : onTimeCount12mo / recentEvaluatedCycles.length;

  const lastPayment       = sortedDesc[0] || null;
  const lastPaymentStatus = lastPayment ? classifyPayment(lastPayment, loan) : null;

  // --- Step 3: loan status (evaluated in priority order) ---
  //
  //   paid_off (early)  — balance paid to zero before maturity date
  //   delinquent        — 2+ missed cycles                                   (L-1003)
  //   paid_off (term)   — at/past maturity and final cycle covered           (L-1004)
  //   delinquent        — at/past maturity with remaining balance
  //   late              — 1 missed cycle past grace, OR                      (L-1003 after 1 payment)
  //                       last payment partial and past grace                 (L-1006 variant)
  //   late_within_grace — same triggers but still within grace               (L-1007 variant)
  //   current           — everything else, including:
  //                       · full late payment, cycle now covered             (L-1005)
  //                       · payment within grace                             (L-1007)
  //                       · brand-new loan, first due in future              (L-1008)
  //                       · cumulative partials reached monthly total
  const currentBalance = computeCurrentBalance(loan, payments);
  let earlyPayoff = false;
  let status;

  if (currentBalance <= COVERAGE_TOLERANCE && payments.length > 0 && todayUtc < maturity) {
    // Balance cleared before maturity — early payoff.
    status      = "paid_off";
    earlyPayoff = true;

  } else if (missedCycles >= 2) {
    // L-1003: two or more uncovered cycles past grace → delinquent.
    status = "delinquent";

  } else if (todayUtc >= maturity) {
    // L-1004: at or past maturity — paid off only if final cycle covered.
    const maturityEntry   = coverage.get(formatDate(maturity)) ?? { total: 0, earliestPaidOn: null };
    const maturityCovered = maturityEntry.total + COVERAGE_TOLERANCE >= loan.monthlyPayment;
    status = maturityCovered ? "paid_off" : "delinquent";

  } else if (missedCycles === 1) {
    // One uncovered cycle past grace — surface how far past due.
    const dpd = daysBetween(firstUncovered, todayUtc);
    status = dpd > GRACE_DAYS ? "late" : "late_within_grace";

  } else if (lastPaymentStatus?.classification === "partial") {
    // L-1006: last payment was partial. Check cumulative coverage for that cycle.
    // Multiple partials on the same due date sum together; once their total
    // reaches monthlyPayment the cycle is fully covered and the loan is current.
    const dueDateEntry       = coverage.get(lastPayment.dueDate) ?? { total: 0 };
    const cumulativelyCovered = dueDateEntry.total + COVERAGE_TOLERANCE >= loan.monthlyPayment;
    if (cumulativelyCovered) {
      status = "current";
    } else {
      const dpd = daysBetween(parseDate(lastPayment.dueDate), todayUtc);
      status = dpd > GRACE_DAYS ? "late" : "late_within_grace";
    }

  } else {
    // L-1005 (full late payment, cycle covered), L-1007 (within grace),
    // L-1008 (no past dues yet), L-1009–L-1020 (healthy), and any loan
    // whose cumulative partials just reached the monthly total.
    status = "current";
  }

  // --- Step 4: days past due + next due date ---

  const daysPastDue = firstUncovered ? daysBetween(firstUncovered, todayUtc) : 0;

  // nextDueDate:
  //   paid_off          → null
  //   delinquent / late → firstUncovered (oldest cycle the borrower owes)
  //   current           → first future cycle not yet fully paid, skipping any
  //                        cycle already satisfied by overpayment or prepayment
  let nextDueDate = null;
  if (status !== "paid_off") {
    if (firstUncovered) {
      nextDueDate = formatDate(firstUncovered);
    } else {
      const upcoming = schedule.find((d) => {
        if (d <= todayUtc) return false;
        const entry = coverage.get(formatDate(d)) ?? { total: 0 };
        return entry.total + COVERAGE_TOLERANCE < loan.monthlyPayment;
      });
      nextDueDate = upcoming ? formatDate(upcoming) : null;
    }
  }

  const summary = buildSummary({
    loan, status, earlyPayoff, daysPastDue, missedCycles,
    onTimeRate12mo, lastPayment, lastPaymentStatus, nextDueDate,
  });

  return {
    status,
    daysPastDue,
    missedCycles,
    onTimeRate12mo,
    nextDueDate,
    lastPayment,
    lastPaymentStatus,
    summary,
  };
}

// ---------- CSR summary ----------

function toUtcMidnight(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function buildSummary({
  loan, status, earlyPayoff, daysPastDue, missedCycles,
  onTimeRate12mo, lastPayment, lastPaymentStatus, nextDueDate,
}) {
  const name = loan.borrowerName;
  const pct  = onTimeRate12mo == null ? null : Math.round(onTimeRate12mo * 100);
  const rate = pct == null ? "no recent payments" : `${pct}% on-time over last 12 months`;

  if (status === "paid_off") {
    return earlyPayoff
      ? `${name}'s loan has been paid off early — remaining balance cleared.`
      : `${name}'s loan is paid off as of ${loan.maturityDate}.`;
  }

  if (status === "delinquent") {
    const cycles = missedCycles === 1 ? "1 missed cycle" : `${missedCycles} missed cycles`;
    return (
      `${name} is BEHIND: ${daysPastDue} days past due (${cycles}). ` +
      `Oldest unpaid due date is ${nextDueDate}. ${rate}.`
    );
  }

  if (missedCycles === 1) {
    const graceNote = status === "late_within_grace" ? " (within grace period)" : " (past grace)";
    return (
      `${name}'s loan is late${graceNote}: ${daysPastDue} days past due, 1 missed cycle. ` +
      `Oldest unpaid due date is ${nextDueDate}. ${rate}.`
    );
  }

  if (!lastPayment) {
    // L-1008: brand-new loan, no payments yet.
    return (
      `${name}'s loan is current. No payments recorded yet; ` +
      `first payment is due ${loan.firstDueDate}.`
    );
  }

  const lp = lastPaymentStatus;
  const lastBit =
    lp.classification === "on_time"
      ? `last payment of $${lastPayment.amount.toFixed(2)} on ${lastPayment.paidOn} was on time`
      : lp.classification === "late_within_grace"
        ? `last payment was ${lp.daysLate} days late but within the ${GRACE_DAYS}-day grace period`
        : lp.classification === "late"
          ? `last payment was ${lp.daysLate} days late (outside grace)`
          : `last payment was a partial payment, short by $${lp.shortBy.toFixed(2)}`;

  const statusLabel =
    status === "late"              ? "late" :
    status === "late_within_grace" ? "late (within grace)" :
    "current";

  return (
    `${name}'s loan is ${statusLabel} — ${lastBit}. ` +
    `Next payment of $${loan.monthlyPayment.toFixed(2)} due ${nextDueDate}. ${rate}.`
  );
}
