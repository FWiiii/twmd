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
}

export interface WhoAmIResult {
  loggedIn: boolean;
  updatedAt?: string;
  cookieCount?: number;
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
    .filter((line) => line.length > 0 && !line.startsWith("#") && line.includes("="));
}

function parseNetscapeCookies(cookieText: string): string[] {
  const lines = cookieText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  const cookies: string[] = [];
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 7) {
      continue;
    }

    const domain = parts[0];
    const path = parts[2] || "/";
    const secure = parts[3]?.toUpperCase() === "TRUE";
    const name = parts[5];
    const value = parts[6];

    if (!name || !value) {
      continue;
    }

    const securePart = secure ? "; Secure" : "";
    cookies.push(`${name}=${value}; Domain=${domain}; Path=${path}${securePart}`);
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
      return parsed;
    }
  }

  const asLines = parseCookieLines(text);
  if (asLines.length > 1) {
    return asLines;
  }

  return parseCookieHeader(text);
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
  const cookies = parseCookies(input.cookieText);
  if (cookies.length === 0) {
    throw new Error("No valid cookie found from input.");
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

  return {
    loggedIn: true,
    updatedAt: session.updatedAt,
    cookieCount: session.cookies.length
  };
}

export async function logout(store: SessionStore): Promise<void> {
  await store.clear();
}
