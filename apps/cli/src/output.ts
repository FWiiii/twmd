import type { FailureDetail, JobEvent, JobResult } from "@huangjz11/shared";
import { createJsonReport } from "./reporting.js";

export type OutputFormat = "text" | "json";

export interface OutputOptions {
  quiet: boolean;
  color: boolean;
  format: OutputFormat;
}

const ANSI = {
  reset: "\u001b[0m",
  gray: "\u001b[90m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  cyan: "\u001b[36m"
} as const;

function applyColor(text: string, color: keyof typeof ANSI, enabled: boolean): string {
  if (!enabled) {
    return text;
  }

  return `${ANSI[color]}${text}${ANSI.reset}`;
}

function emitJson(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(data ?? {})
  };

  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

function emitText(
  level: "info" | "warn" | "error",
  message: string,
  options: OutputOptions,
  data?: Record<string, unknown>
): void {
  const label =
    level === "error"
      ? applyColor("ERROR", "red", options.color)
      : level === "warn"
        ? applyColor("WARN", "yellow", options.color)
        : applyColor("INFO", "cyan", options.color);

  const suffix = data ? ` ${JSON.stringify(data)}` : "";
  const output = `[${label}] ${message}${suffix}`;

  if (level === "error") {
    console.error(output);
    return;
  }

  if (level === "warn") {
    console.warn(output);
    return;
  }

  console.log(output);
}

export function createOutputOptions(args: string[]): OutputOptions {
  let format: OutputFormat = "text";
  const formatInline = args.find((item) => item.startsWith("--output-format="));
  if (formatInline) {
    const value = formatInline.split("=")[1]?.trim();
    if (value === "json" || value === "text") {
      format = value;
    }
  }

  const outputFormatIndex = args.indexOf("--output-format");
  if (outputFormatIndex >= 0) {
    const value = args[outputFormatIndex + 1]?.trim();
    if (value === "json" || value === "text") {
      format = value;
    }
  }

  const quiet = args.includes("--quiet");
  const noColor = args.includes("--no-color");
  const color = format === "text" && !noColor && Boolean(process.stdout.isTTY);

  return {
    quiet,
    color,
    format
  };
}

export function parseOutputFormat(args: string[]): string | undefined {
  const formatInline = args.find((item) => item.startsWith("--output-format="));
  if (formatInline) {
    const raw = formatInline.split("=")[1];
    return raw === undefined ? "" : raw.trim();
  }

  const index = args.indexOf("--output-format");
  if (index >= 0) {
    const raw = args[index + 1];
    return raw === undefined ? "" : raw.trim();
  }

  return undefined;
}

export function stripGlobalFlags(args: string[]): string[] {
  const stripped: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];

    if (value === "--quiet" || value === "--no-color") {
      continue;
    }

    if (value === "--output-format") {
      index += 1;
      continue;
    }

    if (value.startsWith("--output-format=")) {
      continue;
    }

    stripped.push(value);
  }

  return stripped;
}

export function logInfo(options: OutputOptions, message: string, data?: Record<string, unknown>): void {
  if (options.quiet) {
    return;
  }

  if (options.format === "json") {
    emitJson("info", message, data);
    return;
  }

  emitText("info", message, options, data);
}

export function logWarn(options: OutputOptions, message: string, data?: Record<string, unknown>): void {
  if (options.quiet) {
    return;
  }

  if (options.format === "json") {
    emitJson("warn", message, data);
    return;
  }

  emitText("warn", message, options, data);
}

export function logError(options: OutputOptions, message: string, data?: Record<string, unknown>): void {
  if (options.format === "json") {
    emitJson("error", message, data);
    return;
  }

  emitText("error", message, options, data);
}

export function logJobEvent(options: OutputOptions, event: JobEvent): void {
  if (options.quiet) {
    return;
  }

  if (options.format === "json") {
    emitJson("info", "job_event", {
      event
    });
    return;
  }

  const userPrefix = event.username ? `[@${event.username}] ` : "";

  if (event.progress) {
    console.log(
      `${applyColor(event.timestamp, "gray", options.color)} ${event.type} ${userPrefix}${event.message} (total=${event.progress.total} downloaded=${event.progress.downloaded} failed=${event.progress.failed} skipped=${event.progress.skipped})`
    );
    return;
  }

  console.log(
    `${applyColor(event.timestamp, "gray", options.color)} ${event.type} ${userPrefix}${event.message}`
  );
}

export function logSummary(options: OutputOptions, result: JobResult, summaryText: string): void {
  if (options.quiet) {
    return;
  }

  if (options.format === "json") {
    emitJson("info", "job_summary", {
      report: createJsonReport(result)
    });
    return;
  }

  console.log(`\n${applyColor("Summary", "green", options.color)}`);
  console.log(summaryText);
}

export function logFailureDetails(options: OutputOptions, details: FailureDetail[], text: string): void {
  if (options.quiet || details.length === 0) {
    return;
  }

  if (options.format === "json") {
    emitJson("warn", "job_failures", {
      failures: details
    });
    return;
  }

  console.log(`\n${applyColor("Failure Details", "yellow", options.color)}`);
  console.log(text);
}
