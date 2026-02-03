import type { GrokSettings } from "../settings";
import { getDynamicHeaders } from "./headers";
import { arrayBufferToBase64 } from "../utils/base64";

const UPLOAD_API = "https://grok.com/rest/app-chat/upload-file";

const MIME_DEFAULT = "image/jpeg";

function isUrl(input: string): boolean {
  try {
    const u = new URL(input);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function guessExtFromMime(mime: string): string {
  const m = mime.split(";")[0]?.trim() ?? "";
  const parts = m.split("/");
  return parts.length === 2 && parts[1] ? parts[1] : "jpg";
}

function parseDataUrl(dataUrl: string): { base64: string; mime: string } {
  const trimmed = dataUrl.trim();
  const comma = trimmed.indexOf(",");
  if (comma === -1) return { base64: trimmed, mime: MIME_DEFAULT };
  const header = trimmed.slice(0, comma);
  const base64 = trimmed.slice(comma + 1);
  const match = header.match(/^data:([^;]+);base64$/i);
  return { base64, mime: match?.[1] ?? MIME_DEFAULT };
}

export async function uploadImage(
  imageInput: string,
  cookie: string,
  settings: GrokSettings,
): Promise<{ fileId: string; fileUri: string }> {
  let base64 = "";
  let mime = MIME_DEFAULT;
  let filename = "image.jpg";

  if (isUrl(imageInput)) {
    const r = await fetch(imageInput, { redirect: "follow" });
    if (!r.ok) throw new Error(`下载图片失败: ${r.status}`);
    mime = r.headers.get("content-type")?.split(";")[0] ?? MIME_DEFAULT;
    if (!mime.startsWith("image/")) mime = MIME_DEFAULT;
    base64 = arrayBufferToBase64(await r.arrayBuffer());
    filename = `image.${guessExtFromMime(mime)}`;
  } else if (imageInput.trim().startsWith("data:image")) {
    const parsed = parseDataUrl(imageInput);
    base64 = parsed.base64;
    mime = parsed.mime;
    filename = `image.${guessExtFromMime(mime)}`;
  } else {
    base64 = imageInput.trim();
    filename = "image.jpg";
    mime = MIME_DEFAULT;
  }

  const body = JSON.stringify({
    fileName: filename,
    fileMimeType: mime,
    content: base64,
  });

  const headers = getDynamicHeaders(settings, "/rest/app-chat/upload-file");
  headers.Cookie = cookie;

  const resp = await fetch(UPLOAD_API, { method: "POST", headers, body });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`上传失败: ${resp.status} ${text.slice(0, 200)}`);
  }
  const data = (await resp.json()) as { fileMetadataId?: string; fileUri?: string };
  return { fileId: data.fileMetadataId ?? "", fileUri: data.fileUri ?? "" };
}

