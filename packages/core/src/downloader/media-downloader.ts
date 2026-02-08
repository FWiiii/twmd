import { constants as fsConstants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FailureDetail, MediaItem } from "@huangjz11/shared";
import { buildMediaFilename, sanitizePathPart } from "../utils/path.js";
import { nowIso, sleep } from "../utils/time.js";

export interface DownloadMediaBatchInput {
  items: MediaItem[];
  outputDir: string;
  concurrency?: number;
  retryCount?: number;
  username?: string;
  perRequestDelayMs?: number;
}

export interface DownloadMediaBatchResult {
  total: number;
  downloaded: number;
  failed: number;
  skipped: number;
  failureDetails: FailureDetail[];
}

interface DownloadAttemptError extends Error {
  code?: string;
  status?: number;
  attempts?: number;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function shouldRetry(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true;
  }

  const detailedError = error as DownloadAttemptError;
  if (typeof detailedError.status === "number") {
    if (detailedError.status === 429) {
      return true;
    }

    if (detailedError.status >= 500) {
      return true;
    }

    return false;
  }

  const message = error.message.toLowerCase();
  return message.includes("network") || message.includes("timeout") || message.includes("fetch");
}

function toFailureCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    const raw = (error as { code?: unknown }).code;
    if (typeof raw === "string" && raw.length > 0) {
      return raw;
    }
  }

  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number") {
      return `HTTP_${status}`;
    }
  }

  return undefined;
}

function toFailureAttempts(error: unknown, fallback: number): number {
  if (error && typeof error === "object" && "attempts" in error) {
    const attempts = (error as { attempts?: unknown }).attempts;
    if (typeof attempts === "number" && attempts > 0) {
      return attempts;
    }
  }

  return fallback;
}

async function downloadWithRetries(
  item: MediaItem,
  targetPath: string,
  retryCount: number,
  perRequestDelayMs: number
): Promise<void> {
  let attempt = 0;

  while (attempt <= retryCount) {
    try {
      if (perRequestDelayMs > 0) {
        await sleep(perRequestDelayMs);
      }

      const response = await fetch(item.url);
      if (!response.ok) {
        const error = new Error(`HTTP ${response.status} for ${item.url}`) as DownloadAttemptError;
        error.status = response.status;
        throw error;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(targetPath, buffer);
      return;
    } catch (error) {
      const performedAttempts = attempt + 1;
      const canRetry = shouldRetry(error);
      if (!canRetry || attempt === retryCount) {
        if (error && typeof error === "object") {
          (error as DownloadAttemptError).attempts = performedAttempts;
        }
        throw error;
      }

      const backoff = 500 * Math.pow(2, attempt);
      await sleep(backoff);
      attempt += 1;
    }
  }
}

async function processOne(
  item: MediaItem,
  outputDir: string,
  retryCount: number,
  username: string,
  perRequestDelayMs: number
): Promise<{
  status: "downloaded" | "failed" | "skipped";
  failure?: FailureDetail;
}> {
  const userDir = join(outputDir, sanitizePathPart(item.username));
  await mkdir(userDir, { recursive: true });

  const fileName = buildMediaFilename(item);
  const filePath = join(userDir, fileName);

  if (await fileExists(filePath)) {
    return { status: "skipped" };
  }

  try {
    await downloadWithRetries(item, filePath, retryCount, perRequestDelayMs);
    return { status: "downloaded" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "failed",
      failure: {
        scope: "media",
        username,
        message,
        code: toFailureCode(error),
        media: {
          tweetId: item.tweetId,
          mediaId: item.id,
          url: item.url,
          targetPath: filePath
        },
        attempts: toFailureAttempts(error, retryCount + 1),
        timestamp: nowIso()
      }
    };
  }
}

async function runWorker(
  queue: MediaItem[],
  outputDir: string,
  retryCount: number,
  result: DownloadMediaBatchResult,
  username: string,
  perRequestDelayMs: number
): Promise<void> {
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) {
      return;
    }

    const outcome = await processOne(item, outputDir, retryCount, username, perRequestDelayMs);

    if (outcome.status === "downloaded") {
      result.downloaded += 1;
    } else if (outcome.status === "failed") {
      result.failed += 1;
      if (outcome.failure) {
        result.failureDetails.push(outcome.failure);
      }
    } else {
      result.skipped += 1;
    }
  }
}

export async function downloadMediaBatch(
  input: DownloadMediaBatchInput
): Promise<DownloadMediaBatchResult> {
  const queue = [...input.items];
  const concurrency = Math.max(1, input.concurrency ?? 4);
  const retryCount = Math.max(0, input.retryCount ?? 2);
  const username = input.username ?? "unknown";
  const perRequestDelayMs = Math.max(0, input.perRequestDelayMs ?? 0);

  const result: DownloadMediaBatchResult = {
    total: input.items.length,
    downloaded: 0,
    failed: 0,
    skipped: 0,
    failureDetails: []
  };

  if (queue.length === 0) {
    return result;
  }

  const workerCount = Math.min(concurrency, queue.length);
  const workers = Array.from({ length: workerCount }, () =>
    runWorker(queue, input.outputDir, retryCount, result, username, perRequestDelayMs)
  );

  await Promise.all(workers);
  return result;
}
