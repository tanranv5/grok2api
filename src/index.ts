import { Hono } from "hono";
import type { Env } from "./env";
import { openAiRoutes } from "./routes/openai";
import { mediaRoutes } from "./routes/media";
import { adminRoutes } from "./routes/admin";
import { runKvDailyClear } from "./kv/cleanup";

const app = new Hono<{ Bindings: Env }>();

function getAssets(env: Env): Fetcher | null {
  const anyEnv = env as unknown as { ASSETS?: unknown };
  const assets = anyEnv.ASSETS as { fetch?: unknown } | undefined;
  return assets && typeof assets.fetch === "function" ? (assets as Fetcher) : null;
}

function assetFetchError(message: string): Response {
  return new Response(message, { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
}

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

async function fetchAsset(c: any, pathname: string): Promise<Response> {
  const assets = getAssets(c.env as Env);
  if (!assets) {
    console.error("ASSETS binding missing: check wrangler.toml assets binding");
    return assetFetchError("Internal Server Error: missing ASSETS binding.");
  }

  const url = new URL(c.req.url);
  url.pathname = pathname;
  try {
    const res = await assets.fetch(new Request(url.toString(), c.req.raw));
    return withNoCacheIfNeeded(res, pathname);
  } catch (err) {
    console.error(`ASSETS fetch failed (${pathname}):`, err);
    return assetFetchError(`Internal Server Error: failed to fetch asset ${pathname}.`);
  }
}

app.route("/v1", openAiRoutes);
app.route("/", mediaRoutes);
app.route("/", adminRoutes);

app.get("/_worker.js", (c) => c.notFound());

app.get("/", (c) => c.redirect("/login", 302));

app.get("/login", async (c) => {
  return fetchAsset(c, "/login.html");
});

app.get("/manage", async (c) => {
  return fetchAsset(c, "/admin.html");
});

// 兼容历史路径，避免前端请求 /admin/imagine /admin/voice 时出现 404。
app.get("/admin/imagine", (c) => c.redirect("/imagine", 302));
app.get("/admin/voice", (c) => c.redirect("/voice", 302));

app.get("/imagine", async (c) => {
  return fetchAsset(c, "/imagine/imagine.html");
});

app.get("/voice", async (c) => {
  return fetchAsset(c, "/voice/voice.html");
});

app.get("/static/*", async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname === "/static/_worker.js") return c.notFound();
  url.pathname = url.pathname.replace(/^\/static\//, "/");
  return fetchAsset(c, url.pathname);
});

app.get("/health", (c) =>
  c.json({ status: "healthy", service: "Grok2API", runtime: "cloudflare-workers" }),
);

app.notFound(async (c) => {
  const assets = getAssets(c.env as Env);
  if (!assets) return c.text("Not Found", 404);
  try {
    return await assets.fetch(c.req.raw);
  } catch (err) {
    console.error("ASSETS fetch failed (notFound):", err);
    return c.text("Not Found", 404);
  }
});

const handler: ExportedHandler<Env> = {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
  scheduled: (_event, env, ctx) => {
    ctx.waitUntil(runKvDailyClear(env));
  },
};

export default handler;
