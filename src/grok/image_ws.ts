const WS_URL = "wss://grok.com/ws/imagine/listen";

export type ImageWsItem =
  | {
      type: "image";
      image_id: string;
      stage: "preview" | "medium" | "final";
      blob: string;
      blob_size: number;
      url: string;
      is_final: boolean;
    }
  | { type: "error"; error_code: string; error: string };

type ImageItem = Extract<ImageWsItem, { type: "image" }>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function extractImageId(url: string): string | null {
  if (!url) return null;
  const m = url.match(/\/images\/([a-f0-9-]+)\.(png|jpg|jpeg)/i);
  return m?.[1] ?? null;
}

function isFinalImage(url: string, blobSize: number, minBytes: number): boolean {
  return (url || "").toLowerCase().endsWith(".jpg") && blobSize > minBytes;
}

function classifyImage(args: {
  url: string;
  blob: string;
  finalMinBytes: number;
  mediumMinBytes: number;
}): ImageItem | null {
  const { url, blob, finalMinBytes, mediumMinBytes } = args;
  if (!url || !blob) return null;
  const imageId = extractImageId(url) || crypto.randomUUID();
  const blobSize = blob.length;
  const isFinal = isFinalImage(url, blobSize, finalMinBytes);
  const stage =
    isFinal ? "final" : blobSize > mediumMinBytes ? "medium" : "preview";
  return {
    type: "image",
    image_id: imageId,
    stage,
    blob,
    blob_size: blobSize,
    url,
    is_final: isFinal,
  };
}

async function connectWs(cookie: string): Promise<WebSocket> {
  const keyBytes = new Uint8Array(16);
  crypto.getRandomValues(keyBytes);
  let keyRaw = "";
  for (const b of keyBytes) keyRaw += String.fromCharCode(b);
  const secWebSocketKey = btoa(keyRaw);

  const resp = await fetch(WS_URL, {
    headers: {
      Cookie: cookie,
      Origin: "https://grok.com",
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Key": secWebSocketKey,
      "Sec-WebSocket-Version": "13",
    },
  });
  const ws = (resp as any).webSocket as WebSocket | undefined;
  if (!ws) {
    const body = await resp.text().catch(() => "");
    throw new Error(`WebSocket upgrade failed: ${resp.status} ${body.slice(0, 120)}`);
  }
  ws.accept();
  return ws;
}

function createMessageQueue(ws: WebSocket) {
  const queue: string[] = [];
  const waiters: Array<(msg: string | null) => void> = [];
  let closed = false;

  ws.addEventListener("message", (evt) => {
    const data = typeof evt.data === "string" ? evt.data : "";
    if (waiters.length) waiters.shift()!(data);
    else queue.push(data);
  });
  ws.addEventListener("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()!(null);
  });
  ws.addEventListener("error", () => {
    closed = true;
    while (waiters.length) waiters.shift()!(null);
  });

  async function next(timeoutMs: number): Promise<string | null> {
    if (queue.length) return queue.shift() as string;
    if (closed) return null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  return { next, isClosed: () => closed };
}

export async function* streamImagineWs(args: {
  cookie: string;
  prompt: string;
  aspect_ratio: string;
  n: number;
  enable_nsfw: boolean;
  timeout: number;
  blocked_seconds: number;
  final_min_bytes: number;
  medium_min_bytes: number;
}): AsyncGenerator<ImageWsItem, void, void> {
  const ws = await connectWs(args.cookie);
  const queue = createMessageQueue(ws);

  const message = {
    type: "conversation.item.create",
    timestamp: Date.now(),
    item: {
      type: "message",
      content: [
        {
          requestId: crypto.randomUUID(),
          text: args.prompt,
          type: "input_text",
          properties: {
            section_count: 0,
            is_kids_mode: false,
            enable_nsfw: args.enable_nsfw,
            skip_upsampler: false,
            is_initial: false,
            aspect_ratio: args.aspect_ratio,
          },
        },
      ],
    },
  };

  ws.send(JSON.stringify(message));

  let completed = 0;
  let mediumReceivedAt: number | null = null;
  const startTime = Date.now();
  let lastActivity = Date.now();
  const finalMap: Record<string, boolean> = {};

  while (Date.now() - startTime < args.timeout * 1000) {
    const raw = await queue.next(5000);
    if (!raw) {
      if (
        mediumReceivedAt &&
        completed === 0 &&
        Date.now() - mediumReceivedAt > Math.min(10000, args.blocked_seconds * 1000)
      ) {
        yield {
          type: "error",
          error_code: "blocked",
          error: "blocked_no_final_image",
        };
        break;
      }
      if (completed > 0 && Date.now() - lastActivity > 10000) break;
      continue;
    }

    lastActivity = Date.now();
    let payload: any = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      continue;
    }

    const msgType = payload?.type;
    if (msgType === "image") {
      const item = classifyImage({
        url: payload.url || "",
        blob: payload.blob || "",
        finalMinBytes: args.final_min_bytes,
        mediumMinBytes: args.medium_min_bytes,
      });
      if (!item) continue;
      if (item.stage === "medium" && !mediumReceivedAt) mediumReceivedAt = Date.now();
      if (item.is_final && !finalMap[item.image_id]) {
        finalMap[item.image_id] = true;
        completed += 1;
      }
      yield item;
    } else if (msgType === "error") {
      yield {
        type: "error",
        error_code: payload.err_code || "upstream_error",
        error: payload.err_msg || "Upstream error",
      };
      break;
    }

    if (completed >= args.n) break;
  }

  try {
    ws.close();
  } catch {
    // ignore
  }

  while (!queue.isClosed()) await sleep(10);
}
