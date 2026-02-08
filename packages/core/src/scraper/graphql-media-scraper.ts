import type { MediaItem, MediaKind, SessionData } from "@huangjz11/shared";
import type { FetchUserMediaInput, MediaScraper } from "./media-scraper.js";

interface GraphqlAuthCandidate {
  authToken: string;
  ct0: string;
  guestToken?: string;
}

interface GraphqlAuthBundle {
  cookieHeaderBase: string;
  authCandidates: GraphqlAuthCandidate[];
}

interface CookieRecord {
  name: string;
  value: string;
  domain?: string;
}

interface CookieValueMap {
  [name: string]: string;
}

interface GraphqlOperation {
  name: "UserByScreenName" | "UserMedia" | "UserTweets";
  queryId: string;
}

interface GraphqlUserByScreenNameResponse {
  data?: {
    user?: {
      result?: {
        rest_id?: string;
        legacy?: {
          screen_name?: string;
        };
      };
    };
  };
  errors?: Array<{ message?: string }>;
}

interface GraphqlMediaItem {
  media_key?: string;
  id_str?: string;
  type?: "photo" | "video" | "animated_gif" | string;
  media_url_https?: string;
  media_url?: string;
  video_info?: {
    variants?: Array<{
      bitrate?: number;
      content_type?: string;
      url?: string;
    }>;
  };
}

interface GraphqlLegacyTweet {
  id_str?: string;
  created_at?: string;
  user_id_str?: string;
  entities?: {
    media?: GraphqlMediaItem[];
  };
  extended_entities?: {
    media?: GraphqlMediaItem[];
  };
  retweeted_status_result?: unknown;
}

interface GraphqlTimelineEntry {
  entryId?: string;
  sortIndex?: string;
  content?: unknown;
}

interface GraphqlUserMediaResponse {
  data?: {
    user?: {
      result?: {
        rest_id?: string;
        timeline_v2?: {
          timeline?: {
            instructions?: Array<{
              type?: string;
              entries?: GraphqlTimelineEntry[];
            }>;
          };
        };
      };
    };
  };
  errors?: Array<{ message?: string }>;
}

interface V11Status {
  id_str?: string;
  created_at?: string;
  user?: {
    screen_name?: string;
  };
  retweeted_status?: unknown;
  entities?: {
    media?: GraphqlMediaItem[];
  };
  extended_entities?: {
    media?: GraphqlMediaItem[];
  };
}

const API_V11_BASES = [
  "https://api.x.com/1.1/",
  "https://api.twitter.com/1.1/",
  "https://x.com/i/api/1.1/",
  "https://twitter.com/i/api/1.1/"
];

const GRAPHQL_BASES = ["https://x.com/i/api/graphql/", "https://twitter.com/i/api/graphql/"];

const WEB_BEARER_TOKEN =
  process.env.TWMD_WEB_BEARER_TOKEN ??
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

const DEFAULT_GRAPHQL_OPERATIONS: GraphqlOperation[] = [
  { name: "UserByScreenName", queryId: "G3KGOASz96M-Qu0nwmGXNg" },
  { name: "UserMedia", queryId: "YqiE3JL6K6dcjVxRk0h4RA" },
  { name: "UserTweets", queryId: "HuTx74BxAnezK1gWvYY7zg" }
];

function normalizeUsername(input: string): string {
  return input.replace(/^@/, "").trim().toLowerCase();
}

function normalizeImageUrl(raw: string): string {
  if (!raw) {
    return raw;
  }

  try {
    const parsed = new URL(raw);
    if (!parsed.hostname.includes("pbs.twimg.com") || !parsed.pathname.includes("/media/")) {
      return raw;
    }

    parsed.searchParams.set("name", "orig");
    return parsed.toString();
  } catch {
    return raw;
  }
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

function parseCookieFirstPair(cookie: string): { name: string; value: string } | null {
  const first = cookie.split(";")[0]?.trim();
  if (!first) {
    return null;
  }

  const index = first.indexOf("=");
  if (index <= 0) {
    return null;
  }

  const name = first.slice(0, index).trim();
  const value = first.slice(index + 1).trim();
  if (!name || !value) {
    return null;
  }

  return { name, value };
}

function parseCookieRecord(cookie: string): CookieRecord | null {
  const segments = cookie
    .split(";")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length === 0) {
    return null;
  }

  const first = segments[0];
  const index = first.indexOf("=");
  if (index <= 0) {
    return null;
  }

  const name = first.slice(0, index).trim();
  const value = first.slice(index + 1).trim();
  if (!name || !value) {
    return null;
  }

  let domain: string | undefined;
  for (const segment of segments.slice(1)) {
    const divider = segment.indexOf("=");
    if (divider <= 0) {
      continue;
    }

    const key = segment.slice(0, divider).trim().toLowerCase();
    const val = segment.slice(divider + 1).trim();
    if (key === "domain" && val) {
      domain = val;
    }
  }

  return {
    name,
    value,
    domain
  };
}

