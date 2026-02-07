import { Scraper, SearchMode, type Tweet } from "agent-twitter-client";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { MediaItem, MediaKind, ScraperEngine, SessionData } from "@twmd/shared";
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

class AgentTwitterMediaScraper implements MediaScraper {
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

interface DomMediaCandidate {
  id: string;
  tweetId: string;
  username: string;
  kind: "image" | "video" | "gif";
  url: string;
  createdAt?: string;
}

function parseCookieString(cookie: string): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
}> {
  const segments = cookie
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return [];
  }

  const first = segments[0];
  const divider = first.indexOf("=");
  if (divider <= 0) {
    return [];
  }

  const name = first.slice(0, divider).trim();
  const value = first.slice(divider + 1).trim();
  if (!name || !value) {
    return [];
  }

  const attributes = new Map<string, string>();
  for (const segment of segments.slice(1)) {
    const index = segment.indexOf("=");
    if (index < 0) {
      attributes.set(segment.toLowerCase(), "true");
      continue;
    }

    attributes.set(segment.slice(0, index).trim().toLowerCase(), segment.slice(index + 1).trim());
  }

  const rawDomain = attributes.get("domain") ?? ".x.com";
  const normalizedDomain = rawDomain.replace(/^\./, "").toLowerCase();

  const domains = new Set<string>();
  if (normalizedDomain.endsWith("twitter.com") || normalizedDomain.endsWith("x.com")) {
    domains.add(".x.com");
    domains.add(".twitter.com");
  } else {
    domains.add(rawDomain.startsWith(".") ? rawDomain : `.${rawDomain}`);
  }

  const path = attributes.get("path") ?? "/";
  const secure = attributes.has("secure");
  const httpOnly = attributes.has("httponly");

  return Array.from(domains).map((domain) => ({
    name,
    value,
    domain,
    path,
    secure,
    httpOnly
  }));
}

async function extractMediaFromPage(page: Page, maxTweets: number): Promise<DomMediaCandidate[]> {
  const extracted = await page.evaluate((limit) => {
    const articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    const candidates: Array<{
      id: string;
      tweetId: string;
      username: string;
      kind: "image" | "video" | "gif";
      url: string;
      createdAt?: string;
    }> = [];

    const seenTweetIds = new Set<string>();

    for (const article of articles) {
      const statusLink = article.querySelector('a[href*="/status/"]');
      const href = statusLink?.getAttribute("href") ?? "";
      const match = href.match(/\/([^/]+)\/status\/(\d+)/);
      if (!match) {
        continue;
      }

      const username = match[1];
      const tweetId = match[2];
      if (!seenTweetIds.has(tweetId)) {
        seenTweetIds.add(tweetId);
      }

      if (seenTweetIds.size > limit) {
        continue;
      }

      const createdAt = article.querySelector("time")?.getAttribute("datetime") ?? undefined;

      const imageElements = Array.from(article.querySelectorAll('img[src]'));
      let imageIndex = 0;
      for (const imageElement of imageElements) {
        const src = imageElement.getAttribute("src") ?? "";
        if (!src) {
          continue;
        }

        if (!src.includes("pbs.twimg.com/media/") && !src.includes("pbs.twimg.com/ext_tw_video_thumb/")) {
          continue;
        }

        candidates.push({
          id: `${tweetId}_img_${imageIndex}`,
          tweetId,
          username,
          kind: "image",
          url: src,
          createdAt
        });
        imageIndex += 1;
      }

      const videoElements = Array.from(article.querySelectorAll('video[src], video source[src]'));
      let videoIndex = 0;
      for (const videoElement of videoElements) {
        const src = videoElement.getAttribute("src") ?? "";
        if (!src) {
          continue;
        }

        if (!src.includes("video.twimg.com") && !src.endsWith(".mp4") && !src.endsWith(".m3u8")) {
          continue;
        }

        const kind: "video" | "gif" =
          src.includes("/tweet_video/") || src.endsWith(".gif") ? "gif" : "video";

        candidates.push({
          id: `${tweetId}_video_${videoIndex}`,
          tweetId,
          username,
          kind,
          url: src,
          createdAt
        });
        videoIndex += 1;
      }
    }

    return candidates;
  }, maxTweets);

  return extracted;
}

