import type { BatchJobInput, JobEvent, JobResult } from "@twmd/shared";
import type { SessionStore } from "../auth/session-store.js";
import { createMediaScraper, type MediaScraper } from "../scraper/media-scraper.js";
import { downloadMediaBatch } from "../downloader/media-downloader.js";
import { nowIso } from "../utils/time.js";

export interface BatchJobRunInput extends BatchJobInput {
  store: SessionStore;
  scraper?: MediaScraper;
}

function createEvent(
  type: JobEvent["type"],
  message: string,
  extras?: Pick<JobEvent, "username" | "progress">
): JobEvent {
  return {
    type,
    message,
    timestamp: nowIso(),
    ...extras
  };
}

export async function *runBatchJob(
  input: BatchJobRunInput
): AsyncGenerator<JobEvent, JobResult, void> {
  const session = await input.store.load();
  if (!session || !session.valid || session.cookies.length === 0) {
    throw new Error("Session is not available. Run login first.");
  }

  const scraper = input.scraper ?? createMediaScraper();
  await scraper.initialize(session);

  const result: JobResult = {
    totalUsers: input.users.length,
    succeededUsers: 0,
    failedUsers: 0,
    totalMedia: 0,
    downloaded: 0,
    failed: 0,
    skipped: 0
  };

  yield createEvent("job_started", `Batch started for ${input.users.length} user(s).`);

  for (const usernameRaw of input.users) {
    const username = usernameRaw.replace(/^@/, "").trim();

    if (!username) {
      result.failedUsers += 1;
      yield createEvent("warning", "Skipped empty username entry.");
      continue;
    }

    yield createEvent("user_started", `Processing @${username}`, { username });

    try {
      const mediaItems = await scraper.fetchUserMedia({
        username,
        maxTweets: input.maxTweetsPerUser,
        mediaKinds: input.mediaKinds
      });

      result.totalMedia += mediaItems.length;
      yield createEvent("media_found", `Found ${mediaItems.length} media item(s).`, {
        username
      });

      const downloaded = await downloadMediaBatch({
        items: mediaItems,
        outputDir: input.outputDir,
        concurrency: input.concurrency,
        retryCount: input.retryCount
      });

      result.downloaded += downloaded.downloaded;
      result.failed += downloaded.failed;
      result.skipped += downloaded.skipped;
      result.succeededUsers += 1;

      yield createEvent("download_progress", "Download summary recorded.", {
        username,
        progress: {
          total: downloaded.total,
          downloaded: downloaded.downloaded,
          failed: downloaded.failed,
          skipped: downloaded.skipped
        }
      });
      yield createEvent("user_finished", `Finished @${username}`, { username });
    } catch (error) {
      result.failedUsers += 1;
      const message = error instanceof Error ? error.message : String(error);
      yield createEvent("error", `@${username} failed: ${message}`, { username });
    }
  }

  yield createEvent("job_finished", "Batch finished.", {
    progress: {
      total: result.totalMedia,
      downloaded: result.downloaded,
      failed: result.failed,
      skipped: result.skipped
    }
  });

  return result;
}

export function summarizeJobResult(result: JobResult): string {
  return [
    `users(total/succeeded/failed): ${result.totalUsers}/${result.succeededUsers}/${result.failedUsers}`,
    `media(total/downloaded/failed/skipped): ${result.totalMedia}/${result.downloaded}/${result.failed}/${result.skipped}`
  ].join("\n");
}
