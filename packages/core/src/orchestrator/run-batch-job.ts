import type { BatchJobInput, FailureDetail, JobEvent, JobResult, SessionData } from "@twmd/shared";
import type { SessionStore } from "../auth/session-store.js";
import { downloadMediaBatch } from "../downloader/media-downloader.js";
import { createMediaScraper, type MediaScraper } from "../scraper/media-scraper.js";
import { nowIso, sleep } from "../utils/time.js";

export interface BatchJobRunInput extends BatchJobInput {
  store: SessionStore;
  scraper?: MediaScraper;
}

const DEFAULT_USER_RETRY_COUNT = 1;
const DEFAULT_USER_DELAY_MS = 0;
const DEFAULT_REQUEST_DELAY_MS = 0;

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

function buildAnonymousSession(): SessionData {
  return {
    cookies: [],
    valid: false,
    updatedAt: nowIso()
  };
}

export async function *runBatchJob(
  input: BatchJobRunInput
): AsyncGenerator<JobEvent, JobResult, void> {
  const session = await input.store.load();
  const activeSession = session && session.cookies.length > 0 ? session : buildAnonymousSession();
  const scraper = input.scraper ?? createMediaScraper();
  await scraper.initialize(activeSession);

  try {
    const result: JobResult = {
      totalUsers: input.users.length,
      succeededUsers: 0,
      failedUsers: 0,
      totalMedia: 0,
      downloaded: 0,
      failed: 0,
      skipped: 0,
      failureDetails: []
    };

    const userRetryCount = Math.max(0, input.userRetryCount ?? DEFAULT_USER_RETRY_COUNT);
    const userDelayMs = Math.max(0, input.userDelayMs ?? DEFAULT_USER_DELAY_MS);
    const perRequestDelayMs = Math.max(0, input.perRequestDelayMs ?? DEFAULT_REQUEST_DELAY_MS);

    yield createEvent("job_started", `Batch started for ${input.users.length} user(s).`);

    for (const usernameRaw of input.users) {
      const username = usernameRaw.replace(/^@/, "").trim();

      if (!username) {
        result.failedUsers += 1;
        yield createEvent("warning", "Skipped empty username entry.");
        continue;
      }

      yield createEvent("user_started", `Processing @${username}`, { username });

      let completed = false;
      for (let attempt = 1; attempt <= userRetryCount + 1; attempt += 1) {
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
            retryCount: input.retryCount,
            username,
            perRequestDelayMs
          });

          result.downloaded += downloaded.downloaded;
          result.failed += downloaded.failed;
          result.skipped += downloaded.skipped;
          result.failureDetails.push(...downloaded.failureDetails);
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

          completed = true;
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const failureDetail: FailureDetail = {
            scope: "user",
            username,
            message,
            attempts: attempt,
            timestamp: nowIso()
          };

          if (attempt <= userRetryCount) {
            result.failureDetails.push(failureDetail);
            yield createEvent(
              "warning",
              `@${username} attempt ${attempt}/${userRetryCount + 1} failed, retrying: ${message}`,
              { username }
            );

            const retryBackoffMs = Math.max(500, 500 * Math.pow(2, attempt - 1));
            await sleep(retryBackoffMs);
            continue;
          }

          result.failureDetails.push(failureDetail);
          result.failedUsers += 1;
          yield createEvent("error", `@${username} failed: ${message}`, { username });
        }
      }

      if (userDelayMs > 0) {
        await sleep(userDelayMs);
      }

      if (!completed) {
        continue;
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
  } finally {
    if (typeof scraper.close === "function") {
      await scraper.close();
    }
  }
}

export function summarizeJobResult(result: JobResult): string {
  return [
    `users(total/succeeded/failed): ${result.totalUsers}/${result.succeededUsers}/${result.failedUsers}`,
    `media(total/downloaded/failed/skipped): ${result.totalMedia}/${result.downloaded}/${result.failed}/${result.skipped}`,
    `failure-details: ${result.failureDetails.length}`
  ].join("\n");
}
