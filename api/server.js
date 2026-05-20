import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Fastify from "fastify";
import routes from "./src/routes.js";

const PORT      = Number(process.env.PORT      ?? 3001);
const HOST      =        process.env.HOST      ?? "127.0.0.1";
const LOG_LEVEL =        process.env.LOG_LEVEL ?? "info";

// Ensure the logs directory exists before pino opens the file.
const LOGS_DIR  = path.join(path.dirname(fileURLToPath(import.meta.url)), "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });
const LOG_FILE  = path.join(LOGS_DIR, "app.log");

// Write structured JSON to both stdout and a rolling append-only log file.
// Use LOG_LEVEL env var to control verbosity (e.g. LOG_LEVEL=debug npm start).
const app = Fastify({
  logger: {
    level: LOG_LEVEL,
    transport: {
      targets: [
        { target: "pino/file", level: LOG_LEVEL, options: { destination: 1 } },
        { target: "pino/file", level: LOG_LEVEL, options: { destination: LOG_FILE, append: true } },
      ],
    },
  },
});

// Minimal CORS so the Vite dev server (localhost:5173) can call us.
app.addHook("onRequest", async (req, reply) => {
  reply.header("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Content-Type");
  reply.header("Vary", "Origin");
  if (req.method === "OPTIONS") {
    reply.code(204).send();
  }
});

await app.register(routes);

app.get("/health", async () => ({ ok: true }));

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`API listening on http://${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
