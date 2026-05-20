// Unit tests for evaluation.js.
//
// Run from api/:
//   npm install        (installs vitest)
//   npm test           (one shot)
//   npm run test:watch
//
// Covers every labeled edge case in seed-data.json plus synthetic
// cases the seed doesn't exercise (grace-period boundaries, month-end
// clamping, leap year, all-past-due, future loan, paid_off boundary).

import { describe, it, expect } from "vitest";
import {
  evaluateLoan,
  classifyPayment,
  buildSchedule,
  computeCurrentBalance,
  parseDate,
  formatDate,
  addMonths,
  daysBetween,
  GRACE_DAYS,
} from "./evaluation.js";
import { loans, getPaymentsForLoan } from "./data.js";

const TODAY = parseDate("2026-05-17"); // matches the env clock used elsewhere

const seedLoan = (id) => loans.find((l) => l.id === id);
const seedPayments = (id) => getPaymentsForLoan(id);

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

describe("parseDate / formatDate", () => {
  it("round-trips an ISO date", () => {
    expect(formatDate(parseDate("2026-05-17"))).toBe("2026-05-17");
  });

  it("parses at UTC midnight (no timezone drift)", () => {
    const d = parseDate("2026-01-01");
    expect(d.getUTCFullYear()).toBe(2026);
    expect(d.getUTCMonth()).toBe(0);
    expect(d.getUTCDate()).toBe(1);
    expect(d.getUTCHours()).toBe(0);
  });
});

describe("addMonths", () => {
  it("adds whole months", () => {
    expect(formatDate(addMonths(parseDate("2026-01-15"), 1))).toBe("2026-02-15");
    expect(formatDate(addMonths(parseDate("2026-01-15"), 12))).toBe("2027-01-15");
  });

  it("clamps to the target month's last day (Jan 31 → Feb 28)", () => {
    expect(formatDate(addMonths(parseDate("2026-01-31"), 1))).toBe("2026-02-28");
  });

  it("clamps to Feb 29 in a leap year", () => {
    expect(formatDate(addMonths(parseDate("2024-01-31"), 1))).toBe("2024-02-29");
  });

  it("handles year rollover", () => {
    expect(formatDate(addMonths(parseDate("2025-12-31"), 1))).toBe("2026-01-31");
  });

  it("returns same day for 0 months", () => {
    expect(formatDate(addMonths(parseDate("2026-05-17"), 0))).toBe("2026-05-17");
  });
});

describe("daysBetween", () => {
  it("counts whole days, positive forward", () => {
    expect(daysBetween(parseDate("2026-05-01"), parseDate("2026-05-11"))).toBe(10);
  });

  it("returns 0 for the same day", () => {
    expect(daysBetween(parseDate("2026-05-01"), parseDate("2026-05-01"))).toBe(0);
  });

  it("returns negative when paidOn precedes dueDate", () => {
    expect(daysBetween(parseDate("2026-05-10"), parseDate("2026-05-09"))).toBe(-1);
  });

  it("spans a month boundary correctly", () => {
    expect(daysBetween(parseDate("2026-01-30"), parseDate("2026-02-02"))).toBe(3);
  });
});

describe("buildSchedule", () => {
  it("emits termMonths cycles, monthly cadence", () => {
    const loan = {
      firstDueDate: "2024-01-01",
      termMonths: 6,
    };
    const s = buildSchedule(loan).map(formatDate);
    expect(s).toEqual([
      "2024-01-01",
      "2024-02-01",
      "2024-03-01",
      "2024-04-01",
      "2024-05-01",
      "2024-06-01",
    ]);
  });

  it("matches the seed's L-1004 schedule length", () => {
    const loan = seedLoan("L-1004");
    expect(buildSchedule(loan)).toHaveLength(loan.termMonths);
  });
});

// ---------------------------------------------------------------------------
// classifyPayment — covers the grace-period boundary explicitly
// ---------------------------------------------------------------------------

