export type MediaKind = "image" | "video" | "gif";

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

export interface BatchJobInput {
  users: string[];
  outputDir: string;
  mediaKinds: MediaKind[];
  maxTweetsPerUser?: number;
  concurrency?: number;
  retryCount?: number;
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
}
