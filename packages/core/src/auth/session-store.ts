import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SessionData } from "@twmd/shared";
import { nowIso } from "../utils/time.js";

export interface SessionStoreOptions {
  appName: string;
  sessionFileName?: string;
}

export interface SessionStore {
  path: string;
  exists(): Promise<boolean>;
  load(): Promise<SessionData | null>;
  save(data: SessionData): Promise<void>;
  clear(): Promise<void>;
}

export interface LoginWithCookiesInput {
  store: SessionStore;
  cookieText: string;
  strict?: boolean;
  requiredCookieNames?: string[];
}

export interface WhoAmIResult {
  loggedIn: boolean;
  updatedAt?: string;
  cookieCount?: number;
  missingCookieNames?: string[];
}

const DEFAULT_REQUIRED_COOKIE_NAMES = ["auth_token", "ct0"];

function normalizeCookieDomainValue(rawDomain: string): string {
  const trimmed = rawDomain.trim();
  const domain = trimmed.replace(/^\./, "").toLowerCase();

  if (domain === "x.com" || domain.endsWith(".x.com")) {
    return ".x.com";
  }

  if (domain === "twitter.com" || domain.endsWith(".twitter.com")) {
    return ".twitter.com";
  }

  return trimmed;
}

function normalizeCookieDomainAttribute(cookie: string): string {
  return cookie.replace(/;\s*Domain=([^;]+)/i, (_full, domainPart: string) => {
    const normalized = normalizeCookieDomainValue(domainPart);
    return `; Domain=${normalized}`;
  });
}

function withDomain(cookie: string, domain: ".x.com" | ".twitter.com"): string {
  if (/;\s*Domain=/i.test(cookie)) {
    return cookie.replace(/;\s*Domain=([^;]+)/i, `; Domain=${domain}`);
  }

  return `${cookie}; Domain=${domain}`;
}

function expandCrossDomainCookies(cookie: string): string[] {
  const domainMatch = cookie.match(/;\s*Domain=([^;]+)/i);
  if (!domainMatch) {
    return [cookie];
  }

  const normalizedDomain = normalizeCookieDomainValue(domainMatch[1]);
  if (normalizedDomain === ".x.com") {
    return [withDomain(cookie, ".x.com"), withDomain(cookie, ".twitter.com")];
  }

  if (normalizedDomain === ".twitter.com") {
    return [withDomain(cookie, ".twitter.com"), withDomain(cookie, ".x.com")];
  }

  return [cookie];
}

export function normalizeCookiesForTwitterRequests(cookies: string[]): string[] {
  const normalized = cookies
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.length > 0)
    .map((cookie) => normalizeCookieDomainAttribute(cookie))
    .flatMap((cookie) => expandCrossDomainCookies(cookie));

  return Array.from(new Set(normalized));
}

function parseCookieHeader(cookieHeader: string): string[] {
  return cookieHeader
    .split(";")
    .map((item) => item.trim())
    .filter((item) => item.includes("="));
}