function parseSessionCookies(cookies: string[]): CookieValueMap {
  const map: CookieValueMap = {};

  for (const cookie of cookies) {
    const parsed = parseCookieFirstPair(cookie);
    if (!parsed) {
      continue;
    }

    map[parsed.name] = parsed.value;
  }

  return map;
}

function buildGraphqlAuthBundle(session: SessionData): GraphqlAuthBundle {
  const records = session.cookies
    .map((cookie) => parseCookieRecord(cookie))
    .filter((record): record is CookieRecord => Boolean(record));

  const cookieMap = parseSessionCookies(session.cookies);
  const guestTokenRaw = cookieMap.gt ?? cookieMap.guest_id;
  const guestToken = guestTokenRaw?.replace(/^v1%3A/i, "").replace(/^v1:/i, "");

  const authByDomain = new Map<string, string[]>();
  const ct0ByDomain = new Map<string, string[]>();

  for (const record of records) {
    const domainKey = (record.domain ?? "").replace(/^\./, "").toLowerCase() || "*";

    if (record.name === "auth_token") {
      const list = authByDomain.get(domainKey) ?? [];
      list.push(record.value);
      authByDomain.set(domainKey, list);
    }

    if (record.name === "ct0") {
      const list = ct0ByDomain.get(domainKey) ?? [];
      list.push(record.value);
      ct0ByDomain.set(domainKey, list);
    }
  }

  const candidateDomains = new Set<string>([
    ...Array.from(authByDomain.keys()),
    ...Array.from(ct0ByDomain.keys()),
    "*"
  ]);

  const allAuthTokens = Array.from(
    new Set([
      ...Array.from(authByDomain.values()).flat(),
      cookieMap.auth_token
    ].filter((value): value is string => Boolean(value)))
  );

  const allCt0Tokens = Array.from(
    new Set([
      ...Array.from(ct0ByDomain.values()).flat(),
      cookieMap.ct0
    ].filter((value): value is string => Boolean(value)))
  );

  const authCandidates: GraphqlAuthCandidate[] = [];

  // Prefer domain-aligned pairs first.
  for (const domain of candidateDomains) {
    const auths = authByDomain.get(domain) ?? authByDomain.get("*") ?? [];
    const ct0s = ct0ByDomain.get(domain) ?? ct0ByDomain.get("*") ?? [];

    for (const authToken of auths) {
      for (const ct0 of ct0s) {
        if (!authToken || !ct0) {
          continue;
        }

        authCandidates.push({
          authToken,
          ct0,
          guestToken
        });
      }
    }
  }

  // Add global cross-domain pairs as fallback to avoid missing valid pairs
  // when auth_token and ct0 are attached to different domains.
  for (const authToken of allAuthTokens) {
    for (const ct0 of allCt0Tokens) {
      authCandidates.push({
        authToken,
        ct0,
        guestToken
      });
    }
  }

  if (authCandidates.length === 0) {
    const authToken = cookieMap.auth_token;
    const ct0 = cookieMap.ct0;
    if (!authToken || !ct0) {
      throw new Error("graphql requires login cookies: auth_token and ct0.");
    }

    authCandidates.push({
      authToken,
      ct0,
      guestToken
    });
  }

  const unique = Array.from(
    new Map(authCandidates.map((candidate) => [`${candidate.authToken}|${candidate.ct0}`, candidate])).values()
  );

  const cookieHeaderBase = Object.entries(cookieMap)
    .filter(([name, value]) => Boolean(name) && Boolean(value) && name !== "auth_token" && name !== "ct0")
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");

  return {
    cookieHeaderBase,
    authCandidates: unique
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractErrorDetail(payload: unknown): string {
  if (!payload || typeof payload !== "object") {
    return "Unknown API error.";
  }

  const record = payload as {
    errors?: Array<{ message?: string; code?: number }>;
    error?: string;
  };

  if (Array.isArray(record.errors) && record.errors.length > 0) {
    return record.errors
      .map((item) => {
        const msg = item.message ?? "Unknown error";
        return item.code !== undefined ? `${msg} (code=${item.code})` : msg;
      })
      .join("; ");
  }

  if (record.error) {
    return record.error;
  }

  return "Unknown API error.";
}

function pickBestVideoVariant(media: GraphqlMediaItem): string | null {
  const variants = media.video_info?.variants ?? [];
  const valid = variants.filter((variant) => typeof variant.url === "string" && variant.url.length > 0);
  if (valid.length === 0) {
    return null;
  }

  const mp4 = valid.filter((variant) => {
    if (variant.content_type?.includes("mp4")) {
      return true;
    }

    return String(variant.url).includes(".mp4");
  });

  const selected = (mp4.length > 0 ? mp4 : valid).sort((a, b) => (b.bitrate ?? -1) - (a.bitrate ?? -1));
  return selected[0]?.url ?? null;
}

function mapMediaKind(media: GraphqlMediaItem, resolvedUrl: string): MediaKind | null {
  if (media.type === "photo") {
    return "image";
  }

  if (media.type === "animated_gif") {
    return "gif";
  }

  if (media.type === "video") {
    return resolvedUrl.includes("/tweet_video/") ? "gif" : "video";
  }

  return null;
}

function extractBearerFromScript(scriptText: string): string[] {
  const tokens = new Set<string>();

  const normalizedScript = scriptText
    .replace(/\\u002F/gi, "/")
    .replace(/\\u003D/gi, "=")
    .replace(/\\x2f/gi, "/")
    .replace(/\\x3d/gi, "=");

  const directBearerMatches =
    normalizedScript.match(/Bearer\s+([A-Za-z0-9%_\-./+=]{20,})/g) ?? [];
  for (const item of directBearerMatches) {
    tokens.add(item.replace(/^Bearer\s+/, "").trim());
  }

  const quotedBearerMatches =
    normalizedScript.match(/(?:BEARER_TOKEN|bearerToken)\"?\s*[:=]\s*\"([A-Za-z0-9%_\-./+=]{20,})\"/g) ?? [];
  for (const item of quotedBearerMatches) {
    const match = item.match(/\"([A-Za-z0-9%_\-./+=]{20,})\"/);
    if (match?.[1]) {
      tokens.add(match[1]);
    }
  }

  const matches = normalizedScript.match(/AAAAAAAAAAAAAAAAAAAAA[A-Za-z0-9%_\-./+=]{20,}/g) ?? [];
  for (const item of matches) {
    tokens.add(item.trim());
  }

  return Array.from(tokens).filter(Boolean);
}

function extractMainJsUrls(html: string): string[] {
  const urls = new Set<string>();
  const patterns = [
    /https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[^"']+\.js/g,
    /https:\/\/abs\.twimg\.com\/responsive-web\/client-web-legacy\/main\.[^"']+\.js/g,
    /https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"']+\.js/g
  ];

  for (const pattern of patterns) {
    const matched = html.match(pattern) ?? [];
    for (const item of matched) {
      urls.add(item);
    }
  }

  return Array.from(urls);
}

function extractGraphqlOperations(scriptText: string): GraphqlOperation[] {
  const operations: GraphqlOperation[] = [];
  const userByScreenNameRegex = /([A-Za-z0-9_-]{10,})\/UserByScreenName/g;
  const userMediaRegex = /([A-Za-z0-9_-]{10,})\/UserMedia/g;
  const userTweetsRegex = /([A-Za-z0-9_-]{10,})\/UserTweets/g;

  const objectPatterns: Array<{ name: GraphqlOperation["name"]; regex: RegExp }> = [
    {
      name: "UserByScreenName",
      regex: /(?:operationName|"operationName")\s*[:=]\s*"UserByScreenName"\s*,\s*(?:queryId|"queryId")\s*[:=]\s*"([A-Za-z0-9_-]{10,})"/g
    },
    {
      name: "UserByScreenName",
      regex: /(?:queryId|"queryId")\s*[:=]\s*"([A-Za-z0-9_-]{10,})"\s*,\s*(?:operationName|"operationName")\s*[:=]\s*"UserByScreenName"/g
    },
    {
      name: "UserMedia",
      regex: /(?:operationName|"operationName")\s*[:=]\s*"UserMedia"\s*,\s*(?:queryId|"queryId")\s*[:=]\s*"([A-Za-z0-9_-]{10,})"/g
    },
    {
      name: "UserMedia",
      regex: /(?:queryId|"queryId")\s*[:=]\s*"([A-Za-z0-9_-]{10,})"\s*,\s*(?:operationName|"operationName")\s*[:=]\s*"UserMedia"/g
    },
    {
      name: "UserTweets",
      regex: /(?:operationName|"operationName")\s*[:=]\s*"UserTweets"\s*,\s*(?:queryId|"queryId")\s*[:=]\s*"([A-Za-z0-9_-]{10,})"/g
    },
    {
      name: "UserTweets",
      regex: /(?:queryId|"queryId")\s*[:=]\s*"([A-Za-z0-9_-]{10,})"\s*,\s*(?:operationName|"operationName")\s*[:=]\s*"UserTweets"/g
    }
  ];

  const foundUserByScreenName = new Set<string>();
  const foundUserMedia = new Set<string>();
  const foundUserTweets = new Set<string>();

  let match: RegExpExecArray | null;
  while ((match = userByScreenNameRegex.exec(scriptText)) !== null) {
    foundUserByScreenName.add(match[1]);
  }
  while ((match = userMediaRegex.exec(scriptText)) !== null) {
    foundUserMedia.add(match[1]);
  }
  while ((match = userTweetsRegex.exec(scriptText)) !== null) {
    foundUserTweets.add(match[1]);
  }

  for (const { name, regex } of objectPatterns) {
    while ((match = regex.exec(scriptText)) !== null) {
      const queryId = match[1];
      if (!queryId) {
        continue;
      }

      if (name === "UserByScreenName") {
        foundUserByScreenName.add(queryId);
      } else if (name === "UserMedia") {
        foundUserMedia.add(queryId);
      } else {
        foundUserTweets.add(queryId);
      }
    }
  }

  for (const queryId of foundUserByScreenName) {
    operations.push({ name: "UserByScreenName", queryId });
  }
  for (const queryId of foundUserMedia) {
    operations.push({ name: "UserMedia", queryId });
  }
  for (const queryId of foundUserTweets) {
    operations.push({ name: "UserTweets", queryId });
  }

  return operations;
}

function normalizeBearerCandidates(tokens: string[]): string[] {
  const candidates = new Set<string>();

  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) {
      continue;
    }

    candidates.add(trimmed);
    try {
      const decoded = decodeURIComponent(trimmed);
      if (decoded) {
        candidates.add(decoded);
      }
    } catch {
    }
  }

  return Array.from(candidates).filter(Boolean);
}

function isBearerAuthFailure(status: number, detail: string): boolean {
  if (status !== 401) {
    return false;
  }

  return detail.includes("code=32") || detail.toLowerCase().includes("authenticate");
}

function isLikelyQueryIdNotFound(status: number, detail: string): boolean {
  if (status !== 404) {
    return false;
  }

  const lowered = detail.toLowerCase();
  return lowered.includes("unknown") || lowered.includes("not found") || lowered.includes("page does not exist");
}

function extractMissingGraphqlFeatures(detail: string): string[] {
  const found = new Set<string>();
  const matches = detail.matchAll(/features cannot be null:\s*([^|]+)/gi);

  for (const match of matches) {
    const segment = match[1] ?? "";
    const tokens = segment.split(",");
    for (const token of tokens) {
      const cleaned = token
        .replace(/\(code=\d+\).*$/i, "")
        .trim()
        .replace(/[^a-zA-Z0-9_]/g, "");

      if (cleaned) {
        found.add(cleaned);
      }
    }
  }

  return Array.from(found);
}

function extractTweetFromTimelineEntry(entry: GraphqlTimelineEntry): GraphqlLegacyTweet | null {
  const content = entry.content as
    | {
        itemContent?: {
          itemType?: string;
          tweet_results?: {
            result?: {
              legacy?: GraphqlLegacyTweet;
            };
          };
        };
      }
    | undefined;

  const item = content?.itemContent;
  if (!item || item.itemType !== "TimelineTweet") {
    return null;
  }

  return item.tweet_results?.result?.legacy ?? null;
}

class GraphqlApiClient {
  private authCandidates: GraphqlAuthCandidate[];
  private authCandidateIndex: number;
  private cookieHeaderBase: string;

  private bearerTokenCandidates: string[];
  private bearerTokenIndex: number;

  private gqlUserByScreenNameIds: string[];
  private gqlUserMediaIds: string[];
  private gqlUserTweetsIds: string[];

  constructor(bundle: GraphqlAuthBundle) {
    this.authCandidates = bundle.authCandidates;
    this.authCandidateIndex = 0;
    this.cookieHeaderBase = bundle.cookieHeaderBase;

    this.bearerTokenCandidates = normalizeBearerCandidates([WEB_BEARER_TOKEN]);
    this.bearerTokenIndex = 0;

    this.gqlUserByScreenNameIds = DEFAULT_GRAPHQL_OPERATIONS
      .filter((operation) => operation.name === "UserByScreenName")
      .map((operation) => operation.queryId);
    this.gqlUserMediaIds = DEFAULT_GRAPHQL_OPERATIONS
      .filter((operation) => operation.name === "UserMedia")
      .map((operation) => operation.queryId);
    this.gqlUserTweetsIds = DEFAULT_GRAPHQL_OPERATIONS
      .filter((operation) => operation.name === "UserTweets")
      .map((operation) => operation.queryId);
  }

  setBundle(bundle: GraphqlAuthBundle): void {
    this.authCandidates = bundle.authCandidates;
    this.authCandidateIndex = 0;
    this.cookieHeaderBase = bundle.cookieHeaderBase;
  }

  private currentAuthCandidate(): GraphqlAuthCandidate {
    return this.authCandidates[this.authCandidateIndex] ?? this.authCandidates[0];
  }

  private rotateAuthCandidate(): boolean {
    if (this.authCandidateIndex + 1 >= this.authCandidates.length) {
      return false;
    }

    this.authCandidateIndex += 1;
    return true;
  }

  private currentBearerToken(): string {
    return (
      this.bearerTokenCandidates[this.bearerTokenIndex] ??
      this.bearerTokenCandidates[0] ??
      WEB_BEARER_TOKEN
    );
  }

  private rotateBearerToken(): boolean {
    if (this.bearerTokenIndex + 1 >= this.bearerTokenCandidates.length) {
      return false;
    }

    this.bearerTokenIndex += 1;
    return true;
  }

  private setBearerTokens(tokens: string[]): void {
    const normalized = normalizeBearerCandidates(tokens);
    if (normalized.length === 0) {
      return;
    }

    this.bearerTokenCandidates = Array.from(new Set(normalized));
    this.bearerTokenIndex = 0;
  }

  private mergeGraphqlOperations(operations: GraphqlOperation[]): void {
    const byName = (name: GraphqlOperation["name"]) =>
      Array.from(new Set(operations.filter((operation) => operation.name === name).map((op) => op.queryId)));

    const userByScreenName = byName("UserByScreenName");
    const userMedia = byName("UserMedia");
    const userTweets = byName("UserTweets");

    if (userByScreenName.length > 0) {
      this.gqlUserByScreenNameIds = userByScreenName;
    }

    if (userMedia.length > 0) {
      this.gqlUserMediaIds = userMedia;
    }

    if (userTweets.length > 0) {
      this.gqlUserTweetsIds = userTweets;
    }
  }

  private buildHeaders(): Record<string, string> {
    const auth = this.currentAuthCandidate();
    const cookieParts = [`auth_token=${auth.authToken}`, `ct0=${auth.ct0}`];
    if (this.cookieHeaderBase) {
      cookieParts.push(this.cookieHeaderBase);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.currentBearerToken()}`,
      "x-csrf-token": auth.ct0,
      "x-twitter-auth-type": "OAuth2Session",
      "x-twitter-active-user": "yes",
      "x-twitter-client-language": "en",
      Accept: "application/json, text/plain, */*",
      Referer: "https://x.com/",
      Origin: "https://x.com",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
      Cookie: cookieParts.join("; ")
    };

    if (auth.guestToken) {
      headers["x-guest-token"] = auth.guestToken;
    }

    return headers;
  }

  private getSetCookieHeaders(response: Response): string[] {
    const extendedHeaders = response.headers as Headers & {
      getSetCookie?: () => string[];
    };

    if (typeof extendedHeaders.getSetCookie === "function") {
      return extendedHeaders.getSetCookie();
    }

    const single = response.headers.get("set-cookie");
    if (!single) {
      return [];
    }

    return [single];
  }

  private async refreshCsrfTokenFromCurrentAuth(): Promise<boolean> {
    const auth = this.currentAuthCandidate();
    if (!auth?.authToken) {
      return false;
    }

    const cookieParts = [`auth_token=${auth.authToken}`];
    if (this.cookieHeaderBase) {
      cookieParts.push(this.cookieHeaderBase);
    }

    const homePages = ["https://x.com/", "https://twitter.com/"];

    for (const homeUrl of homePages) {
      try {
        const response = await fetch(homeUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            Cookie: cookieParts.join("; ")
          }
        });

        const setCookies = this.getSetCookieHeaders(response);
        for (const cookie of setCookies) {
          const pair = parseCookieFirstPair(cookie);
          if (pair?.name !== "ct0" || !pair.value) {
            continue;
          }

          if (pair.value === auth.ct0) {
            return false;
          }

          auth.ct0 = pair.value;
          return true;
        }
      } catch {
      }
    }

    return false;
  }

  private async refreshWebMetadata(): Promise<boolean> {
    const homePages = ["https://x.com/", "https://twitter.com/"];
    const discoveredTokens: string[] = [];
    const discoveredOperations: GraphqlOperation[] = [];

    for (const homeUrl of homePages) {
      try {
        const homeResponse = await fetch(homeUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
          }
        });

        if (!homeResponse.ok) {
          continue;
        }

        const html = await homeResponse.text();
        const scriptUrls = extractMainJsUrls(html);
        for (const scriptUrl of scriptUrls) {
          try {
            const scriptResponse = await fetch(scriptUrl, {
              headers: {
                "User-Agent":
                  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
                Accept: "*/*"
              }
            });

            if (!scriptResponse.ok) {
              continue;
            }

            const scriptText = await scriptResponse.text();
            discoveredTokens.push(...extractBearerFromScript(scriptText));
            discoveredOperations.push(...extractGraphqlOperations(scriptText));
          } catch {
          }
        }
      } catch {
      }
    }

    if (discoveredTokens.length > 0) {
      this.setBearerTokens(discoveredTokens);
    }

    if (discoveredOperations.length > 0) {
      this.mergeGraphqlOperations(discoveredOperations);
    }

    return discoveredTokens.length > 0 || discoveredOperations.length > 0;
  }

  private async requestJsonFromBases<T>(
    bases: string[],
    path: string,
    params: Record<string, string>
  ): Promise<T> {
    const errors: string[] = [];
    const normalizedPath = path.replace(/^\/+/, "");

    let canRefreshMeta = true;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let sawAuthFailure = false;
      let sawQueryIdNotFound = false;

      for (const base of bases) {
        const url = new URL(normalizedPath, base);
        for (const [key, value] of Object.entries(params)) {
          url.searchParams.set(key, value);
        }

        try {
          const response = await fetch(url.toString(), {
            headers: this.buildHeaders()
          });

          const text = await response.text();
          const parsed = parseJson(text);

          if (!response.ok) {
            const detail = extractErrorDetail(parsed);
            errors.push(`${url.toString()} -> ${response.status} ${detail}`);
            if (isBearerAuthFailure(response.status, detail)) {
              sawAuthFailure = true;
            }
            if (isLikelyQueryIdNotFound(response.status, detail)) {
              sawQueryIdNotFound = true;
            }
            continue;
          }

          if (!parsed) {
            errors.push(`${url.toString()} -> empty JSON response`);
            continue;
          }

          return parsed as T;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          errors.push(`${url.toString()} -> ${message}`);
        }
      }

      if (sawAuthFailure && this.rotateAuthCandidate()) {
        errors.push("auth cookie pair rotate succeeded, retrying request once.");
        continue;
      }

      if (sawAuthFailure && (await this.refreshCsrfTokenFromCurrentAuth())) {
        errors.push("csrf token refresh succeeded, retrying request once.");
        continue;
      }

      if (sawAuthFailure && this.rotateBearerToken()) {
        errors.push("bearer rotate succeeded, retrying request once.");
        continue;
      }

      if ((sawAuthFailure || sawQueryIdNotFound) && canRefreshMeta) {
        const refreshed = await this.refreshWebMetadata();
        canRefreshMeta = false;
        if (refreshed) {
          errors.push("web metadata refresh succeeded, retrying request once.");
          continue;
        }
      }

      break;
    }

    throw new Error(`graphql request failed: ${errors.join(" | ")}`);
  }

  private async requestGraphql<T>(
    operationName: GraphqlOperation["name"],
    queryId: string,
    variables: Record<string, unknown>,
    features?: Record<string, unknown>
  ): Promise<T> {
    const path = `${queryId}/${operationName}`;
    const adaptiveFeatures: Record<string, unknown> = {
      ...(features ?? {})
    };

    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const params: Record<string, string> = {
        variables: JSON.stringify(variables)
      };

      if (Object.keys(adaptiveFeatures).length > 0) {
        params.features = JSON.stringify(adaptiveFeatures);
      }

      try {
        return await this.requestJsonFromBases<T>(GRAPHQL_BASES, path, params);
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const missing = extractMissingGraphqlFeatures(message);
        const newKeys = missing.filter((key) => !(key in adaptiveFeatures));

        if (newKeys.length === 0) {
          throw error;
        }

        for (const key of newKeys) {
          adaptiveFeatures[key] = false;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "GraphQL request failed."));
  }

  async resolveUserIdByGraphql(username: string): Promise<string> {
    const operations = Array.from(new Set(this.gqlUserByScreenNameIds));
    const errors: string[] = [];

    for (const queryId of operations) {
      try {
        const response = await this.requestGraphql<GraphqlUserByScreenNameResponse>(
          "UserByScreenName",
          queryId,
          {
            screen_name: username,
            withSafetyModeUserFields: true
          },
          {
            hidden_profile_likes_enabled: true,
            hidden_profile_subscriptions_enabled: true,
            creator_subscriptions_tweet_preview_api_enabled: true,
            highlights_tweets_tab_ui_enabled: true,
            profile_label_improvements_pcf_label_in_post_enabled: true,
            subscriptions_feature_can_gift_premium: false,
            rweb_tipjar_consumption_enabled: true,
            responsive_web_twitter_article_notes_tab_enabled: true,
            responsive_web_profile_redirect_enabled: false,
            responsive_web_graphql_exclude_directive_enabled: true,
            verified_phone_label_enabled: false,
            subscriptions_verification_info_verified_since_enabled: true,
            subscriptions_verification_info_is_identity_verified_enabled: true,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
            responsive_web_graphql_timeline_navigation_enabled: true
          }
        );

        const userId = response.data?.user?.result?.rest_id;
        if (userId) {
          return userId;
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    throw new Error(`GraphQL UserByScreenName failed: ${errors.join(" | ")}`);
  }

  async fetchUserMediaByGraphql(
    userId: string,
    count: number,
    cursor?: string
  ): Promise<{ tweets: GraphqlLegacyTweet[]; nextCursor?: string }> {
    const operations: Array<{ name: GraphqlOperation["name"]; queryId: string }> = [
      ...this.gqlUserTweetsIds.map((queryId) => ({ name: "UserTweets" as const, queryId })),
      ...this.gqlUserMediaIds.map((queryId) => ({ name: "UserMedia" as const, queryId }))
    ];
    const errors: string[] = [];

    for (const operation of operations) {
      try {
        const response = await this.requestGraphql<GraphqlUserMediaResponse>(
          operation.name,
          operation.queryId,
          {
            userId,
            count,
            includePromotedContent: false,
            withVoice: true,
            withV2Timeline: true,
            cursor
          },
          {
            responsive_web_graphql_exclude_directive_enabled: true,
            verified_phone_label_enabled: false,
            creator_subscriptions_tweet_preview_api_enabled: true,
            responsive_web_text_conversations_enabled: false,
            vibe_api_enabled: false,
            blue_business_profile_image_shape_enabled: false,
            interactive_text_enabled: false,
            responsive_web_graphql_timeline_navigation_enabled: true,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
            c9s_tweet_anatomy_moderator_badge_enabled: true,
            tweetypie_unmention_optimization_enabled: true,
            responsive_web_edit_tweet_api_enabled: true,
            graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
            view_counts_everywhere_api_enabled: true,
            longform_notetweets_consumption_enabled: true,
            responsive_web_twitter_article_tweet_consumption_enabled: false,
            tweet_awards_web_tipping_enabled: false,
            freedom_of_speech_not_reach_fetch_enabled: true,
            standardized_nudges_misinfo: true,
            tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
            rweb_video_timestamps_enabled: true,
            longform_notetweets_rich_text_read_enabled: true,
            longform_notetweets_inline_media_enabled: true,
            responsive_web_enhance_cards_enabled: false
          }
        );

        const instructions =
          response.data?.user?.result?.timeline_v2?.timeline?.instructions ?? [];

        const tweets: GraphqlLegacyTweet[] = [];
        let nextCursor: string | undefined;

        for (const instruction of instructions) {
          const entries = instruction.entries ?? [];
          for (const entry of entries) {
            const tweet = extractTweetFromTimelineEntry(entry);
            if (tweet) {
              tweets.push(tweet);
              continue;
            }

            if (entry.entryId?.startsWith("cursor-bottom-")) {
              const content = entry.content as
                | {
                    value?: string;
                    itemContent?: {
                      value?: string;
                    };
                  }
                | undefined;
              const cursorValue = content?.value ?? content?.itemContent?.value;
              if (cursorValue) {
                nextCursor = cursorValue;
              }
            }
          }
        }

        return { tweets, nextCursor };
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    throw new Error(`GraphQL UserMedia failed: ${errors.join(" | ")}`);
  }

  async fetchUserTimelineV11(username: string, count: number, maxId?: string): Promise<V11Status[]> {
    const params: Record<string, string> = {
      screen_name: username,
      count: String(Math.min(200, Math.max(1, count))),
      include_rts: "false",
      exclude_replies: "true",
      tweet_mode: "extended",
      include_ext_alt_text: "true"
    };

    if (maxId) {
      params.max_id = maxId;
    }

    const response = await this.requestJsonFromBases<V11Status[] | { errors?: unknown }>(
      API_V11_BASES,
      "statuses/user_timeline.json",
      params
    );

    if (Array.isArray(response)) {
      return response;
    }

    throw new Error(`Timeline response invalid: ${extractErrorDetail(response)}`);
  }
}

function mapMediaToItemsFromTweet(
  tweetId: string,
  createdAt: string | undefined,
  medias: GraphqlMediaItem[],
  username: string,
  allowedKinds: Set<MediaKind>
): MediaItem[] {
  const items: MediaItem[] = [];
  let index = 0;

  for (const media of medias) {
    let url: string | null = null;
    if (media.type === "photo") {
      url = normalizeImageUrl(media.media_url_https ?? media.media_url ?? "");
    } else if (media.type === "video" || media.type === "animated_gif") {
      url = pickBestVideoVariant(media);
    }

    if (!url) {
      continue;
    }

    const kind = mapMediaKind(media, url);
    if (!kind || !allowedKinds.has(kind)) {
      continue;
    }

    const mediaId = media.id_str ?? media.media_key ?? `media_${index}`;
    items.push({
      id: `${tweetId}_${mediaId}`,
      tweetId,
      username,
      kind,
      url,
      createdAt,
      filenameHint: `${tweetId}_${mediaId}`
    });
    index += 1;
  }

  return items;
}

function mapGraphqlTweetToMediaItems(
  tweet: GraphqlLegacyTweet,
  expectedUserId: string,
  username: string,
  allowedKinds: Set<MediaKind>
): MediaItem[] {
  const tweetId = tweet.id_str;
  if (!tweetId) {
    return [];
  }

  if (tweet.user_id_str && tweet.user_id_str !== expectedUserId) {
    return [];
  }

  if (tweet.retweeted_status_result) {
    return [];
  }

  const medias = tweet.extended_entities?.media ?? tweet.entities?.media ?? [];
  if (medias.length === 0) {
    return [];
  }

  return mapMediaToItemsFromTweet(tweetId, tweet.created_at, medias, username, allowedKinds);
}

function mapV11TweetToMediaItems(
  tweet: V11Status,
  normalizedUsername: string,
  allowedKinds: Set<MediaKind>
): MediaItem[] {
  const tweetId = tweet.id_str;
  if (!tweetId) {
    return [];
  }

  if (tweet.retweeted_status) {
    return [];
  }

  const author = tweet.user?.screen_name?.toLowerCase();
  if (author && author !== normalizedUsername) {
    return [];
  }

  const medias = tweet.extended_entities?.media ?? tweet.entities?.media ?? [];
  if (medias.length === 0) {
    return [];
  }

  return mapMediaToItemsFromTweet(tweetId, tweet.created_at, medias, normalizedUsername, allowedKinds);
}

export class GraphqlMediaScraper implements MediaScraper {
  private initialized = false;
  private client: GraphqlApiClient | null = null;

  async initialize(session: SessionData): Promise<void> {
    const bundle = buildGraphqlAuthBundle(session);

    if (!this.client) {
      this.client = new GraphqlApiClient(bundle);
    } else {
      this.client.setBundle(bundle);
    }

    this.initialized = true;
  }

  private async fetchViaGraphql(
    username: string,
    maxTweets: number,
    allowedKinds: Set<MediaKind>
  ): Promise<MediaItem[]> {
    if (!this.client) {
      throw new Error("graphql client missing.");
    }

    const userId = await this.client.resolveUserIdByGraphql(username);

    const collected: MediaItem[] = [];
    let remaining = maxTweets;
    let cursor: string | undefined;
    let guard = 0;

    while (remaining > 0 && guard < 30) {
      guard += 1;
      const pageSize = Math.min(100, remaining);
      const page = await this.client.fetchUserMediaByGraphql(userId, pageSize, cursor);

      if (page.tweets.length === 0) {
        break;
      }

      for (const tweet of page.tweets) {
        remaining -= 1;
        collected.push(...mapGraphqlTweetToMediaItems(tweet, userId, username, allowedKinds));
      }

      if (!page.nextCursor || page.nextCursor === cursor) {
        break;
      }

      cursor = page.nextCursor;
    }

    return dedupeMedia(collected);
  }

  private async fetchViaV11(
    username: string,
    maxTweets: number,
    allowedKinds: Set<MediaKind>
  ): Promise<MediaItem[]> {
    if (!this.client) {
      throw new Error("graphql client missing.");
    }

    const normalizedUsername = username.toLowerCase();
    const collected: MediaItem[] = [];
    let remaining = maxTweets;
    let maxId: string | undefined;
    let guard = 0;

    while (remaining > 0 && guard < 30) {
      guard += 1;
      const pageSize = Math.min(200, remaining);
      const page = await this.client.fetchUserTimelineV11(username, pageSize, maxId);

      if (page.length === 0) {
        break;
      }

      for (const tweet of page) {
        remaining -= 1;
        collected.push(...mapV11TweetToMediaItems(tweet, normalizedUsername, allowedKinds));
      }

      const last = page[page.length - 1];
      const lastId = last?.id_str;
      if (!lastId || !/^\d+$/.test(lastId)) {
        break;
      }

      const nextMax = (BigInt(lastId) - 1n).toString();
      if (nextMax === lastId) {
        break;
      }

      maxId = nextMax;
    }

    return dedupeMedia(collected);
  }

  async fetchUserMedia(input: FetchUserMediaInput): Promise<MediaItem[]> {
    if (!this.initialized || !this.client) {
      throw new Error("graphql scraper not initialized.");
    }

    const username = normalizeUsername(input.username);
    const maxTweets = input.maxTweets ?? 200;
    const allowedKinds = new Set(input.mediaKinds);

    const errors: string[] = [];

    try {
      return await this.fetchViaGraphql(username, maxTweets, allowedKinds);
    } catch (error) {
      errors.push(`graphql: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      return await this.fetchViaV11(username, maxTweets, allowedKinds);
    } catch (error) {
      errors.push(`v1.1: ${error instanceof Error ? error.message : String(error)}`);
    }

    throw new Error(`graphql failed: ${errors.join(" | ")}`);
  }

  async close(): Promise<void> {
    this.initialized = false;
    this.client = null;
  }
}
