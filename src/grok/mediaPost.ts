import { getDynamicHeaders } from "./headers";
import type { GrokSettings } from "../settings";

const MEDIA_POST_GET_ENDPOINT = "https://grok.com/rest/media/post/get";

export interface MediaPostInfo {
  mediaUrl?: string;
  thumbnailImageUrl?: string;
  mimeType?: string;
  originalPostId?: string;
  originalRefType?: string;
}

export async function getMediaPost(
  cookie: string,
  settings: GrokSettings,
  postId: string,
): Promise<MediaPostInfo> {
  const headers = getDynamicHeaders(settings, "/rest/media/post/get");
  headers.Cookie = cookie;
  headers.Referer = "https://grok.com/";

  const response = await fetch(MEDIA_POST_GET_ENDPOINT, {
    method: "POST",
    headers,
    body: JSON.stringify({ id: postId }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Media post get failed: ${response.status} ${detail.slice(0, 200)}`);
  }

  const payload = (await response.json()) as { post?: MediaPostInfo };
  return payload.post ?? {};
}