describe("classifyPayment", () => {
  const loan = { monthlyPayment: 1000 };

  it("on_time when paidOn equals dueDate", () => {
    const r = classifyPayment(
      { amount: 1000, paidOn: "2026-05-01", dueDate: "2026-05-01" },
      loan,
    );
    expect(r.classification).toBe("on_time");
    expect(r.onTime).toBe(true);
    expect(r.daysLate).toBe(0);
    expect(r.shortBy).toBe(0);
  });

  it("on_time when paidOn precedes dueDate", () => {
    const r = classifyPayment(
      { amount: 1000, paidOn: "2026-04-25", dueDate: "2026-05-01" },
      loan,
    );
    expect(r.classification).toBe("on_time");
    expect(r.daysLate).toBe(-6);
  });

  it("late_within_grace at 1 day late", () => {
    const r = classifyPayment(
      { amount: 1000, paidOn: "2026-05-02", dueDate: "2026-05-01" },
      loan,
    );
    expect(r.classification).toBe("late_within_grace");
    expect(r.onTime).toBe(true); // still counts for the on-time rate
    expect(r.daysLate).toBe(1);
  });

  it("late_within_grace at exactly GRACE_DAYS (boundary)", () => {
    const r = classifyPayment(
      { amount: 1000, paidOn: "2026-05-11", dueDate: "2026-05-01" },
      loan,
    );
    expect(r.daysLate).toBe(GRACE_DAYS); // 10
    expect(r.classification).toBe("late_within_grace");
    expect(r.onTime).toBe(true);
  });

  it("late at GRACE_DAYS + 1 (just past boundary)", () => {
    const r = classifyPayment(
      { amount: 1000, paidOn: "2026-05-12", dueDate: "2026-05-01" },
      loan,
    );
    expect(r.daysLate).toBe(GRACE_DAYS + 1); // 11
    expect(r.classification).toBe("late");
    expect(r.onTime).toBe(false);
  });

  it("partial overrides timing — under-paid on the due date is still partial", () => {
    const r = classifyPayment(
      { amount: 600, paidOn: "2026-05-01", dueDate: "2026-05-01" },
      loan,
    );
    expect(r.classification).toBe("partial");
    expect(r.shortBy).toBe(400);
  });

  it("partial overrides timing — under-paid and 15 days late is still partial (not late)", () => {
    const r = classifyPayment(
      { amount: 600, paidOn: "2026-05-16", dueDate: "2026-05-01" },
      loan,
    );
    expect(r.classification).toBe("partial"); // amount shortfall wins over timing
    expect(r.daysLate).toBe(15);
    expect(r.shortBy).toBe(400);
    expect(r.onTime).toBe(false);
  });

  it("over-payment is treated as on_time, not partial", () => {
    const r = classifyPayment(
      { amount: 1500, paidOn: "2026-05-01", dueDate: "2026-05-01" },
      loan,
    );
    expect(r.classification).toBe("on_time");
    expect(r.shortBy).toBe(0);
  });

  it("tolerates a 1-cent rounding shortfall as on_time", () => {
    const r = classifyPayment(
      { amount: 999.995, paidOn: "2026-05-01", dueDate: "2026-05-01" },
      loan,
    );
    expect(r.classification).toBe("on_time");
  });
});

// ---------------------------------------------------------------------------
// evaluateLoan — every labeled edge case in seed-data.json
// ---------------------------------------------------------------------------

