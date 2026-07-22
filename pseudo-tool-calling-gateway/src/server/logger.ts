/**
 * Structured logging — PRD §7.2.
 *
 * One line per request milestone, parseable fields. Levels controlled by
 * GATEWAY_LOG_LEVEL (debug|info|warn|error). Defaults to info.
 *
 *   level=info msg=request protocol=anthropic model=gpt-5.6-luna tools=6 ...
 *   level=info msg=upstream status=200 ttft=820ms total=4100ms
 *   level=info msg=parse tool_call=yes tool=read repair=brace_balance
 *   level=info msg=response protocol=anthropic stop=tool_use
 */

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const configuredRaw = (process.env.GATEWAY_LOG_LEVEL ?? "info").toLowerCase();
const configured = (configuredRaw in ORDER ? configuredRaw : "info") as Level;

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[configured]) return;
  const parts = [`level=${level}`, `msg=${msg}`];
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      const val = typeof v === "string" ? v : JSON.stringify(v);
      parts.push(`${k}=${val}`);
    }
  }
  const line = parts.join(" ");
  const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
  stream.write(line + "\n");
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
};
