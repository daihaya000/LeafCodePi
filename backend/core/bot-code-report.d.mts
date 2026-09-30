export function buildBotCodeReportContent(input: {
  requestId: string;
  /** Request text already bounded by the caller. */
  truncatedRequest: string;
  result: unknown;
  codeTaskId: string | null | undefined;
  /** Room turn prompt; present only for Room-origin requests. */
  roomPrefix?: string;
  stoppedByUser?: boolean;
  /** Truthy for Goal Loop runs. */
  goalLoop?: unknown;
}): string;
