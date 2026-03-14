interface EditBodyInput {
  prompt?: unknown;
  parent_post_id?: unknown;
  source_image_url?: unknown;
  image_url?: unknown;
  image_base64?: unknown;
  image_references?: unknown;
  reference_items?: unknown;
}

function normalizeDataUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("data:image/")) return trimmed;
  return `data:image/png;base64,${trimmed}`;
}

async function fetchImageBlob(input: string): Promise<Blob> {
  const trimmed = input.trim();
  if (!trimmed) throw new Error("缺少图片输入");

  if (trimmed.startsWith("data:image/")) {
    const response = await fetch(trimmed);
    return response.blob();
  }

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("/")) {
    const response = await fetch(trimmed);
    if (!response.ok) {
      throw new Error(`拉取参考图失败: ${response.status}`);
    }
    return response.blob();
  }

  const dataUrl = normalizeDataUrl(trimmed);
  const response = await fetch(dataUrl);
  return response.blob();
}

function collectImageInputs(body: EditBodyInput): string[] {
  const values: string[] = [];
  const pushValue = (value: unknown) => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed) values.push(trimmed);
  };

  pushValue(body.source_image_url);
  pushValue(body.image_url);
  pushValue(body.image_base64);

  if (Array.isArray(body.image_references)) {
    body.image_references.forEach(pushValue);
  }

  if (Array.isArray(body.reference_items)) {
    body.reference_items.forEach((item) => {
      if (!item || typeof item !== "object") return;
      pushValue((item as Record<string, unknown>).source_image_url);
      pushValue((item as Record<string, unknown>).image_url);
    });
  }

  return Array.from(new Set(values));
}

function buildEditResult(payload: any) {
  const items = Array.isArray(payload?.data) ? payload.data : [];
  const first = items[0] ?? {};
  const imageUrl = typeof first.url === "string" ? first.url : "";
  const match =
    imageUrl.match(/\/generated\/([a-f0-9-]+)\//i) ||
    imageUrl.match(/\/users\/[^/]+\/([a-f0-9-]+)\/content/i);
  const parentPostId = match?.[1] ?? "";
  return {
    created: payload?.created ?? Math.floor(Date.now() / 1000),
    data: items,
    generated_parent_post_id: parentPostId,
    current_parent_post_id: parentPostId,
    current_source_image_url: imageUrl,
    elapsed_ms: 0,
  };
}

async function submitEditRequest(
  requestUrl: string,
  authHeader: string | null,
  prompt: string,
  model: string,
  images: File[],
): Promise<Response> {
  const form = new FormData();
  form.set("prompt", prompt);
  form.set("model", model);
  form.set("n", "1");
  form.set("response_format", "url");
  images.forEach((image) => form.append("image", image, image.name));

  const init: RequestInit = { method: "POST", body: form };
  if (authHeader) init.headers = { Authorization: authHeader };
  return fetch(new Request(new URL("/v1/images/edits", requestUrl).toString(), init));
}

export async function runPublicEdit(
  requestUrl: string,
  authHeader: string | null,
  body: EditBodyInput,
  stream: boolean,
): Promise<Response> {
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) {
    return Response.json({ detail: "Prompt cannot be empty" }, { status: 400 });
  }

  const sources = collectImageInputs(body);
  if (!sources.length) {
    return Response.json({ detail: "至少提供一张参考图" }, { status: 400 });
  }

  const blobs = await Promise.all(sources.slice(0, 5).map(fetchImageBlob));
  const files = blobs.map(
    (blob, index) => new File([blob], `reference-${index + 1}.png`, { type: blob.type || "image/png" }),
  );

  const response = await submitEditRequest(requestUrl, authHeader, prompt, "grok-imagine-1.0-edit", files);
  if (!stream) return response;
  if (!response.ok) return response;

  const payload = await response.json().catch(() => null);
  if (!payload) {
    return Response.json({ detail: "编辑结果为空" }, { status: 502 });
  }

  const encoder = new TextEncoder();
  const streamBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `event: progress\ndata: ${JSON.stringify({ event: "request_accepted", progress: 20, message: "已接收编辑请求" })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(
          `event: progress\ndata: ${JSON.stringify({ event: "completed", progress: 100, message: "编辑完成 100%" })}\n\n`,
        ),
      );
      controller.enqueue(
        encoder.encode(`event: result\ndata: ${JSON.stringify(buildEditResult(payload))}\n\n`),
      );
      controller.close();
    },
  });

  return new Response(streamBody, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
