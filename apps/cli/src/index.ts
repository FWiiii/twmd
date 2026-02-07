#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import {
  createSessionStore,
  loginWithCookies,
  logout,
  runBatchJob,
  summarizeJobResult,
  whoami
} from "@twmd/core";
import type { FailureDetail, JobResult, MediaKind } from "@twmd/shared";
import { CliError, EXIT_CODES, toCliError } from "./error-codes.js";
import { createCsvReport, createJsonReport } from "./reporting.js";

const DEFAULT_MEDIA_KINDS: MediaKind[] = ["image", "video", "gif"];
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_USER_RETRY_COUNT = 1;
const DEFAULT_USER_DELAY_MS = 0;
const DEFAULT_REQUEST_DELAY_MS = 0;

function usageError(message: string): CliError {
  return new CliError("TWMD_E_USAGE", message);
}

function printHelp(sessionPath: string): void {
  console.log(`
Usage:
  twmd login --cookie-file <path> [--loose-cookie]
  twmd whoami
  twmd logout
  twmd download --users <u1,u2> --out <dir> [--kinds image,video,gif] [--max-tweets N] [--concurrency N] [--retry N] [--user-retry N] [--user-delay-ms N] [--request-delay-ms N] [--json-report <file>] [--csv-report <file>] [--failures-report <file>]
  twmd download --users-file <file> --out <dir> [--kinds image,video,gif] [--max-tweets N] [--concurrency N] [--retry N] [--user-retry N] [--user-delay-ms N] [--request-delay-ms N] [--json-report <file>] [--csv-report <file>] [--failures-report <file>]

Exit Codes:
  0 success
  2 usage/arguments error
  3 auth/session error
  4 partial success (completed with failures)
  5 internal/runtime error

Session path:
  ${sessionPath}
`.trim());
}

function getOptionValue(args: string[], key: string): string | undefined {
  const index = args.indexOf(key);
  if (index < 0) {
    return undefined;
  }

  return args[index + 1];
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function parsePositiveIntegerOption(args: string[], key: string): number | undefined {
  const raw = getOptionValue(args, key);
  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw usageError(`Invalid value for ${key}: ${raw}`);
  }

  return parsed;
}

function parseNonNegativeIntegerOption(args: string[], key: string): number | undefined {
  const raw = getOptionValue(args, key);
  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw usageError(`Invalid value for ${key}: ${raw}`);
  }

  return parsed;
}

function parseKinds(args: string[]): MediaKind[] {
  const raw = getOptionValue(args, "--kinds");
  if (!raw) {
    return DEFAULT_MEDIA_KINDS;
  }

  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (items.length === 0) {
    throw usageError("--kinds cannot be empty.");
  }

  const allowed: MediaKind[] = ["image", "video", "gif"];
  const invalid = items.filter((item) => !allowed.includes(item as MediaKind));
  if (invalid.length > 0) {
    throw usageError(`Invalid media kind(s): ${invalid.join(", ")}`);
  }

  return items as MediaKind[];
}

async function parseUsers(args: string[]): Promise<string[]> {
  const usersRaw = getOptionValue(args, "--users");
  const usersFile = getOptionValue(args, "--users-file");

  if (usersRaw && usersFile) {
    throw usageError("--users and --users-file cannot be used together.");
  }

  if (!usersRaw && !usersFile) {
    throw usageError("One of --users or --users-file is required.");
  }

  if (usersRaw) {
    const users = usersRaw
      .split(",")
      .map((user) => user.trim().replace(/^@/, ""))
      .filter(Boolean);

    if (users.length === 0) {
      throw usageError("--users does not contain any valid usernames.");
    }

    return users;
  }

  const filePath = usersFile as string;
  const content = await readFile(filePath, "utf8");
  const users = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.replace(/^@/, ""));

  if (users.length === 0) {
    throw usageError("--users-file does not contain any valid usernames.");
  }

  return users;
}

function formatFailureDetails(details: FailureDetail[]): string {
  if (details.length === 0) {
    return "No failures recorded.";
  }

  return details
    .map((detail) => {
      const mediaPart = detail.media
        ? ` tweet=${detail.media.tweetId} media=${detail.media.mediaId}`
        : "";
      const codePart = detail.code ? ` code=${detail.code}` : "";
      const attemptsPart = detail.attempts ? ` attempts=${detail.attempts}` : "";
      return `${detail.timestamp} scope=${detail.scope} user=@${detail.username}${codePart}${attemptsPart}${mediaPart} message=${detail.message}`;
    })
    .join("\n");
}

async function writeReports(result: JobResult, args: string[]): Promise<void> {
  const jsonReportPath = getOptionValue(args, "--json-report");
  const csvReportPath = getOptionValue(args, "--csv-report");
  const failuresReportPath = getOptionValue(args, "--failures-report");

  if (jsonReportPath) {
    const jsonReport = createJsonReport(result);
    await writeFile(jsonReportPath, JSON.stringify(jsonReport, null, 2));
    console.log(`JSON report written: ${jsonReportPath}`);
  }

  if (csvReportPath) {
    const csvReport = createCsvReport(result);
    await writeFile(csvReportPath, csvReport);
    console.log(`CSV report written: ${csvReportPath}`);
  }

  if (failuresReportPath) {
    await writeFile(failuresReportPath, JSON.stringify(result.failureDetails, null, 2));
    console.log(`Failure details written: ${failuresReportPath}`);
  }
}

