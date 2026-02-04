import { Hono } from "hono";
import type { Env } from "./env";
import { openAiRoutes } from "./routes/openai";
import { mediaRoutes } from "./routes/media";
import { adminRoutes } from "./routes/admin";
import { runKvDailyClear } from "./kv/cleanup";

const app = new Hono<{ Bindings: Env }>();

function withNoCache(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("cache-control", "no-store, no-cache, must-revalidate");
  headers.set("pragma", "no-cache");
  headers.set("expires", "0");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function withNoCacheIfNeeded(res: Response, pathname: string): Response {
  const lower = pathname.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".js") || lower.endsWith(".css")) {
    return withNoCache(res);
  }
  return res;
}

app.route("/v1", openAiRoutes);
app.route("/", mediaRoutes);
app.route("/", adminRoutes);

app.get("/_worker.js", (c) => c.notFound());

app.get("/", (c) => c.redirect("/login", 302));

app.get("/login", async (c) => {
  const res = await c.env.ASSETS.fetch(new Request(new URL("/login.html", c.req.url), c.req.raw));
  return withNoCache(res);
});

app.get("/manage", async (c) => {
  const res = await c.env.ASSETS.fetch(new Request(new URL("/admin.html", c.req.url), c.req.raw));
  return withNoCache(res);
});

app.get("/static/*", async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname === "/static/_worker.js") return c.notFound();
  url.pathname = url.pathname.replace(/^\/static\//, "/");
  const res = await c.env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
  return withNoCacheIfNeeded(res, url.pathname);
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
