export type MediaKind = "image" | "video" | "gif";

export type ScraperEngine = "playwright" | "graphql";

export interface SessionData {
  cookies: string[];
  updatedAt: string;
  valid: boolean;
}

export interface MediaItem {
  id: string;
  tweetId: string;
  username: string;
  kind: MediaKind;
  url: string;
  createdAt?: string;
  filenameHint?: string;
}

export interface FailureDetail {
  scope: "user" | "media";
  username: string;
  message: string;
  code?: string;
  media?: {
    tweetId: string;
    mediaId: string;
    url: string;
    targetPath?: string;
  };
  attempts?: number;
  timestamp: string;
}

export interface BatchJobInput {
  users: string[];
  outputDir: string;
  mediaKinds: MediaKind[];
  engine?: ScraperEngine;
  maxTweetsPerUser?: number;
  concurrency?: number;
  retryCount?: number;
  userRetryCount?: number;
  userDelayMs?: number;
  perRequestDelayMs?: number;
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
  progress?: {
    total: number;
    downloaded: number;
    failed: number;
    skipped: number;
  };
}

export interface JobResult {
  totalUsers: number;
  succeededUsers: number;
  failedUsers: number;
  totalMedia: number;
  downloaded: number;
  failed: number;
  skipped: number;
  failureDetails: FailureDetail[];
}
