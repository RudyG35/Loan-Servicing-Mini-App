import {
  getLoan,
  getPaymentsForLoan,
  loans,
  addPayment,
} from "./data.js";
import {
  evaluateLoan,
  computeCurrentBalance,
  classifyPayment,
  parseDate,
  formatDate,
  addMonths,
} from "./evaluation.js";

const COVERAGE_TOLERANCE = 0.01; // dollars — matches evaluation.js

// Resolve evaluation "today". Accepts ?asOf=YYYY-MM-DD on any endpoint that
// uses it; falls back to system clock.
function resolveToday(req) {
  const asOf = req.query?.asOf;
  if (asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    const [y, m, d] = asOf.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

export default async function routes(fastify) {
  // GET /loans — list with summary status + balance for the picker.
  fastify.get("/loans", async (req) => {
    const today = resolveToday(req);
    return loans.map((loan) => {
      const ps = getPaymentsForLoan(loan.id);
      const evalResult = evaluateLoan(loan, ps, today);
      return {
        id: loan.id,
        borrowerName: loan.borrowerName,
        status: evalResult.status,
        lastPaymentClassification: evalResult.lastPaymentStatus?.classification ?? null,
        currentBalance:
          evalResult.status === "paid_off"
            ? 0
            : computeCurrentBalance(loan, ps),
        nextDueDate: evalResult.nextDueDate,
      };
    });
  });

  // GET /loans/:id — full loan detail.
  fastify.get("/loans/:id", async (req, reply) => {
    const loan = getLoan(req.params.id);
    if (!loan) {
      req.log.warn({ loanId: req.params.id }, "loan not found");
      return reply.code(404).send({ error: "loan not found" });
    }

    const today = resolveToday(req);
    const ps = getPaymentsForLoan(loan.id);
    const evalResult = evaluateLoan(loan, ps, today);

    return {
      ...loan,
      status: evalResult.status,
      nextDueDate: evalResult.nextDueDate,
      currentBalance:
        evalResult.status === "paid_off"
          ? 0
          : computeCurrentBalance(loan, ps),
    };
  });

  // GET /loans/:id/payments — history, newest first, each tagged with classification.
  fastify.get("/loans/:id/payments", async (req, reply) => {
    const loan = getLoan(req.params.id);
    if (!loan) {
      req.log.warn({ loanId: req.params.id }, "loan not found");
      return reply.code(404).send({ error: "loan not found" });
    }

    const ps = getPaymentsForLoan(loan.id);

    // Sort newest-first by dueDate. For same due-date payments, fall back
    // to descending sequence number from the payment ID (e.g. P-1001-03 > P-1001-02)
    // so the most recently recorded payment for that cycle appears first.
    const seqOf = (p) => parseInt(p.id.split("-").at(-1), 10) || 0;
    const sorted = [...ps].sort((a, b) => {
      const tDiff = new Date(b.dueDate) - new Date(a.dueDate);
      return tDiff !== 0 ? tDiff : seqOf(b) - seqOf(a);
    });

    return sorted.map((p) => ({
      ...p,
      ...classifyPayment(p, loan),
    }));
  });

  // POST /loans/:id/payments — record a payment, return on-time determination.
  // body: { amount: number, paidOn: "YYYY-MM-DD", dueDate?: "YYYY-MM-DD" }
  fastify.post("/loans/:id/payments", async (req, reply) => {
    const loan = getLoan(req.params.id);
    if (!loan) {
      req.log.warn({ loanId: req.params.id }, "loan not found");
      return reply.code(404).send({ error: "loan not found" });
    }

    // Block payments on fully paid-off loans.
    const today = resolveToday(req);
    const psCheck = getPaymentsForLoan(loan.id);
    const evalCheck = evaluateLoan(loan, psCheck, today);
    if (evalCheck.status === "paid_off") {
      req.log.warn({ loanId: loan.id }, "payment rejected — loan is paid off");
      return reply.code(422).send({
        error: "Cannot record a payment — this loan is already paid off.",
      });
    }

    const body = req.body ?? {};
    const amount = Number(body.amount);
    const paidOn = body.paidOn;
    let dueDate = body.dueDate;

    if (!Number.isFinite(amount) || amount <= 0) {
      req.log.warn({ loanId: loan.id, amount: body.amount }, "payment rejected — invalid amount");
      return reply.code(400).send({ error: "amount must be a positive number" });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paidOn ?? "")) {
      req.log.warn({ loanId: loan.id, paidOn }, "payment rejected — invalid paidOn date");
      return reply.code(400).send({ error: "paidOn must be YYYY-MM-DD" });
    }
    if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      req.log.warn({ loanId: loan.id, dueDate }, "payment rejected — invalid dueDate");
      return reply.code(400).send({ error: "dueDate must be YYYY-MM-DD" });
    }

    if (!dueDate) {
      dueDate = evalCheck.nextDueDate ?? loan.firstDueDate;
    }

    // Overpayment check: reject any amount that exceeds the remaining balance.
    const currentBalance = computeCurrentBalance(loan, psCheck);
    const overpayment = Math.round((amount - currentBalance) * 100) / 100;

    if (overpayment > COVERAGE_TOLERANCE) {
      // Payment exceeds the remaining balance — reject so the CSR can correct
      // the amount before recording. Return 422 with the exact overage.
      req.log.warn(
        { loanId: loan.id, amount, currentBalance: Math.round(currentBalance * 100) / 100, overpayment },
        "payment rejected — amount exceeds remaining balance",
      );
      return reply.code(422).send({
        error: "Error: Payment exceeds remaining balance.",
        overpayment,
        currentBalance: Math.round(currentBalance * 100) / 100,
      });
    }

    // Build a coverage snapshot from payments already on file so the split
    // can compute the true gap for each cycle (monthlyPayment − already paid).
    // psCheck holds the pre-payment snapshot from the paid-off guard above.
    const coveredByDue = new Map();
    for (const p of psCheck) {
      coveredByDue.set(p.dueDate, (coveredByDue.get(p.dueDate) ?? 0) + p.amount);
    }

    // Distribute the payment across consecutive due-date cycles, gap-aware:
    //   • For the initial dueDate, only fill the remaining gap (monthlyPayment
    //     minus what is already covered). A partial cycle gets completed first.
    //   • Each subsequent cycle is filled up to its own gap (full monthlyPayment
    //     if nothing has been paid there yet).
    //   • Each slice is stored as its own payment record so history is accurate.
    const records = [];
    let remaining = Math.round(amount * 100) / 100;
    let currentDue = dueDate;

    while (remaining > COVERAGE_TOLERANCE) {
      const alreadyCovered = coveredByDue.get(currentDue) ?? 0;
      const gap = Math.max(
        0,
        Math.round((loan.monthlyPayment - alreadyCovered) * 100) / 100,
      );
      // If this cycle already has a gap, fill it; otherwise treat it as a fresh
      // cycle needing the full monthly payment.
      const cycleNeed = gap > COVERAGE_TOLERANCE ? gap : loan.monthlyPayment;
      const slice = Math.min(remaining, cycleNeed);

      records.push(
        addPayment({
          loanId: loan.id,
          amount: Math.round(slice * 100) / 100,
          paidOn,
          dueDate: currentDue,
        }),
      );

      remaining = Math.round((remaining - slice) * 100) / 100;
      if (remaining > COVERAGE_TOLERANCE) {
        currentDue = formatDate(addMonths(parseDate(currentDue), 1));
      }
    }

    const [record, ...splitRecords] = records;
    const classification = classifyPayment(record, loan);
    const ps = getPaymentsForLoan(loan.id);
    const evalResult = evaluateLoan(loan, ps, today);

    req.log.info(
      {
        loanId: loan.id,
        amount,
        paidOn,
        dueDate: record.dueDate,
        cycles: records.length,
        classification: classification.classification,
        status: evalResult.status,
      },
      "payment recorded",
    );

    const response = {
      payment: { ...record, ...classification },
      evaluation: evalResult,
      currentBalance:
        evalResult.status === "paid_off"
          ? 0
          : computeCurrentBalance(loan, ps),
    };
    if (splitRecords.length > 0) {
      response.splitPayments = splitRecords.map((r) => ({
        ...r,
        ...classifyPayment(r, loan),
      }));
    }

    return reply.code(201).send(response);
  });

  // GET /loans/:id/evaluation — status / days past due / on-time rate / summary.
  fastify.get("/loans/:id/evaluation", async (req, reply) => {
    const loan = getLoan(req.params.id);
    if (!loan) {
      req.log.warn({ loanId: req.params.id }, "loan not found");
      return reply.code(404).send({ error: "loan not found" });
    }

    const today = resolveToday(req);
    const ps = getPaymentsForLoan(loan.id);
    return evaluateLoan(loan, ps, today);
  });
}
