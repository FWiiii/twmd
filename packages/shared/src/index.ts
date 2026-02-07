export type MediaKind = "image" | "video" | "gif";

export interface SessionData {
  cookiesRaw: string;
  updatedAt: string;
  valid: boolean;
}

export interface BatchJobInput {
  users: string[];
  outputDir: string;
  mediaKinds: MediaKind[];
  maxTweetsPerUser?: number;
  concurrency?: number;
}

export type JobEventType =
  | "job_started"
  | "user_started"
  | "media_found"
  | "download_progress"
  | "user_finished"
  | "job_finished"
  | "warning"
  | "error";

export interface JobEvent {
  type: JobEventType;
  message: string;
  timestamp: string;
  username?: string;
}

export interface JobResult {
  totalUsers: number;
  succeededUsers: number;
  failedUsers: number;
  totalMedia: number;
  downloaded: number;
  failed: number;
  skipped: number;
}
