import { Scraper, type Tweet } from "agent-twitter-client";
import type { MediaItem, MediaKind, SessionData } from "@twmd/shared";
import { normalizeCookiesForTwitterRequests } from "../auth/session-store.js";

export interface FetchUserMediaInput {
  username: string;
  maxTweets?: number;
  mediaKinds: MediaKind[];
}

export interface MediaScraper {
  initialize(session: SessionData): Promise<void>;
  fetchUserMedia(input: FetchUserMediaInput): Promise<MediaItem[]>;
}

function normalizeUsername(input: string): string {
  return input.replace(/^@/, "").trim();
}

function detectVideoKind(url: string): MediaKind {
  if (url.includes("/tweet_video/") || url.endsWith(".gif")) {
    return "gif";
  }

  return "video";
}

function toCreatedAt(tweet: Tweet): string | undefined {
  if (tweet.timeParsed) {
    return tweet.timeParsed.toISOString();
  }

  if (tweet.timestamp) {
    return new Date(tweet.timestamp * 1000).toISOString();
  }

  return undefined;
}

function fromTweetPhotos(tweet: Tweet, fallbackUsername: string): MediaItem[] {
  const tweetId = tweet.id;
  if (!tweetId || tweet.photos.length === 0) {
    return [];
  }

  const username = tweet.username ?? fallbackUsername;
  const createdAt = toCreatedAt(tweet);

  return tweet.photos.map((photo, index) => ({
    id: photo.id || `${tweetId}_photo_${index}`,
    tweetId,
    username,
    kind: "image",
    url: photo.url,
    createdAt,
    filenameHint: `${tweetId}_photo_${index}`
  }));
}

function fromTweetVideos(tweet: Tweet, fallbackUsername: string): MediaItem[] {
  const tweetId = tweet.id;
  if (!tweetId || tweet.videos.length === 0) {
    return [];
  }

  const username = tweet.username ?? fallbackUsername;
  const createdAt = toCreatedAt(tweet);

  return tweet.videos
    .map((video, index): MediaItem | null => {
      const mediaUrl = video.url;
      if (!mediaUrl) {
        return null;
      }

      const kind = detectVideoKind(mediaUrl);
      return {
        id: video.id || `${tweetId}_video_${index}`,
        tweetId,
        username,
        kind,
        url: mediaUrl,
        createdAt,
        filenameHint: `${tweetId}_video_${index}`
      };
    })
    .filter((item): item is MediaItem => item !== null);
}

function dedupeMedia(items: MediaItem[]): MediaItem[] {
  const seen = new Set<string>();
  const deduped: MediaItem[] = [];

  for (const item of items) {
    const key = `${item.tweetId}:${item.kind}:${item.url}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(item);
  }

  return deduped;
}

function isUnauthorizedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.message.includes("401") || error.message.toLowerCase().includes("unauthorized");
}

function createXHostScraper(): Scraper {
  return new Scraper({
    transform: {
      request: (input, init) => {
        let url: URL;

        if (input instanceof URL) {
          url = new URL(input.toString());
        } else {
          url = new URL(String(input));
        }

        if (url.hostname === "twitter.com") {
          url.hostname = "x.com";
        }

        if (url.hostname === "api.twitter.com") {
          url.hostname = "api.x.com";
        }

        return [url, init];
      }
    }
  });
}

async function collectMediaFromScraper(
  scraper: Scraper,
  input: FetchUserMediaInput
): Promise<MediaItem[]> {
  const username = normalizeUsername(input.username);
  const maxTweets = input.maxTweets ?? 200;
  const allowedKinds = new Set(input.mediaKinds);

  const mediaItems: MediaItem[] = [];
  for await (const tweet of scraper.getTweets(username, maxTweets)) {
    mediaItems.push(...fromTweetPhotos(tweet, username));
    mediaItems.push(...fromTweetVideos(tweet, username));
  }

  return dedupeMedia(mediaItems).filter((item) => allowedKinds.has(item.kind));
}

export class AgentTwitterMediaScraper implements MediaScraper {
  private primaryScraper = new Scraper();
  private xHostScraper = createXHostScraper();
  private initialized = false;

  async initialize(session: SessionData): Promise<void> {
    if (!session.valid || session.cookies.length === 0) {
      throw new Error("Session cookies are empty or invalid.");
    }

    const normalizedCookies = normalizeCookiesForTwitterRequests(session.cookies);
    await this.primaryScraper.setCookies(normalizedCookies);
    await this.xHostScraper.setCookies(normalizedCookies);
    this.initialized = true;
  }

  async fetchUserMedia(input: FetchUserMediaInput): Promise<MediaItem[]> {
    if (!this.initialized) {
      throw new Error("Scraper not initialized.");
    }

    try {
      return await collectMediaFromScraper(this.primaryScraper, input);
    } catch (error) {
      if (!isUnauthorizedError(error)) {
        throw error;
      }

      return collectMediaFromScraper(this.xHostScraper, input);
    }
  }
}

export function createMediaScraper(): MediaScraper {
  return new AgentTwitterMediaScraper();
}
