import type { FailureDetail, JobResult } from "@twmd/shared";

export interface DownloadReportSummary {
  totalUsers: number;
  succeededUsers: number;
  failedUsers: number;
  totalMedia: number;
  downloaded: number;
  failed: number;
  skipped: number;
  failureDetailsCount: number;
}

export interface DownloadReportJson {
  generatedAt: string;
  summary: DownloadReportSummary;
  failures: FailureDetail[];
}

function escapeCsvValue(value: string): string {
  if (value.includes(",") || value.includes("\n") || value.includes("\r") || value.includes('"')) {
    return `"${value.replace(/"/g, '""')}"`;
  }

  return value;
}

function toSummary(result: JobResult): DownloadReportSummary {
  return {
    totalUsers: result.totalUsers,
    succeededUsers: result.succeededUsers,
    failedUsers: result.failedUsers,
    totalMedia: result.totalMedia,
    downloaded: result.downloaded,
    failed: result.failed,
    skipped: result.skipped,
    failureDetailsCount: result.failureDetails.length
  };
}

export function createJsonReport(result: JobResult): DownloadReportJson {
  return {
    generatedAt: new Date().toISOString(),
    summary: toSummary(result),
    failures: result.failureDetails
  };
}

export function createCsvReport(result: JobResult): string {
  const header = [
    "record_type",
    "generated_at",
    "total_users",
    "succeeded_users",
    "failed_users",
    "total_media",
    "downloaded",
    "failed",
    "skipped",
    "failure_details_count",
    "scope",
    "username",
    "code",
    "attempts",
    "tweet_id",
    "media_id",
    "url",
    "target_path",
    "message",
    "timestamp"
  ];

  const generatedAt = new Date().toISOString();
  const summary = toSummary(result);

  const summaryRow = [
    "summary",
    generatedAt,
    String(summary.totalUsers),
    String(summary.succeededUsers),
    String(summary.failedUsers),
    String(summary.totalMedia),
    String(summary.downloaded),
    String(summary.failed),
    String(summary.skipped),
    String(summary.failureDetailsCount),
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    ""
  ];

  const failureRows = result.failureDetails.map((detail) => [
    "failure",
    generatedAt,
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    detail.scope,
    detail.username,
    detail.code ?? "",
    detail.attempts ? String(detail.attempts) : "",
    detail.media?.tweetId ?? "",
    detail.media?.mediaId ?? "",
    detail.media?.url ?? "",
    detail.media?.targetPath ?? "",
    detail.message,
    detail.timestamp
  ]);

  const lines = [header, summaryRow, ...failureRows].map((columns) =>
    columns.map((value) => escapeCsvValue(value)).join(",")
  );

  return `${lines.join("\n")}\n`;
}
