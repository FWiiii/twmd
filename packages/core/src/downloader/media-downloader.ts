import { access, mkdir, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import type { MediaItem } from "@twmd/shared";
import { buildMediaFilename, sanitizePathPart } from "../utils/path.js";
import { sleep } from "../utils/time.js";

export interface DownloadMediaBatchInput {
  items: MediaItem[];
  outputDir: string;
  concurrency?: number;
  retryCount?: number;
}

export interface DownloadMediaBatchResult {
  total: number;
  downloaded: number;
  failed: number;
  skipped: number;
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

  const message = error.message.toLowerCase();
  return (
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("fetch") ||
    message.includes("5")
  );
}

async function downloadWithRetries(item: MediaItem, targetPath: string, retryCount: number): Promise<void> {
  let attempt = 0;

  while (attempt <= retryCount) {
    try {
      const response = await fetch(item.url);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${item.url}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(targetPath, buffer);
      return;
    } catch (error) {
      const canRetry = shouldRetry(error);
      if (!canRetry || attempt === retryCount) {
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
  retryCount: number
): Promise<"downloaded" | "failed" | "skipped"> {
  const userDir = join(outputDir, sanitizePathPart(item.username));
  await mkdir(userDir, { recursive: true });

  const fileName = buildMediaFilename(item);
  const filePath = join(userDir, fileName);

  if (await fileExists(filePath)) {
    return "skipped";
  }

  try {
    await downloadWithRetries(item, filePath, retryCount);
    return "downloaded";
  } catch {
    return "failed";
  }
}

async function runWorker(
  queue: MediaItem[],
  outputDir: string,
  retryCount: number,
  result: DownloadMediaBatchResult
): Promise<void> {
  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) {
      return;
    }

    const status = await processOne(item, outputDir, retryCount);
    if (status === "downloaded") {
      result.downloaded += 1;
    } else if (status === "failed") {
      result.failed += 1;
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

  const result: DownloadMediaBatchResult = {
    total: input.items.length,
    downloaded: 0,
    failed: 0,
    skipped: 0
  };

  if (queue.length === 0) {
    return result;
  }

  const workerCount = Math.min(concurrency, queue.length);
  const workers = Array.from({ length: workerCount }, () =>
    runWorker(queue, input.outputDir, retryCount, result)
  );

  await Promise.all(workers);
  return result;
}
