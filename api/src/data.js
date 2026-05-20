// In-memory data store. Loaded from seed-data.json at startup.
// New payments recorded via POST are appended in-memory only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEED_PATH = path.resolve(__dirname, "../../seed-data.json");

const raw = JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));

export const loans = raw.loans.slice();
export const payments = raw.payments.slice();
export const seedNotes = raw._notes || null;

// Index for fast lookups.
const loanById = new Map(loans.map((l) => [l.id, l]));

export function getLoan(id) {
  return loanById.get(id) || null;
}

export function getPaymentsForLoan(id) {
  return payments.filter((p) => p.loanId === id);
}

// Counter for new payment IDs.
const nextSuffixByLoan = new Map();
for (const p of payments) {
  const m = /^P-\d+-(\d+)$/.exec(p.id);
  if (!m) continue;
  const n = parseInt(m[1], 10);
  const cur = nextSuffixByLoan.get(p.loanId) ?? 0;
  if (n > cur) nextSuffixByLoan.set(p.loanId, n);
}

export function addPayment({ loanId, amount, paidOn, dueDate }) {
  const cur = nextSuffixByLoan.get(loanId) ?? 0;
  const next = cur + 1;
  nextSuffixByLoan.set(loanId, next);
  const numericPart = loanId.replace(/^L-/, "");
  const id = `P-${numericPart}-${String(next).padStart(2, "0")}`;
  const record = { id, loanId, amount, paidOn, dueDate };
  payments.push(record);
  return record;
}