function parseCookieLines(cookieText: string): string[] {
  return cookieText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        (!line.startsWith("#") || line.startsWith("#HttpOnly_")) &&
        line.includes("=")
    )
    .map((line) => line.replace(/^#HttpOnly_/, ""));
}

function parseNetscapeCookies(cookieText: string): string[] {
  const lines = cookieText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(
      (line) => line.length > 0 && (!line.startsWith("#") || line.startsWith("#HttpOnly_"))
    );

  const cookies: string[] = [];
  for (const line of lines) {
    const isHttpOnly = line.startsWith("#HttpOnly_");
    const sanitizedLine = line.replace(/^#HttpOnly_/, "");
    const parts = sanitizedLine.split("\t");
    if (parts.length < 7) {
      continue;
    }

    const domain = normalizeCookieDomainValue(parts[0]);
    const path = parts[2] || "/";
    const secure = parts[3]?.toUpperCase() === "TRUE";
    const name = parts[5];
    const value = parts[6];

    if (!name || !value) {
      continue;
    }

    const securePart = secure ? "; Secure" : "";
    const httpOnlyPart = isHttpOnly ? "; HttpOnly" : "";
    cookies.push(`${name}=${value}; Domain=${domain}; Path=${path}${securePart}${httpOnlyPart}`);
  }

  return cookies;
}

export function parseCookies(cookieText: string): string[] {
  const text = cookieText.trim();
  if (!text) {
    return [];
  }

  if (text.includes("\t")) {
    const parsed = parseNetscapeCookies(text);
    if (parsed.length > 0) {
      return normalizeCookiesForTwitterRequests(parsed);
    }
  }

  const asLines = parseCookieLines(text);
  if (asLines.length > 1) {
    return normalizeCookiesForTwitterRequests(asLines);
  }

  return normalizeCookiesForTwitterRequests(parseCookieHeader(text));
}

function extractCookieName(cookie: string): string | null {
  const firstSegment = cookie.split(";")[0]?.trim();
  if (!firstSegment) {
    return null;
  }

  const index = firstSegment.indexOf("=");
  if (index <= 0) {
    return null;
  }

  const name = firstSegment.slice(0, index).trim();
  if (!name) {
    return null;
  }

  return name;
}

export function validateRequiredCookies(
  cookies: string[],
  requiredCookieNames: string[] = DEFAULT_REQUIRED_COOKIE_NAMES
): { valid: boolean; missing: string[]; cookieCount: number } {
  const names = new Set(
    cookies
      .map((cookie) => extractCookieName(cookie))
      .filter((name): name is string => Boolean(name))
      .map((name) => name.toLowerCase())
  );

  const missing = requiredCookieNames.filter((requiredName) =>
    !names.has(requiredName.toLowerCase())
  );

  return {
    valid: missing.length === 0,
    missing,
    cookieCount: cookies.length
  };
}

export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const baseDir = join(homedir(), `.${options.appName}`);
  const sessionFileName = options.sessionFileName ?? "session.json";
  const path = join(baseDir, sessionFileName);

  return {
    path,
    async exists(): Promise<boolean> {
      try {
        await access(path, fsConstants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    async load(): Promise<SessionData | null> {
      const hasSession = await this.exists();
      if (!hasSession) {
        return null;
      }

      const raw = await readFile(path, "utf8");
      return JSON.parse(raw) as SessionData;
    },
    async save(data: SessionData): Promise<void> {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(data, null, 2), { mode: 0o600 });
    },
    async clear(): Promise<void> {
      await rm(path, { force: true });
    }
  };
}

export async function loginWithCookies(input: LoginWithCookiesInput): Promise<SessionData> {
  const cookies = normalizeCookiesForTwitterRequests(parseCookies(input.cookieText));
  if (cookies.length === 0) {
    throw new Error("No valid cookie found from input.");
  }

  const strict = input.strict ?? true;
  const requiredCookieNames = input.requiredCookieNames ?? DEFAULT_REQUIRED_COOKIE_NAMES;
  if (strict) {
    const validation = validateRequiredCookies(cookies, requiredCookieNames);
    if (!validation.valid) {
      throw new Error(
        `Missing required cookies: ${validation.missing.join(", ")}. Please export complete Twitter/X cookies.`
      );
    }
  }

  const session: SessionData = {
    cookies,
    updatedAt: nowIso(),
    valid: true
  };

  await input.store.save(session);
  return session;
}

export async function whoami(store: SessionStore): Promise<WhoAmIResult> {
  const session = await store.load();
  if (!session || !session.valid || session.cookies.length === 0) {
    return { loggedIn: false };
  }

  const validation = validateRequiredCookies(session.cookies);
  if (!validation.valid) {
    return {
      loggedIn: false,
      updatedAt: session.updatedAt,
      cookieCount: session.cookies.length,
      missingCookieNames: validation.missing
    };
  }

  return {
    loggedIn: true,
    updatedAt: session.updatedAt,
    cookieCount: session.cookies.length
  };
}

export async function logout(store: SessionStore): Promise<void> {
  await store.clear();
}