async function runLogin(args: string[]): Promise<void> {
  const cookieFilePath = getOptionValue(args, "--cookie-file");
  if (!cookieFilePath) {
    throw usageError("login requires --cookie-file <path>");
  }

  const looseCookieMode = hasFlag(args, "--loose-cookie");
  const cookieText = await readFile(cookieFilePath, "utf8");
  const store = createSessionStore({ appName: "tw-media-downloader" });
  const session = await loginWithCookies({
    store,
    cookieText,
    strict: !looseCookieMode
  });

  console.log("Login session saved.");
  console.log(`Cookies loaded: ${session.cookies.length}`);
  console.log(`Updated at: ${session.updatedAt}`);
  console.log(`Strict validation: ${looseCookieMode ? "off" : "on"}`);
  console.log(`Session file: ${store.path}`);
}

async function runWhoami(): Promise<void> {
  const store = createSessionStore({ appName: "tw-media-downloader" });
  const session = await whoami(store);

  if (!session.loggedIn) {
    const missing = session.missingCookieNames?.join(", ") ?? "unknown";
    throw new CliError(
      "TWMD_E_AUTH",
      `Not logged in or session is incomplete. Missing required cookies: ${missing}`
    );
  }

  console.log("Logged in.");
  console.log(`Session updated at: ${session.updatedAt}`);
  console.log(`Cookie count: ${session.cookieCount}`);
}

async function runLogout(): Promise<void> {
  const store = createSessionStore({ appName: "tw-media-downloader" });
  await logout(store);
  console.log("Session cleared.");
}

async function runDownload(args: string[]): Promise<JobResult> {
  const outputDir = getOptionValue(args, "--out");
  if (!outputDir) {
    throw usageError("download requires --out <dir>");
  }

  const users = await parseUsers(args);
  const mediaKinds = parseKinds(args);
  const maxTweetsPerUser = parsePositiveIntegerOption(args, "--max-tweets");
  const concurrency = parsePositiveIntegerOption(args, "--concurrency") ?? DEFAULT_CONCURRENCY;
  const retryCount = parseNonNegativeIntegerOption(args, "--retry") ?? DEFAULT_RETRY_COUNT;
  const userRetryCount =
    parseNonNegativeIntegerOption(args, "--user-retry") ?? DEFAULT_USER_RETRY_COUNT;
  const userDelayMs =
    parseNonNegativeIntegerOption(args, "--user-delay-ms") ?? DEFAULT_USER_DELAY_MS;
  const requestDelayMs =
    parseNonNegativeIntegerOption(args, "--request-delay-ms") ?? DEFAULT_REQUEST_DELAY_MS;

  const store = createSessionStore({ appName: "tw-media-downloader" });
  const job = runBatchJob({
    store,
    users,
    outputDir,
    mediaKinds,
    maxTweetsPerUser,
    concurrency,
    retryCount,
    userRetryCount,
    userDelayMs,
    perRequestDelayMs: requestDelayMs
  });

  let result: JobResult | undefined;

  while (true) {
    const current = await job.next();
    if (current.done) {
      result = current.value;
      break;
    }

    const event = current.value;
    const userPrefix = event.username ? `[@${event.username}] ` : "";

    if (event.progress) {
      const progress = event.progress;
      console.log(
        `${event.timestamp} ${event.type} ${userPrefix}${event.message} (total=${progress.total} downloaded=${progress.downloaded} failed=${progress.failed} skipped=${progress.skipped})`
      );
      continue;
    }

    console.log(`${event.timestamp} ${event.type} ${userPrefix}${event.message}`);
  }

  if (!result) {
    throw new CliError("TWMD_E_INTERNAL", "Batch job did not return a result.");
  }

  console.log("\nSummary");
  console.log(summarizeJobResult(result));

  if (result.failureDetails.length > 0) {
    console.log("\nFailure Details");
    console.log(formatFailureDetails(result.failureDetails));
  }

  await writeReports(result, args);
  return result;
}

function hasFinalFailures(result: JobResult): boolean {
  return result.failedUsers > 0 || result.failed > 0;
}

async function main(): Promise<void> {
  const store = createSessionStore({ appName: "tw-media-downloader" });
  const [, , command = "help", ...args] = process.argv;

  try {
    if (command === "help" || command === "--help" || command === "-h") {
      printHelp(store.path);
      return;
    }

    if (command === "login") {
      await runLogin(args);
      return;
    }

    if (command === "whoami") {
      await runWhoami();
      return;
    }

    if (command === "logout") {
      await runLogout();
      return;
    }

    if (command === "download") {
      const result = await runDownload(args);
      if (hasFinalFailures(result)) {
        console.warn("Completed with failures. See report output for details.");
        process.exitCode = EXIT_CODES.PARTIAL_FAILURE;
      }
      return;
    }

    throw usageError(`Unknown command: ${command}`);
  } catch (error) {
    const cliError = toCliError(error);
    console.error(`Error [${cliError.code}] (exit=${cliError.exitCode}): ${cliError.message}`);
    process.exitCode = cliError.exitCode;
  }
}

void main();
