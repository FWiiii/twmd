import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { MediaItem, MediaKind, ScraperEngine, SessionData } from "@twmd/shared";
import { normalizeCookiesForTwitterRequests } from "../auth/session-store.js";
import { GraphqlMediaScraper } from "./graphql-media-scraper.js";

export interface FetchUserMediaInput {
  username: string;
  maxTweets?: number;
  mediaKinds: MediaKind[];
}

export interface MediaScraper {
  initialize(session: SessionData): Promise<void>;
  fetchUserMedia(input: FetchUserMediaInput): Promise<MediaItem[]>;
  close?(): Promise<void>;
}

export interface CreateMediaScraperInput {
  engine?: ScraperEngine;
}

interface DomMediaCandidate {
  id: string;
  tweetId: string;
  username: string;
  kind: "image" | "video" | "gif";
  url: string;
  createdAt?: string;
}

function normalizeUsername(input: string): string {
  return input.replace(/^@/, "").trim().toLowerCase();
}

function detectVideoKind(url: string): "video" | "gif" {
  if (url.includes("/tweet_video/") || url.endsWith(".gif")) {
    return "gif";
  }

  return "video";
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

async function extractMediaFromPage(
  page: Page,
  maxTweets: number,
  targetUsername: string
): Promise<DomMediaCandidate[]> {
  const extracted = await page.evaluate(
    ({ limit, target }) => {
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
      const targetUser = target.toLowerCase();

      const parseStatusHref = (href: string): { username: string; tweetId: string } | null => {
        const match = href.match(/\/([^/]+)\/status\/(\d+)/);
        if (!match) {
          return null;
        }

        return {
          username: match[1].replace(/^@/, "").toLowerCase(),
          tweetId: match[2]
        };
      };

      const normalizeImageUrl = (raw: string): string => {
        try {
          const parsed = new URL(raw, window.location.origin);

          if (!parsed.hostname.includes("pbs.twimg.com")) {
            return raw;
          }

          if (!parsed.pathname.includes("/media/")) {
            return raw;
          }

          parsed.searchParams.set("name", "orig");
          return parsed.toString();
        } catch {
          return raw;
        }
      };

      for (const article of articles) {
        const socialContextText =
          article.querySelector('div[data-testid="socialContext"]')?.textContent?.toLowerCase() ?? "";
        if (
          socialContextText.includes("retweeted") ||
          socialContextText.includes("reposted") ||
          socialContextText.includes("转推")
        ) {
          continue;
        }

        const statusHrefs = Array.from(article.querySelectorAll('a[href*="/status/"]'))
          .map((anchor) => anchor.getAttribute("href") ?? "")
          .filter(Boolean);

        const statusMatches = statusHrefs
          .map((href) => parseStatusHref(href))
          .filter((item): item is { username: string; tweetId: string } => item !== null);

        if (statusMatches.length === 0) {
          continue;
        }

        const primary = statusMatches[0];
        if (primary.username !== targetUser) {
          continue;
        }

        const hasForeignStatus = statusMatches.some((item) => item.username !== targetUser);
        if (hasForeignStatus) {
          continue;
        }

        const username = primary.username;
        const tweetId = primary.tweetId;
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
          const closestStatusLink = imageElement.closest('a[href*="/status/"]');
          if (closestStatusLink) {
            const closestMatch = parseStatusHref(closestStatusLink.getAttribute("href") ?? "");
            if (closestMatch && closestMatch.username !== targetUser) {
              continue;
            }
          }

          const src = imageElement.getAttribute("src") ?? "";
          if (!src) {
            continue;
          }

          if (!src.includes("pbs.twimg.com/media/")) {
            continue;
          }

          const normalizedSrc = normalizeImageUrl(src);

          candidates.push({
            id: `${tweetId}_img_${imageIndex}`,
            tweetId,
            username,
            kind: "image",
            url: normalizedSrc,
            createdAt
          });
          imageIndex += 1;
        }

        const videoElements = Array.from(article.querySelectorAll('video[src], video source[src]'));
        let videoIndex = 0;
        for (const videoElement of videoElements) {
          const closestStatusLink = videoElement.closest('a[href*="/status/"]');
          if (closestStatusLink) {
            const closestMatch = parseStatusHref(closestStatusLink.getAttribute("href") ?? "");
            if (closestMatch && closestMatch.username !== targetUser) {
              continue;
            }
          }

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
    },
    { limit: maxTweets, target: normalizeUsername(targetUsername) }
  );

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

  private async collectFromUrl(
    url: string,
    maxTweets: number,
    username: string
  ): Promise<DomMediaCandidate[]> {
    if (!this.page) {
      throw new Error("Playwright page is not initialized.");
    }

    await this.page.goto(url, { waitUntil: "domcontentloaded" });
    await this.page.waitForTimeout(1500);

    const collected = new Map<string, DomMediaCandidate>();
    let unchangedRounds = 0;

    for (let round = 0; round < 14; round += 1) {
      const before = collected.size;
      const batch = await extractMediaFromPage(this.page, maxTweets, username);

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

    const query = encodeURIComponent(`from:${username} filter:media -filter:retweets`);
    const urls = [
      `https://x.com/${username}/media`,
      `https://twitter.com/${username}/media`,
      `https://x.com/search?q=${query}&src=typed_query&f=live`,
      `https://twitter.com/search?q=${query}&src=typed_query&f=live`
    ];

    const errors: string[] = [];
    for (const url of urls) {
      try {
        const candidates = await this.collectFromUrl(url, maxTweets, username);
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
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${url} -> ${message}`);
      }
    }

    const detail = errors.length > 0 ? ` Tried: ${errors.join(" | ")}` : "";
    throw new Error(`Playwright scraper failed to fetch media for @${username}.${detail}`);
  }

  private async dispose(): Promise<void> {
    try {
      await this.page?.close();
      await this.context?.close();
      await this.browser?.close();
      this.page = null;
      this.context = null;
      this.browser = null;
      this.initialized = false;
    } catch {
    }
  }

  async close(): Promise<void> {
    await this.dispose();
  }
}

export function createMediaScraper(input: CreateMediaScraperInput = {}): MediaScraper {
  const engine = input.engine ?? "graphql";

  if (engine === "graphql") {
    return new GraphqlMediaScraper();
  }

  return new PlaywrightMediaScraper();
}