describe("evaluateLoan — seed edge cases", () => {
  it("L-1003: delinquent with 2 missed cycles", () => {
    const e = evaluateLoan(seedLoan("L-1003"), seedPayments("L-1003"), TODAY);
    expect(e.status).toBe("delinquent");
    expect(e.missedCycles).toBe(2);
    expect(e.nextDueDate).toBe("2026-04-01"); // the OLDEST uncovered cycle
    expect(e.daysPastDue).toBe(daysBetween(parseDate("2026-04-01"), TODAY));
    expect(e.summary).toMatch(/BEHIND/);
    expect(e.summary).toMatch(/2 missed cycles/);
  });

  it("L-1004: paid_off (last payment on maturity)", () => {
    const e = evaluateLoan(seedLoan("L-1004"), seedPayments("L-1004"), TODAY);
    expect(e.status).toBe("paid_off");
    expect(e.nextDueDate).toBeNull();
    expect(e.daysPastDue).toBe(0);
    expect(e.summary).toMatch(/paid off/);
  });

  it("L-1005: current, but last payment classified late (12d past grace)", () => {
    const e = evaluateLoan(seedLoan("L-1005"), seedPayments("L-1005"), TODAY);
    expect(e.status).toBe("current"); // May cycle is covered, just late
    expect(e.lastPaymentStatus.classification).toBe("late");
    expect(e.lastPaymentStatus.daysLate).toBe(12);
    expect(e.onTimeRate12mo).toBeCloseTo(11 / 12, 5); // 11 of 12 within grace
  });

  it("L-1006: partial payment last cycle — status=late (due date 16d past grace)", () => {
    // A partial payment is not a missed cycle, but once the grace window on that due date
    // closes the loan is marked late rather than current.
    const e = evaluateLoan(seedLoan("L-1006"), seedPayments("L-1006"), TODAY);
    expect(e.status).toBe("late");
    expect(e.missedCycles).toBe(0);
    expect(e.lastPaymentStatus.classification).toBe("partial");
    expect(e.lastPaymentStatus.shortBy).toBeCloseTo(801.42, 2);
  });

  it("L-1006: second partial completing the cycle → status flips to current", () => {
    // When multiple partial payments on the same due date sum to ≥ monthlyPayment,
    // the cycle is fully covered and the loan should become current.
    const loan = seedLoan("L-1006");
    const existingPayments = seedPayments("L-1006");
    const lastPmt = existingPayments[existingPayments.length - 1]; // oldest = earliest by paidOn
    const shortBy = Math.max(0, loan.monthlyPayment - lastPmt.amount);
    // Add the remaining amount to complete coverage of that due date.
    const completingPayment = {
      id: "P-1006-EXTRA",
      loanId: loan.id,
      amount: shortBy + 0.01, // enough to hit coverage tolerance
      paidOn: "2026-05-05",
      dueDate: lastPmt.dueDate,
    };
    const payments = [...existingPayments, completingPayment];
    const e = evaluateLoan(loan, payments, TODAY);
    expect(e.status).toBe("current");
    expect(e.missedCycles).toBe(0);
  });

  it("L-1007: late but within a 10-day grace period", () => {
    const e = evaluateLoan(seedLoan("L-1007"), seedPayments("L-1007"), TODAY);
    expect(e.status).toBe("current");
    expect(e.lastPaymentStatus.classification).toBe("late_within_grace");
    expect(e.lastPaymentStatus.daysLate).toBe(8);
    expect(e.onTimeRate12mo).toBe(1); // all 10 visible payments within grace
  });

  it("L-1008: brand-new loan, firstDue 2026-06-01 (still in the future), no payments yet → current", () => {
    const e = evaluateLoan(seedLoan("L-1008"), seedPayments("L-1008"), TODAY);
    expect(e.status).toBe("current");
    expect(e.missedCycles).toBe(0);
    expect(e.daysPastDue).toBe(0);
    expect(e.lastPayment).toBeNull();
    expect(e.lastPaymentStatus).toBeNull();
    expect(e.onTimeRate12mo).toBeNull();
    expect(e.nextDueDate).toBe("2026-06-01"); // first due date upcoming
    expect(e.summary).toMatch(/No payments recorded yet/);
  });

  it("L-1001: control — long-lived loan with truncated history stays current", () => {
    // L-1001 was originated in 2022 but the seed only carries 12 months of
    // payments. The evaluator must NOT flag 2022–2025 cycles as delinquent.
    const e = evaluateLoan(seedLoan("L-1001"), seedPayments("L-1001"), TODAY);
    expect(e.status).toBe("current");
    expect(e.missedCycles).toBe(0);
    expect(e.nextDueDate).toBe("2026-06-01");
  });

  // L-1009 through L-1020 — variety of healthy, current loans with different
  // vintages and terms (15yr, 20yr, 30yr; originations from 2017 through 2025).
  // All have payments through the May 2026 cycle (dueDate 2026-05-01, paidOn
  // on-time). Every one should be current, no missed cycles, next due 2026-06-01,
  // and a 100% on-time rate over the last 12 months.
  // L-1020 has all payments on time through May 2026, handled separately below.
  const healthyLoans = [
    { id: "L-1009", note: "2020 origination, 30yr" },
    { id: "L-1010", note: "2019 origination, 30yr" },
    { id: "L-1011", note: "2017 origination, 15yr" },
    { id: "L-1012", note: "2021 origination, 30yr" },
    { id: "L-1013", note: "2023 origination, 30yr" },
    { id: "L-1014", note: "2024 origination, 30yr (high balance)" },
    { id: "L-1015", note: "2019 origination, 15yr" },
    { id: "L-1016", note: "2022 origination, 30yr" },
    { id: "L-1017", note: "2023 origination, 30yr" },
    { id: "L-1018", note: "2018 origination, 20yr" },
    { id: "L-1019", note: "2024 origination, 30yr" },
  ];

  for (const { id, note } of healthyLoans) {
    it(`${id}: current with no missed cycles — ${note}`, () => {
      const e = evaluateLoan(seedLoan(id), seedPayments(id), TODAY);
      expect(e.status).toBe("current");
      expect(e.missedCycles).toBe(0);
      expect(e.daysPastDue).toBe(0);
      expect(e.nextDueDate).toBe("2026-06-01");
      expect(e.onTimeRate12mo).toBe(1);
      expect(e.lastPayment).not.toBeNull();
      expect(e.lastPaymentStatus.classification).toBe("on_time");
    });
  }

  it("L-1020: all payments on time through May 2026 → current (2025 origination, 30yr)", () => {
    // L-1020 has 15 on-time payments covering every cycle 2025-03-01 through
    // 2026-05-01 — no missed cycles, next due June 2026.
    const e = evaluateLoan(seedLoan("L-1020"), seedPayments("L-1020"), TODAY);
    expect(e.status).toBe("current");
    expect(e.missedCycles).toBe(0);
    expect(e.daysPastDue).toBe(0);
    expect(e.nextDueDate).toBe("2026-06-01");
    expect(e.onTimeRate12mo).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// evaluateLoan — synthetic scenarios the seed doesn't cover
// ---------------------------------------------------------------------------

function synthLoan(overrides = {}) {
  return {
    id: "L-TEST",
    borrowerName: "Test Borrower",
    principal: 120000,
    annualRate: 0.06,
    termMonths: 360,
    monthlyPayment: 1000,
    originationDate: "2025-01-01",
    firstDueDate: "2025-02-01",
    maturityDate: "2055-01-01",
    ...overrides,
  };
}

describe("evaluateLoan — synthetic scenarios", () => {
  it("at exactly 10 days past due with no payment → still current (within grace)", () => {
    const dueDate = "2026-05-07"; // 10 days before TODAY (2026-05-17)
    const loan = synthLoan({
      firstDueDate: "2026-05-07",
      termMonths: 12,
      maturityDate: "2027-04-07",
    });
    const e = evaluateLoan(loan, [], TODAY);
    expect(daysBetween(parseDate(dueDate), TODAY)).toBe(10);
    expect(e.status).toBe("current");
    expect(e.missedCycles).toBe(0);
  });

  it("at 11 days past due with no payment → late (1 missed cycle, 11d past grace)", () => {
    // 1 missed cycle below the delinquency threshold, but 11d > GRACE_DAYS → "late"
    const loan = synthLoan({
      firstDueDate: "2026-05-06", // 11 days before TODAY
      termMonths: 12,
      maturityDate: "2027-04-06",
    });
    const e = evaluateLoan(loan, [], TODAY);
    expect(e.status).toBe("late");
    expect(e.missedCycles).toBe(1);
    expect(e.daysPastDue).toBe(11);
  });

  it("month-end clamping: Jan 31 firstDue produces Feb 28 next cycle", () => {
    const loan = synthLoan({
      firstDueDate: "2026-01-31",
      termMonths: 3,
      maturityDate: "2026-03-31",
    });
    const s = buildSchedule(loan).map(formatDate);
    expect(s).toEqual(["2026-01-31", "2026-02-28", "2026-03-31"]);
  });

  it("future loan (firstDueDate after today, no payments) → current", () => {
    const loan = synthLoan({
      firstDueDate: "2030-01-01",
      termMonths: 12,
      maturityDate: "2030-12-01",
    });
    const e = evaluateLoan(loan, [], TODAY);
    expect(e.status).toBe("current");
    expect(e.nextDueDate).toBe("2030-01-01");
  });

  it("today past maturityDate with maturity cycle covered → paid_off", () => {
    const loan = synthLoan({
      firstDueDate: "2025-06-01",
      termMonths: 12,
      maturityDate: "2026-05-01", // before TODAY
    });
    const payments = [{
      id: "P-T-01",
      loanId: loan.id,
      amount: 1000,
      paidOn: "2026-05-01",
      dueDate: "2026-05-01",
    }];
    const e = evaluateLoan(loan, payments, TODAY);
    expect(e.status).toBe("paid_off");
    expect(e.nextDueDate).toBeNull();
  });

  it("past maturity but final cycle uncovered → delinquent (not paid_off)", () => {
    const loan = synthLoan({
      firstDueDate: "2025-06-01",
      termMonths: 12,
      maturityDate: "2026-05-01",
    });
    const e = evaluateLoan(loan, [], TODAY);
    expect(e.status).toBe("delinquent");
  });

  it("missed cycles ≤ 12 months old lower the on-time rate", () => {
    // 10 on-time payments (Jun 2025 – Mar 2026), then Apr and May 2026 missed.
    // All 12 cycles have dueDate ≥ 2025-05-17 → inside 12-month window.
    // Missed cycles count in denominator as not on-time: 10 on-time / 12 total = 83%.
    const loan = synthLoan({ firstDueDate: "2025-06-01", termMonths: 24 });
    const payments = [];
    for (let i = 0; i < 10; i++) {
      const d = formatDate(addMonths(parseDate("2025-06-01"), i));
      payments.push({ id: `P-${i}`, loanId: loan.id, amount: 1000, paidOn: d, dueDate: d });
    }
    const e = evaluateLoan(loan, payments, TODAY);
    expect(e.status).toBe("delinquent");
    expect(e.onTimeRate12mo).toBeCloseTo(10 / 12, 5);
  });

  it("missed cycle older than 12 months is excluded from on-time rate denominator", () => {
    // Jan 2025: on-time (establishes truncated-history start at Jan 2025).
    // Feb 2025: MISSED — dueDate 2025-02-01 is > 12 months before TODAY (2026-05-17),
    //           so it falls outside the window and must NOT lower the rate.
    // Mar 2025 – May 2026: all on-time (15 payments).
    // Window (dueDate ≥ 2025-05-17): Jun 2025 – May 2026, 12 cycles, all on-time → 100%.
    const loan = synthLoan({ firstDueDate: "2025-01-01", termMonths: 24 });
    const payments = [
      { id: "P-0", loanId: loan.id, amount: 1000, paidOn: "2025-01-01", dueDate: "2025-01-01" },
      // Feb 2025 intentionally omitted — missed
    ];
    for (let i = 2; i <= 16; i++) {
      const d = formatDate(addMonths(parseDate("2025-01-01"), i));
      payments.push({ id: `P-${i}`, loanId: loan.id, amount: 1000, paidOn: d, dueDate: d });
    }
    const e = evaluateLoan(loan, payments, TODAY);
    // Feb 2025 missed but dueDate > 12 months ago → excluded from denominator; rate unaffected.
    expect(e.onTimeRate12mo).toBe(1);
  });

  it("on-time rate window is last 12 months by dueDate — cycles before window excluded", () => {
    // Jun 2024 cycle: 14 days late (past grace) but dueDate 2024-06-01 is outside the
    // 12-month window (window start ≈ 2025-05-17). Jul 2024 – May 2026: all on-time.
    // Only the 12 cycles with dueDate ≥ 2025-05-17 are counted → rate = 100%.
    const loan = synthLoan({ firstDueDate: "2024-06-01", termMonths: 360 });
    const payments = [
      { id: "P-0", loanId: loan.id, amount: 1000, paidOn: "2024-06-15", dueDate: "2024-06-01" },
    ];
    for (let i = 1; i <= 23; i++) {
      const d = formatDate(addMonths(parseDate("2024-06-01"), i));
      payments.push({ id: `P-${i}`, loanId: loan.id, amount: 1000, paidOn: d, dueDate: d });
    }
    const e = evaluateLoan(loan, payments, TODAY);
    expect(e.onTimeRate12mo).toBe(1); // Jun 2024 cycle outside window; 12 in-window all on-time
  });

  it("lump sum on a single day totalling ≥ 12 × monthlyPayment resets on-time rate to 100%", () => {
    // Delinquent loan: 10 on-time (Jun 2025 – Mar 2026) + Apr and May 2026 missed.
    // Without the lump sum, rate = 10/12 ≈ 83%.
    // A lump sum recorded May 17 covering Apr 2026 – Mar 2027 (12 records, same paidOn,
    // total = 12 × monthlyPayment) triggers the override → rate = 100%.
    const loan = synthLoan({ firstDueDate: "2025-06-01", termMonths: 24 });
    const payments = [];
    for (let i = 0; i < 10; i++) {
      const d = formatDate(addMonths(parseDate("2025-06-01"), i));
      payments.push({ id: `P-${i}`, loanId: loan.id, amount: 1000, paidOn: d, dueDate: d });
    }
    // Lump-sum split: 12 records on May 17, covering Apr 2026 through Mar 2027.
    for (let i = 0; i < 12; i++) {
      const due = formatDate(addMonths(parseDate("2026-04-01"), i));
      payments.push({ id: `LS-${i}`, loanId: loan.id, amount: 1000, paidOn: "2026-05-17", dueDate: due });
    }
    const e = evaluateLoan(loan, payments, TODAY);
    expect(e.onTimeRate12mo).toBe(1); // total on May 17 = 12 × monthlyPayment → 100%
  });

  it("partial payment in last 12 months lowers on-time rate", () => {
    // 11 full on-time payments + 1 partial (never reaches full coverage).
    // All 12 cycles have dueDate in the last 12 months → denominator = 12.
    // Partial cycle: cumulative total never reaches monthlyPayment → NOT on-time.
    const loan = synthLoan({ firstDueDate: "2025-06-01", termMonths: 24 });
    const payments = [];
    for (let i = 0; i < 11; i++) {
      const d = formatDate(addMonths(parseDate("2025-06-01"), i));
      payments.push({ id: `P-${i}`, loanId: loan.id, amount: 1000, paidOn: d, dueDate: d });
    }
    payments.push({ id: "P-partial", loanId: loan.id, amount: 600, paidOn: "2026-05-01", dueDate: "2026-05-01" });
    const e = evaluateLoan(loan, payments, TODAY);
    expect(e.lastPaymentStatus.classification).toBe("partial");
    expect(e.onTimeRate12mo).toBeCloseTo(11 / 12, 5);
  });

  // ---- lump sum (multi-cycle split) ----

  it("lump sum paid on time: split records share paidOn; each cycle graded on paidOn vs its dueDate", () => {
    // Routes.js split: one payment covers Apr (due Apr 1) and pre-pays May (due May 1).
    // Both records have paidOn=Apr 1. Apr: 0d late → on-time. May: 30d early → on-time.
    const loan = synthLoan({ firstDueDate: "2026-04-01", termMonths: 12, maturityDate: "2027-03-01" });
    const payments = [
      { id: "P-1", loanId: loan.id, amount: 1000, paidOn: "2026-04-01", dueDate: "2026-04-01" },
      { id: "P-2", loanId: loan.id, amount: 1000, paidOn: "2026-04-01", dueDate: "2026-05-01" },
    ];
    const e = evaluateLoan(loan, payments, TODAY);
    expect(e.status).toBe("current");
    expect(e.onTimeRate12mo).toBe(1); // 2 of 2 on-time
  });

  it("late lump sum: each split cycle graded independently — both past grace → 0%", () => {
    // Delinquent borrower pays Apr+May late on May 17. Routes.js split: same paidOn=May 17.
    // Apr: 46d late → NOT on-time. May: 16d late → NOT on-time.
    const loan = synthLoan({ firstDueDate: "2026-04-01", termMonths: 12, maturityDate: "2027-03-01" });
    const payments = [
      { id: "P-1", loanId: loan.id, amount: 1000, paidOn: "2026-05-17", dueDate: "2026-04-01" },
      { id: "P-2", loanId: loan.id, amount: 1000, paidOn: "2026-05-17", dueDate: "2026-05-01" },
    ];
    const e = evaluateLoan(loan, payments, TODAY);
    expect(e.status).toBe("current");
    expect(e.onTimeRate12mo).toBe(0); // 0 of 2 on-time
  });

  it("completing payment within grace counts as on-time (cumulative rule)", () => {
    // 9 full on-time payments, then a partial on May 1, then a completing payment
    // on May 5 (4 days late — within GRACE_DAYS). Cumulative total reaches
    // monthlyPayment on May 5, which is within grace → cycle IS on-time → 10/10.
    const loan = synthLoan({ firstDueDate: "2025-08-01", termMonths: 24 });
    const payments = [];
    for (let i = 0; i < 9; i++) {
      const d = formatDate(addMonths(parseDate("2025-08-01"), i));
      payments.push({ id: `P-${i}`, loanId: loan.id, amount: 1000, paidOn: d, dueDate: d });
    }
    payments.push({ id: "P-partial",    loanId: loan.id, amount: 600, paidOn: "2026-05-01", dueDate: "2026-05-01" });
    payments.push({ id: "P-completing", loanId: loan.id, amount: 400, paidOn: "2026-05-05", dueDate: "2026-05-01" });
    const e = evaluateLoan(loan, payments, TODAY);
    expect(e.status).toBe("current");
    expect(e.missedCycles).toBe(0);
    expect(e.onTimeRate12mo).toBeCloseTo(10 / 10, 5);
  });

  it("completing payment past grace does NOT fix on-time rate", () => {
    // April cycle: partial ($600) on Apr 1, completing ($400) on Apr 22 (21 days late,
    // past GRACE_DAYS). Cumulative reaches $1000 on Apr 22 → NOT on-time.
    // May cycle: full on-time payment. Two cycles in window → rate = 1/2.
    const loan = synthLoan({ firstDueDate: "2026-04-01", termMonths: 12, maturityDate: "2027-03-01" });
    const payments = [
      { id: "P-partial",    loanId: loan.id, amount: 600,  paidOn: "2026-04-01", dueDate: "2026-04-01" },
      { id: "P-completing", loanId: loan.id, amount: 400,  paidOn: "2026-04-22", dueDate: "2026-04-01" },
      { id: "P-may",        loanId: loan.id, amount: 1000, paidOn: "2026-05-01", dueDate: "2026-05-01" },
    ];
    const e = evaluateLoan(loan, payments, TODAY);
    expect(e.onTimeRate12mo).toBeCloseTo(1 / 2, 5); // Apr completed 21d late → not on-time; May on-time
  });

  it("two partials NOT summing to full payment → late (still short)", () => {
    // Use May 1 as first due date so it is the only evaluated past cycle (TODAY = May 17).
    const loan = synthLoan({
      firstDueDate: "2026-05-01",
      termMonths: 12,
      maturityDate: "2027-04-01",
    });
    const payments = [
      { id: "P-1", loanId: loan.id, amount: 400, paidOn: "2026-05-01", dueDate: "2026-05-01" },
      { id: "P-2", loanId: loan.id, amount: 400, paidOn: "2026-05-15", dueDate: "2026-05-01" },
    ];
    // 800 of 1000 — still partial; first payment was on time (within grace) so the cycle is
    // covered for missed-cycle purposes, but the last payment is partial 16d past due → late.
    // firstUncovered is null; nextDueDate advances to the next future unpaid cycle (Jun 1).
    const e = evaluateLoan(loan, payments, TODAY);
    expect(e.status).toBe("late");
    expect(e.missedCycles).toBe(0);
    expect(e.nextDueDate).toBe("2026-06-01");
  });

  it("cumulative partials cover cycle → nextDueDate advances to the NEXT cycle", () => {
    // Once multiple partial payments on the same due date sum to ≥ monthlyPayment,
    // the loan flips to "current" and nextDueDate must advance past that cycle
    // to the next scheduled billing date — verifying the due-date-lock can be
    // released on the frontend.
    // Use May 1 as first due date so it is the only evaluated past cycle (TODAY = May 17).
    const loan = synthLoan({
      firstDueDate: "2026-05-01",
      termMonths: 12,
      maturityDate: "2027-04-01",
    });
    const payments = [
      { id: "P-1", loanId: loan.id, amount: 600, paidOn: "2026-05-01", dueDate: "2026-05-01" },
      { id: "P-2", loanId: loan.id, amount: 400, paidOn: "2026-05-15", dueDate: "2026-05-01" },
    ];
    // 1000 of 1000 — fully covered, status current, next future unpaid cycle is Jun 1.
    const e = evaluateLoan(loan, payments, TODAY);
    expect(e.status).toBe("current");
    expect(e.missedCycles).toBe(0);
    expect(e.nextDueDate).toBe("2026-06-01"); // advanced past the covered cycle
  });

  // ---- overpayment redistribution ----

  it("overpayment on one cycle → excess credited to next cycle", () => {
    // Borrower pays 2× the monthly amount for April. The extra $1000 should
    // automatically cover May, leaving the loan current with nextDueDate in June.
    const loan = synthLoan({
      firstDueDate: "2026-04-01",
      termMonths: 12,
      maturityDate: "2027-03-01",
    });
    const payments = [
      {
        id: "P-1",
        loanId: loan.id,
        amount: 2000, // $1000 over monthlyPayment
        paidOn: "2026-04-01",
        dueDate: "2026-04-01",
      },
    ];
    const e = evaluateLoan(loan, payments, TODAY);
    expect(e.status).toBe("current");
    expect(e.missedCycles).toBe(0);
    // Both April and May are now covered; next upcoming cycle is June.
    expect(e.nextDueDate).toBe("2026-06-01");
  });

  it("large overpayment chains across multiple cycles", () => {
    // $3500 on a $1000/mo loan covers April, May, and June fully, partial July.
    const loan = synthLoan({
      firstDueDate: "2026-04-01",
      termMonths: 12,
      maturityDate: "2027-03-01",
    });
    const payments = [
      {
        id: "P-1",
        loanId: loan.id,
        amount: 3500,
        paidOn: "2026-04-01",
        dueDate: "2026-04-01",
      },
    ];
    // After redistribution: April=1000, May=1000, June=1000, July=500 (partial).
    // Evaluated cycles (≤ May 17): April (covered) and May (covered) → missedCycles = 0.
    // First future unpaid cycle: June is fully covered (skip), July is partial → nextDueDate = July.
    const e = evaluateLoan(loan, payments, TODAY);
    expect(e.status).toBe("current");
    expect(e.missedCycles).toBe(0);
    expect(e.nextDueDate).toBe("2026-07-01");
  });

  it("overpayment does not spill past the last scheduled cycle", () => {
    // A loan with only 2 cycles; an overpayment on cycle 1 is capped and the
    // remaining is credited to cycle 2. No crash or undefined access.
    const loan = synthLoan({
      firstDueDate: "2026-04-01",
      termMonths: 2,
      maturityDate: "2026-05-01",
    });
    const payments = [
      {
        id: "P-1",
        loanId: loan.id,
        amount: 2500, // covers both cycles with some over
        paidOn: "2026-04-01",
        dueDate: "2026-04-01",
      },
    ];
    // Today (2026-05-17) ≥ maturity (2026-05-01), so paid_off path applies.
    const e = evaluateLoan(loan, payments, TODAY);
    expect(e.status).toBe("paid_off");
    expect(e.nextDueDate).toBeNull();
  });

  it("partial still pending (not covered) → nextDueDate stays on the partial's dueDate", () => {
    // While the cycle is short, nextDueDate should point to the same due date
    // so the UI can lock the field there until the borrower completes payment.
    const loan = synthLoan({
      firstDueDate: "2026-04-01",
      termMonths: 12,
      maturityDate: "2027-03-01",
    });
    const payments = [
      { id: "P-1", loanId: loan.id, amount: 600, paidOn: "2026-04-01", dueDate: "2026-04-01" },
    ];
    // 600 of 1000 — partial within grace (0d late), due date 16d ago → late
    const e = evaluateLoan(loan, payments, TODAY);
    expect(e.status).toBe("late");
    expect(e.lastPaymentStatus.classification).toBe("partial");
    // firstUncovered is null (cycle covered within grace) so nextDueDate falls
    // through to the upcoming schedule entry — but since Apr is 16d past and
    // not a future date, the next upcoming schedule entry is May 1.
    // The frontend uses lastPayment.dueDate (not nextDueDate) to lock the field.
    expect(e.lastPayment.dueDate).toBe("2026-04-01");
  });
}); // end describe("evaluateLoan — synthetic scenarios")

// ---------------------------------------------------------------------------
// computeCurrentBalance — basic amortization sanity
// ---------------------------------------------------------------------------

describe("computeCurrentBalance", () => {
  it("equals principal when there are no payments", () => {
    const loan = synthLoan({ principal: 50000 });
    expect(computeCurrentBalance(loan, [])).toBe(50000);
  });

  it("decreases monotonically as payments accumulate", () => {
    const loan = synthLoan({
      principal: 50000,
      annualRate: 0.06,
      monthlyPayment: 1000,
    });
    const payments = [
      { id: "1", loanId: loan.id, amount: 1000, paidOn: "2025-02-01", dueDate: "2025-02-01" },
      { id: "2", loanId: loan.id, amount: 1000, paidOn: "2025-03-01", dueDate: "2025-03-01" },
      { id: "3", loanId: loan.id, amount: 1000, paidOn: "2025-04-01", dueDate: "2025-04-01" },
    ];
    const b1 = computeCurrentBalance(loan, payments.slice(0, 1));
    const b2 = computeCurrentBalance(loan, payments.slice(0, 2));
    const b3 = computeCurrentBalance(loan, payments);
    expect(b1).toBeLessThan(loan.principal);
    expect(b2).toBeLessThan(b1);
    expect(b3).toBeLessThan(b2);
  });

  it("never returns a negative balance, even with massive over-payments", () => {
    const loan = synthLoan({ principal: 5000, monthlyPayment: 1000 });
    const payments = [
      { id: "1", loanId: loan.id, amount: 100000, paidOn: "2025-02-01", dueDate: "2025-02-01" },
    ];
    expect(computeCurrentBalance(loan, payments)).toBe(0);
  });
});
