import type { Env } from "../env";
import type { ApiAuthInfo } from "../auth";
import { authenticateApiToken } from "../auth";
import { verifyAdminSession } from "../repo/adminSessions";

const VOICE_SIGNAL_PROXY_PREFIX = "/v1/public/voice/signal/";

export function buildPublicSignalProxyUrl(requestUrl: URL, token: string): string {
  const protocol = requestUrl.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${requestUrl.host}${VOICE_SIGNAL_PROXY_PREFIX}${encodeURIComponent(token)}`;
}

export async function authenticateQueryToken(
  env: Env,
  rawToken: string | null,
): Promise<ApiAuthInfo | null> {
  if (!rawToken) return authenticateApiToken(env, null);

  const normalized = rawToken.trim();
  if (!normalized) return authenticateApiToken(env, null);

  const apiAuth = await authenticateApiToken(env, `Bearer ${normalized}`);
  if (apiAuth) return apiAuth;

  const adminOk = await verifyAdminSession(env.DB, normalized);
  if (!adminOk) return null;
  return { key: normalized, name: "AdminSession", is_admin: true };
}

export async function handlePublicVoiceSignalProxy(c: any): Promise<Response> {
  const rawToken = decodeURIComponent(String(c.req.param("token") ?? ""));
  const authInfo = await authenticateQueryToken(c.env, rawToken);
  if (!authInfo) return c.text("Unauthorized", 401);
  if (c.req.header("Upgrade")?.toLowerCase() !== "websocket") return c.text("Expected websocket", 426);

  const reqUrl = new URL(c.req.url);
  const prefix = `${VOICE_SIGNAL_PROXY_PREFIX}${encodeURIComponent(rawToken)}`;
  const suffix = reqUrl.pathname.startsWith(prefix) ? reqUrl.pathname.slice(prefix.length) : "";
  const upstreamUrl = new URL(`https://livekit.grok.com${suffix && suffix !== "/" ? suffix : "/rtc"}`);
  upstreamUrl.search = reqUrl.search;

  const upstream = await fetch(upstreamUrl.toString(), {
    method: "GET",
    headers: {
      Upgrade: "websocket",
      Connection: "Upgrade",
      Origin: "https://grok.com",
      "User-Agent": c.req.header("User-Agent") || "Mozilla/5.0",
      ...(c.req.header("Sec-WebSocket-Protocol")
        ? { "Sec-WebSocket-Protocol": c.req.header("Sec-WebSocket-Protocol") as string }
        : {}),
    },
  });
  const upstreamWs = (upstream as any).webSocket as WebSocket | undefined;
  if (!upstreamWs) return c.text(`Upstream signal failed: ${upstream.status}`, 502);

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  upstreamWs.accept();
  let closed = false;
  const closeBoth = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    try { server.close(code, reason); } catch {}
    try { upstreamWs.close(code, reason); } catch {}
  };
  server.addEventListener("message", (event) => { try { upstreamWs.send(event.data as any); } catch { closeBoth(1011, "upstream_send_error"); } });
  upstreamWs.addEventListener("message", (event) => { try { server.send(event.data as any); } catch { closeBoth(1011, "client_send_error"); } });
  server.addEventListener("close", () => closeBoth(1000, "client_closed"));
  upstreamWs.addEventListener("close", () => closeBoth(1000, "upstream_closed"));
  server.addEventListener("error", () => closeBoth(1011, "client_error"));
  upstreamWs.addEventListener("error", () => closeBoth(1011, "upstream_error"));
  return new Response(null, { status: 101, webSocket: client });
}
