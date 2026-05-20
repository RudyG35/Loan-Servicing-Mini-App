// Tiny fetch wrapper. All requests go through the Vite dev proxy at /api/*.

const BASE = "/api";

async function request(path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      // fall back to status text only
    }
    throw new Error(message);
  }
  return res.json();
}

export const api = {
  listLoans: () => request("/loans"),
  getLoan: (id) => request(`/loans/${id}`),
  getPayments: (id) => request(`/loans/${id}/payments`),
  getEvaluation: (id) => request(`/loans/${id}/evaluation`),
  recordPayment: (id, body) =>
    request(`/loans/${id}/payments`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
