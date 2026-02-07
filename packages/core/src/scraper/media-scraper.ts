import { Scraper, SearchMode, type Tweet } from "agent-twitter-client";
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function isUnauthorizedError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("401") || message.includes("unauthorized");
}

function isTimelineNotFoundError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("page does not exist") ||
    message.includes("\"code\":34") ||
    message.includes("code:34") ||
    message.includes("code 34")
  );
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

async function collectFromTimeline(
  scraper: Scraper,
  username: string,
  maxTweets: number
): Promise<MediaItem[]> {
  const mediaItems: MediaItem[] = [];

  for await (const tweet of scraper.getTweets(username, maxTweets)) {
    mediaItems.push(...fromTweetPhotos(tweet, username));
    mediaItems.push(...fromTweetVideos(tweet, username));
  }

  return mediaItems;
}

async function collectFromTimelineByUserId(
  scraper: Scraper,
  username: string,
  maxTweets: number
): Promise<MediaItem[]> {
  const mediaItems: MediaItem[] = [];
  const userId = await scraper.getUserIdByScreenName(username);

  for await (const tweet of scraper.getTweetsByUserId(userId, maxTweets)) {
    mediaItems.push(...fromTweetPhotos(tweet, username));
    mediaItems.push(...fromTweetVideos(tweet, username));
  }

  return mediaItems;
}

async function collectFromSearch(
  scraper: Scraper,
  username: string,
  maxTweets: number
): Promise<MediaItem[]> {
  const mediaItems: MediaItem[] = [];
  const query = `from:${username} filter:media`;

  for await (const tweet of scraper.searchTweets(query, maxTweets, SearchMode.Latest)) {
    mediaItems.push(...fromTweetPhotos(tweet, username));
    mediaItems.push(...fromTweetVideos(tweet, username));
  }

  return mediaItems;
}

export class AgentTwitterMediaScraper implements MediaScraper {
  private authenticatedScraper = new Scraper();
  private guestScraper = new Scraper();
  private initialized = false;

  async initialize(session: SessionData): Promise<void> {
    if (!session.valid || session.cookies.length === 0) {
      throw new Error("Session cookies are empty or invalid.");
    }

    const normalizedCookies = normalizeCookiesForTwitterRequests(session.cookies);
    await this.authenticatedScraper.setCookies(normalizedCookies);
    this.initialized = true;
  }

  async fetchUserMedia(input: FetchUserMediaInput): Promise<MediaItem[]> {
    if (!this.initialized) {
      throw new Error("Scraper not initialized.");
    }

    const username = normalizeUsername(input.username);
    const maxTweets = input.maxTweets ?? 200;
    const allowedKinds = new Set(input.mediaKinds);

    let mediaItems: MediaItem[] = [];

    try {
      mediaItems = await collectFromTimeline(this.authenticatedScraper, username, maxTweets);
    } catch (authTimelineError) {
      const canFallback =
        isUnauthorizedError(authTimelineError) || isTimelineNotFoundError(authTimelineError);
      if (!canFallback) {
        throw authTimelineError;
      }

      try {
        mediaItems = await collectFromTimelineByUserId(
          this.authenticatedScraper,
          username,
          maxTweets
        );
      } catch (authUserIdError) {
        const canFallbackToGuest =
          isUnauthorizedError(authUserIdError) || isTimelineNotFoundError(authUserIdError);
        if (!canFallbackToGuest) {
          throw authUserIdError;
        }

        try {
          mediaItems = await collectFromTimeline(this.guestScraper, username, maxTweets);
        } catch (guestTimelineError) {
          const canFallbackToGuestUserId =
            isUnauthorizedError(guestTimelineError) || isTimelineNotFoundError(guestTimelineError);
          if (!canFallbackToGuestUserId) {
            throw guestTimelineError;
          }

          try {
            mediaItems = await collectFromTimelineByUserId(this.guestScraper, username, maxTweets);
          } catch (guestUserIdError) {
            const canFallbackToSearch =
              isUnauthorizedError(guestUserIdError) || isTimelineNotFoundError(guestUserIdError);
            if (!canFallbackToSearch) {
              throw guestUserIdError;
            }

            try {
              mediaItems = await collectFromSearch(this.guestScraper, username, maxTweets);
            } catch (searchError) {
              throw new Error(
                `auth timeline failed: ${errorMessage(authTimelineError)}; auth userId failed: ${errorMessage(authUserIdError)}; guest timeline failed: ${errorMessage(guestTimelineError)}; guest userId failed: ${errorMessage(guestUserIdError)}; search fallback failed: ${errorMessage(searchError)}`
              );
            }
          }
        }
      }
    }

    return dedupeMedia(mediaItems).filter((item) => allowedKinds.has(item.kind));
  }
}

export function createMediaScraper(): MediaScraper {
  return new AgentTwitterMediaScraper();
}
