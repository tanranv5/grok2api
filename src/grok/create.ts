import type { GrokSettings } from "../settings";
import { getDynamicHeaders } from "./headers";

const ENDPOINT = "https://grok.com/rest/media/post/create";

export async function createPost(
  fileUri: string,
  cookie: string,
  settings: GrokSettings,
): Promise<{ postId: string }> {
  const headers = getDynamicHeaders(settings, "/rest/media/post/create");
  headers.Cookie = cookie;
  const body = JSON.stringify({
    media_url: `https://assets.grok.com/${fileUri}`,
    media_type: "MEDIA_POST_TYPE_IMAGE",
  });

  const resp = await fetch(ENDPOINT, { method: "POST", headers, body });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`创建会话失败: ${resp.status} ${text.slice(0, 200)}`);
  }

  const data = (await resp.json()) as { post?: { id?: string } };
  return { postId: data.post?.id ?? "" };
}

