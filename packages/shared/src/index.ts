export type MediaKind = "image" | "video" | "gif";

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
}