class PlaywrightMediaScraper implements MediaScraper {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private initialized = false;

  async initialize(session: SessionData): Promise<void> {
    this.browser = await chromium.launch({ headless: true });
    this.context = await this.browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
    });

    if (session.cookies.length > 0) {
      const cookieList = normalizeCookiesForTwitterRequests(session.cookies).flatMap((cookie) =>
        parseCookieString(cookie)
      );

      if (cookieList.length > 0) {
        await this.context.addCookies(cookieList);
      }
    }

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(30_000);
    this.initialized = true;

    process.once("exit", () => {
      void this.dispose();
    });
  }

  private async collectFromUrl(url: string, maxTweets: number): Promise<DomMediaCandidate[]> {
    if (!this.page) {
      throw new Error("Playwright page is not initialized.");
    }

    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    await this.page.waitForTimeout(1500);

    const collected = new Map<string, DomMediaCandidate>();
    let unchangedRounds = 0;

    for (let round = 0; round < 14; round += 1) {
      const before = collected.size;
      const batch = await extractMediaFromPage(this.page, maxTweets);

      for (const item of batch) {
        const key = `${item.tweetId}:${item.kind}:${item.url}`;
        collected.set(key, item);
      }

      if (collected.size === before) {
        unchangedRounds += 1;
      } else {
        unchangedRounds = 0;
      }

      if (unchangedRounds >= 3) {
        break;
      }

      await this.page.evaluate(() => {
        window.scrollBy(0, window.innerHeight * 2.5);
      });
      await this.page.waitForTimeout(900);
    }

    return Array.from(collected.values());
  }

  async fetchUserMedia(input: FetchUserMediaInput): Promise<MediaItem[]> {
    if (!this.initialized) {
      throw new Error("Playwright scraper not initialized.");
    }

    const username = normalizeUsername(input.username);
    const maxTweets = input.maxTweets ?? 200;
    const allowedKinds = new Set(input.mediaKinds);

    const query = encodeURIComponent(`from:${username} filter:media`);
    const urls = [
      `https://x.com/${username}/media`,
      `https://twitter.com/${username}/media`,
      `https://x.com/search?q=${query}&src=typed_query&f=live`,
      `https://twitter.com/search?q=${query}&src=typed_query&f=live`
    ];

    const errors: string[] = [];
    for (const url of urls) {
      try {
        const candidates = await this.collectFromUrl(url, maxTweets);
        if (candidates.length === 0) {
          continue;
        }

        const mediaItems: MediaItem[] = candidates.map((candidate) => ({
          id: candidate.id,
          tweetId: candidate.tweetId,
          username: candidate.username || username,
          kind: candidate.kind,
          url: candidate.url,
          createdAt: candidate.createdAt,
          filenameHint: candidate.id
        }));

        return dedupeMedia(mediaItems).filter((item) => allowedKinds.has(item.kind));
      } catch (error) {
        errors.push(`${url} -> ${errorMessage(error)}`);
      }
    }

    const detail = errors.length > 0 ? ` Tried: ${errors.join(" | ")}` : "";
    throw new Error(`Playwright engine failed to fetch media for @${username}.${detail}`);
  }

  private async dispose(): Promise<void> {
    try {
      await this.page?.close();
      await this.context?.close();
      await this.browser?.close();
    } catch {
    }
  }
}

export function createMediaScraper(engine: ScraperEngine = "agent"): MediaScraper {
  if (engine === "playwright") {
    return new PlaywrightMediaScraper();
  }

  return new AgentTwitterMediaScraper();
}
