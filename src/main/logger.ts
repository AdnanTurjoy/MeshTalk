import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

const levelOrder: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Field names whose values are never written to logs. */
const SENSITIVE_KEY =
  /pass(word|phrase)|secret|token|authorization|cookie|private_?key|api_?key|^pin$|^body$|^content$/i;
const MAX_DEPTH = 5;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[depth]';
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? '[redacted]' : redact(v, depth + 1),
      ]),
    );
  }
  return value;
}

export function parseLogLevel(input: string | undefined, fallback: LogLevel): LogLevel {
  return input && input in levelOrder ? (input as LogLevel) : fallback;
}

export interface LoggerOptions {
  level: LogLevel;
  sink: (line: string) => void;
  now?: () => Date;
}

export function createLogger({ level, sink, now = () => new Date() }: LoggerOptions): Logger {
  const write = (lvl: LogLevel, event: string, fields?: LogFields) => {
    if (levelOrder[lvl] < levelOrder[level]) return;
    const record = {
      ts: now().toISOString(),
      level: lvl,
      event,
      ...(redact(fields ?? {}) as LogFields),
    };
    sink(JSON.stringify(record));
  };
  return {
    debug: (e, f) => write('debug', e, f),
    info: (e, f) => write('info', e, f),
    warn: (e, f) => write('warn', e, f),
    error: (e, f) => write('error', e, f),
  };
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

/** JSON-lines file sink with a single rotated generation (`meshtalk.log.1`). */
export function fileSink(logsDir: string, alsoConsole: boolean): (line: string) => void {
  mkdirSync(logsDir, { recursive: true });
  const file = join(logsDir, 'meshtalk.log');
  if (existsSync(file) && statSync(file).size > MAX_LOG_BYTES) {
    renameSync(file, `${file}.1`);
  }
  return (line) => {
    try {
      appendFileSync(file, `${line}\n`);
    } catch {
      // Logging must never crash the app (e.g. disk full).
    }
    if (alsoConsole) console.log(line);
  };
}
