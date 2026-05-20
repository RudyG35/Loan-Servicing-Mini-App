// Pure-Node smoke test for the evaluation rules. No npm deps required.
// Run: node smoke-test.js

import { evaluateLoan, parseDate, addMonths, formatDate } from "./src/evaluation.js";
import { loans, getPaymentsForLoan, addPayment } from "./src/data.js";

const today = parseDate("2026-05-17");

const expectations = [
  { id: "L-1003", status: "delinquent", note: "two consecutive missed payments" },
  { id: "L-1004", status: "paid_off",   note: "last payment on maturity date" },
  { id: "L-1005", status: "current",    note: "recent payment late (12d), cycle covered",
    lastPaymentClassification: "late" },
  { id: "L-1006", status: "late",       note: "partial payment, due date 16d past grace → late",
    lastPaymentClassification: "partial" },
  { id: "L-1007", status: "current",    note: "late but within a 10-day grace period",
    lastPaymentClassification: "late_within_grace" },
  { id: "L-1008", status: "current",    note: "brand-new loan, firstDue 2026-06-01 (still in the future), no payments yet" },
  { id: "L-1001", status: "current",    note: "healthy loan (control)" },
  { id: "L-1009", status: "current",    note: "healthy — 2020 origination, 30yr" },
  { id: "L-1010", status: "current",    note: "healthy — 2019 origination, 30yr" },
  { id: "L-1011", status: "current",    note: "healthy — 2017 origination, 15yr" },
  { id: "L-1012", status: "current",    note: "healthy — 2021 origination, 30yr" },
  { id: "L-1013", status: "current",    note: "healthy — 2023 origination, 30yr" },
  { id: "L-1014", status: "current",    note: "healthy — 2024 origination, 30yr (high balance)" },
  { id: "L-1015", status: "current",    note: "healthy — 2019 origination, 15yr" },
  { id: "L-1016", status: "current",    note: "healthy — 2022 origination, 30yr" },
  { id: "L-1017", status: "current",    note: "healthy — 2023 origination, 30yr" },
  { id: "L-1018", status: "current",    note: "healthy — 2018 origination, 20yr" },
  { id: "L-1019", status: "current",    note: "healthy — 2024 origination, 30yr" },
  { id: "L-1020", status: "current",     note: "all payments on time through 2026-05-01 — healthy" },
];

let failures = 0;
for (const exp of expectations) {
  const loan = loans.find((l) => l.id === exp.id);
  if (!loan) {
    console.log(`MISSING  ${exp.id}: not in seed`);
    failures++;
    continue;
  }
  const ps = getPaymentsForLoan(exp.id);
  const e = evaluateLoan(loan, ps, today);

  const statusOk = e.status === exp.status;
  const lpOk =
    !exp.lastPaymentClassification ||
    e.lastPaymentStatus?.classification === exp.lastPaymentClassification;

  const tag = statusOk && lpOk ? "OK  " : "FAIL";
  if (!statusOk || !lpOk) failures++;

  const lp = e.lastPaymentStatus
    ? `  lastPayment=${e.lastPaymentStatus.classification}(${e.lastPaymentStatus.daysLate}d)`
    : "";
  console.log(
    `${tag}  ${exp.id}  status=${e.status}` +
      `  daysPastDue=${e.daysPastDue}` +
      `  onTime12mo=${e.onTimeRate12mo == null ? "n/a" : (e.onTimeRate12mo * 100).toFixed(0) + "%"}` +
      `${lp}`,
  );
  console.log(`        summary: ${e.summary}`);
  if (!statusOk) console.log(`        expected status=${exp.status} (${exp.note})`);
  if (!lpOk)
    console.log(
      `        expected lastPayment=${exp.lastPaymentClassification}, got ${e.lastPaymentStatus?.classification}`,
    );
}

console.log("\n--- post-payment flow on L-1003 ---");
const l1003 = loans.find((l) => l.id === "L-1003");

addPayment({ loanId: "L-1003", amount: l1003.monthlyPayment, paidOn: "2026-05-17", dueDate: "2026-04-01" });
let e = evaluateLoan(l1003, getPaymentsForLoan("L-1003"), today);
console.log(`after paying April: status=${e.status}, daysPastDue=${e.daysPastDue}, missed=${e.missedCycles}`);
// 1 remaining missed cycle (May), 16d past grace → status=late
if (e.status !== "late" || e.missedCycles !== 1) {
  console.log("FAIL: expected late (1 missed cycle, past grace, below delinquency threshold)");
  failures++;
}

