import Fastify from "fastify";
import routes from "./src/routes.js";

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? "127.0.0.1";

const app = Fastify({ logger: true });

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
