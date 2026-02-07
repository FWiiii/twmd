export const EXIT_CODES = {
  SUCCESS: 0,
  USAGE: 2,
  AUTH: 3,
  PARTIAL_FAILURE: 4,
  INTERNAL: 5
} as const;

export type CliErrorCode =
  | "TWMD_E_USAGE"
  | "TWMD_E_AUTH"
  | "TWMD_E_PARTIAL"
  | "TWMD_E_INTERNAL";

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: number;

  constructor(code: CliErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "CliError";

    if (code === "TWMD_E_USAGE") {
      this.exitCode = EXIT_CODES.USAGE;
      return;
    }

    if (code === "TWMD_E_AUTH") {
      this.exitCode = EXIT_CODES.AUTH;
      return;
    }

    if (code === "TWMD_E_PARTIAL") {
      this.exitCode = EXIT_CODES.PARTIAL_FAILURE;
      return;
    }

    this.exitCode = EXIT_CODES.INTERNAL;
  }
}

function isNodeLikeError(error: unknown): error is { code?: string; message?: string } {
  return typeof error === "object" && error !== null;
}

function toMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }

  const message = toMessage(error);
  const lower = message.toLowerCase();

  if (
    lower.includes("unknown command") ||
    lower.includes("requires --") ||
    lower.includes("invalid value") ||
    lower.includes("cannot be used together") ||
    lower.includes("is required")
  ) {
    return new CliError("TWMD_E_USAGE", message);
  }

  if (
    lower.includes("missing required cookies") ||
    lower.includes("session is not available") ||
    lower.includes("not logged in") ||
    lower.includes("login first")
  ) {
    return new CliError("TWMD_E_AUTH", message);
  }

  if (
    lower.includes("playwright") &&
    (lower.includes("executable doesn't exist") ||
      lower.includes("browser has not been found") ||
      lower.includes("please run the following command"))
  ) {
    return new CliError(
      "TWMD_E_USAGE",
      `${message}\nHint: run 'npx playwright install chromium' before downloading media.`
    );
  }

  if (isNodeLikeError(error)) {
    const code = error.code;
    if (code === "ENOENT") {
      return new CliError("TWMD_E_USAGE", `File not found: ${message}`);
    }

    if (code === "EACCES" || code === "EPERM" || code === "EISDIR" || code === "ENOTDIR") {
      return new CliError("TWMD_E_INTERNAL", `File system error: ${message}`);
    }
  }

  return new CliError("TWMD_E_INTERNAL", message);
}
