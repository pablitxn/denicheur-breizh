export interface LogEntry {
  readonly event: string;
  readonly [key: string]: unknown;
}

export interface Logger {
  info(entry: LogEntry): void;
  error(entry: LogEntry): void;
}

export const jsonLogger: Logger = {
  info(entry) {
    console.info(JSON.stringify(entry));
  },
  error(entry) {
    console.error(JSON.stringify(entry));
  },
};
