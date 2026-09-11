export type LogLevel = "info" | "warn" | "error";

export function formatLogLine(level: LogLevel, message: string, at: Date = new Date()): string {
  return `[${at.toISOString()}] ${level.toUpperCase()} ${message}`;
}

export function log(level: LogLevel, message: string): void {
  console.log(formatLogLine(level, message));
}