addPayment({ loanId: "L-1003", amount: l1003.monthlyPayment, paidOn: "2026-05-17", dueDate: "2026-05-01" });
e = evaluateLoan(l1003, getPaymentsForLoan("L-1003"), today);
console.log(`after paying May:   status=${e.status}, daysPastDue=${e.daysPastDue}, missed=${e.missedCycles}`);
if (e.status !== "current") {
  console.log("FAIL: expected current after both cycles paid");
  failures++;
}

console.log("\n--- cumulative partial payment flow on L-1006 ---");
const l1006 = loans.find((l) => l.id === "L-1006");
const ps1006before = getPaymentsForLoan("L-1006");
const e1006before = evaluateLoan(l1006, ps1006before, today);
console.log(`before top-up: status=${e1006before.status}, lastPayment=${e1006before.lastPaymentStatus?.classification}`);
if (e1006before.status !== "late") {
  console.log("FAIL: expected late before completing partial payment");
  failures++;
}

// Add a payment that closes the gap for the partial cycle.
// Use the evaluator's shortBy so we don't hard-code payment IDs.
const shortBy = e1006before.lastPaymentStatus.shortBy;
const partialDueDate = e1006before.lastPayment.dueDate;
addPayment({ loanId: "L-1006", amount: shortBy + 0.01, paidOn: "2026-05-17", dueDate: partialDueDate });
const e1006after = evaluateLoan(l1006, getPaymentsForLoan("L-1006"), today);
console.log(`after top-up: status=${e1006after.status}, missed=${e1006after.missedCycles}, nextDue=${e1006after.nextDueDate}`);
if (e1006after.status !== "current") {
  console.log("FAIL: expected current after cumulative partials cover the monthly payment");
  failures++;
}
// nextDueDate must advance past the now-covered partial cycle so the UI can
// unlock the due date field and move the CSR to the next billing cycle.
if (e1006after.nextDueDate === partialDueDate) {
  console.log(`FAIL: nextDueDate still pinned to partial's dueDate (${partialDueDate}) — should have advanced`);
  failures++;
}
// On-time rate must NOT improve after the completing payment: the completing
// payment (paidOn May 17) arrived well past grace for L-1006's partial cycle,
// so the cumulative total was reached late — the cycle is not on-time.
const rateAfter = e1006after.onTimeRate12mo;
const rateBefore = e1006before.onTimeRate12mo;
console.log(`onTime12mo: before=${(rateBefore * 100).toFixed(0)}%  after=${(rateAfter * 100).toFixed(0)}%  (should be equal)`);
if (rateAfter !== rateBefore) {
  console.log(`FAIL: on-time rate changed from ${(rateBefore * 100).toFixed(0)}% to ${(rateAfter * 100).toFixed(0)}% after completing payment — should be unchanged`);
  failures++;
}

console.log("\n--- multi-cycle overpayment split flow on L-1003 ---");
// L-1003 is delinquent with April + May missed. Simulate the POST handler's
// split loop: a 3× payment should produce three records covering Apr, May, Jun.
const l1003b = loans.find((l) => l.id === "L-1003");
const dueDates = ["2026-04-01", "2026-05-01", "2026-06-01"];
const splitRecs = dueDates.map((dd) =>
  addPayment({ loanId: "L-1003", amount: l1003b.monthlyPayment, paidOn: "2026-05-17", dueDate: dd }),
);
// Each record must land on the right consecutive due date.
let splitOk = true;
for (let i = 0; i < splitRecs.length; i++) {
  if (splitRecs[i].dueDate !== dueDates[i]) {
    console.log(`FAIL: split[${i}] dueDate=${splitRecs[i].dueDate}, expected ${dueDates[i]}`);
    failures++; splitOk = false;
  }
}
const eOver = evaluateLoan(l1003b, getPaymentsForLoan("L-1003"), today);
console.log(
  `after 3× split: status=${eOver.status}, missed=${eOver.missedCycles}, nextDue=${eOver.nextDueDate}`,
);
console.log(`  split records: ${splitRecs.map((r) => `${r.dueDate}=$${r.amount}`).join(", ")}`);
if (eOver.status !== "current") {
  console.log("FAIL: expected current — three splits should cover Apr+May and pre-pay Jun");
  failures++;
}
if (eOver.missedCycles !== 0) {
  console.log(`FAIL: expected 0 missed cycles, got ${eOver.missedCycles}`);
  failures++;
}

