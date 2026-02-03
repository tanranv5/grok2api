import { Hono } from "hono";
import type { Env } from "./env";
import { openAiRoutes } from "./routes/openai";
import { mediaRoutes } from "./routes/media";
import { adminRoutes } from "./routes/admin";
import { runKvDailyClear } from "./kv/cleanup";

const app = new Hono<{ Bindings: Env }>();

app.route("/v1", openAiRoutes);
app.route("/", mediaRoutes);
app.route("/", adminRoutes);

app.get("/_worker.js", (c) => c.notFound());

app.get("/", (c) => c.redirect("/login", 302));

app.get("/login", (c) =>
  c.env.ASSETS.fetch(new Request(new URL("/login.html", c.req.url), c.req.raw)),
);

app.get("/manage", (c) =>
  c.env.ASSETS.fetch(new Request(new URL("/admin.html", c.req.url), c.req.raw)),
);

app.get("/static/*", (c) => {
  const url = new URL(c.req.url);
  if (url.pathname === "/static/_worker.js") return c.notFound();
  url.pathname = url.pathname.replace(/^\/static\//, "/");
  return c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
});

app.get("/health", (c) =>
  c.json({ status: "healthy", service: "Grok2API", runtime: "cloudflare-workers" }),
);

app.notFound((c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

const handler: ExportedHandler<Env> = {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (_event, env, ctx) => {
    ctx.waitUntil(runKvDailyClear(env));
  },
};

export default handler;
