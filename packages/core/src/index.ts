import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionStoreOptions {
  appName: string;
}

export interface SessionStore {
  path: string;
}

export function createSessionStore(options: SessionStoreOptions): SessionStore {
  const base = join(homedir(), `.${options.appName}`);
  return { path: join(base, "session.json") };
}
