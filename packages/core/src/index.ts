import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { BatchJobInput, JobEvent, JobResult, SessionData } from "@twmd/shared";

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
}

export interface BatchJobRunInput extends BatchJobInput {
  store: SessionStore;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createEvent(type: JobEvent["type"], message: string, username?: string): JobEvent {
  return {
    type,
    message,
    timestamp: nowIso(),
    username
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
  const cookieText = input.cookieText.trim();
  if (!cookieText) {
    throw new Error("Cookie content is empty.");
  }

  const session: SessionData = {
    cookiesRaw: cookieText,
    updatedAt: nowIso(),
    valid: true
  };

  await input.store.save(session);
  return session;
}

export async function whoami(store: SessionStore): Promise<WhoAmIResult> {
  const session = await store.load();
  if (!session || !session.valid) {
    return { loggedIn: false };
  }

  return {
    loggedIn: true,
    updatedAt: session.updatedAt
  };
}

export async function logout(store: SessionStore): Promise<void> {
  await store.clear();
}

export async function *runBatchJob(input: BatchJobRunInput): AsyncGenerator<JobEvent, JobResult, void> {
  const session = await input.store.load();
  if (!session || !session.valid) {
    throw new Error("Session is not available. Run login first.");
  }

  yield createEvent("job_started", `Batch started for ${input.users.length} user(s).`);

  const result: JobResult = {
    totalUsers: input.users.length,
    succeededUsers: 0,
    failedUsers: 0,
    totalMedia: 0,
    downloaded: 0,
    failed: 0,
    skipped: 0
  };

  for (const username of input.users) {
    yield createEvent("user_started", `Processing @${username}`, username);

    yield createEvent(
      "warning",
      "Scraper is not implemented yet in this milestone; no media downloaded.",
      username
    );

    result.succeededUsers += 1;
    yield createEvent("user_finished", `Finished @${username}`, username);
  }

  yield createEvent("job_finished", "Batch finished.");
  return result;
}

export function summarizeJobResult(result: JobResult): string {
  return [
    `users(total/succeeded/failed): ${result.totalUsers}/${result.succeededUsers}/${result.failedUsers}`,
    `media(total/downloaded/failed/skipped): ${result.totalMedia}/${result.downloaded}/${result.failed}/${result.skipped}`
  ].join("\n");
}