// --- on-time rate: lump sum grading ---
// Uses evaluateLoan directly with isolated synthetic data (no addPayment).
console.log("\n--- on-time rate: lump sum grading ---");

const otLoan = {
  id: "OT-TEST", borrowerName: "Test", principal: 120000, annualRate: 0.06,
  termMonths: 12, monthlyPayment: 1000, originationDate: "2026-03-01",
  firstDueDate: "2026-04-01", maturityDate: "2027-03-01",
};

// Case A: lump sum paid Apr 1 covering Apr + pre-paying May.
// Apr (paidOn=Apr 1, dueDate=Apr 1): 0d late → on-time.
// May (paidOn=Apr 1, dueDate=May 1): 30d early → on-time. → 100%
const eLsOnTime = evaluateLoan(otLoan, [
  { id: "OT-1", loanId: "OT-TEST", amount: 1000, paidOn: "2026-04-01", dueDate: "2026-04-01" },
  { id: "OT-2", loanId: "OT-TEST", amount: 1000, paidOn: "2026-04-01", dueDate: "2026-05-01" },
], today);
console.log(`lump sum on time:   onTime12mo=${(eLsOnTime.onTimeRate12mo * 100).toFixed(0)}%  (expected 100%)`);
if (eLsOnTime.onTimeRate12mo !== 1) { console.log("FAIL"); failures++; }

// Case B: late lump sum paid May 17 covering Apr+May — both past grace, total < 12mo → 0%
const eLsLate = evaluateLoan(otLoan, [
  { id: "OT-3", loanId: "OT-TEST", amount: 1000, paidOn: "2026-05-17", dueDate: "2026-04-01" },
  { id: "OT-4", loanId: "OT-TEST", amount: 1000, paidOn: "2026-05-17", dueDate: "2026-05-01" },
], today);
console.log(`late lump sum:      onTime12mo=${(eLsLate.onTimeRate12mo * 100).toFixed(0)}%  (expected 0%)`);
if (eLsLate.onTimeRate12mo !== 0) { console.log("FAIL"); failures++; }

// Case C: delinquent loan + lump sum ≥ 12 × monthlyPayment on one day → 100%
// 10 on-time + 2 missed (Apr/May) → normally 83%. A 12-record split on May 17
// (total = 12 × 1000) triggers the lump-sum override → rate = 100%.
const lsDelinquentLoan = {
  id: "LS-DLQ", borrowerName: "Test", principal: 120000, annualRate: 0.06,
  termMonths: 24, monthlyPayment: 1000, originationDate: "2025-05-01",
  firstDueDate: "2025-06-01", maturityDate: "2027-05-01",
};
const lsDelinquentPayments = [];
for (let i = 0; i < 10; i++) {
  const d = formatDate(addMonths(parseDate("2025-06-01"), i));
  lsDelinquentPayments.push({ id: `DLQ-OT-${i}`, loanId: "LS-DLQ", amount: 1000, paidOn: d, dueDate: d });
}
for (let i = 0; i < 12; i++) {
  const due = formatDate(addMonths(parseDate("2026-04-01"), i));
  lsDelinquentPayments.push({ id: `DLQ-LS-${i}`, loanId: "LS-DLQ", amount: 1000, paidOn: "2026-05-17", dueDate: due });
}
const eLsDelinquent = evaluateLoan(lsDelinquentLoan, lsDelinquentPayments, today);
console.log(`lump sum ≥12mo:     onTime12mo=${(eLsDelinquent.onTimeRate12mo * 100).toFixed(0)}%  (expected 100%)`);
if (eLsDelinquent.onTimeRate12mo !== 1) { console.log("FAIL"); failures++; }

console.log(`\n${failures === 0 ? "All checks passed." : failures + " failure(s)."}`);
process.exit(failures === 0 ? 0 : 1);
