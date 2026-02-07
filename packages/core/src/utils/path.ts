import { extname } from "node:path";
import type { MediaItem } from "@twmd/shared";

const WINDOWS_FORBIDDEN = /[<>:"/\\|?*\u0000-\u001F]/g;

export function sanitizePathPart(input: string): string {
  return input.replace(WINDOWS_FORBIDDEN, "_").trim() || "unknown";
}

function extensionFromUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    const format = parsed.searchParams.get("format")?.trim().toLowerCase();
    if (format && /^[a-z0-9]+$/.test(format)) {
      return format;
    }

    const ext = extname(parsed.pathname).toLowerCase();
    if (!ext) {
      return undefined;
    }

    return ext.slice(1);
  } catch {
    return undefined;
  }
}

function defaultExtension(kind: MediaItem["kind"]): string {
  if (kind === "image") {
    return "jpg";
  }

  if (kind === "gif") {
    return "gif";
  }

  return "mp4";
}

export function buildMediaFilename(item: MediaItem): string {
  const ext = extensionFromUrl(item.url) ?? defaultExtension(item.kind);
  const tweetId = sanitizePathPart(item.tweetId);
  const mediaId = sanitizePathPart(item.id);
  return `${tweetId}_${mediaId}.${ext}`;
}
