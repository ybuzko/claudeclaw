// Read only the bytes appended to one Claude session transcript during a spawn attempt.
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { sanitizeProjectSlug } from "./sessionFiles";

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  requests: number;
};

export type TurnUsage = ModelUsage & {
  provider: "anthropic";
  durationMs: number;
  model: string | null;
  modelUsage: Record<string, ModelUsage>;
  basis: "transcript" | "result_json";
  session: { costUsd: number | null; numTurns: number | null; durationApiMs: number | null };
};

export type TranscriptSnapshot = { path: string; offset: number; identity: string | null; readable: boolean };
export type TranscriptUsage = { modelUsage: Record<string, ModelUsage>; requests: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function token(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function identity(stats: { dev: number; ino: number }): string {
  return `${stats.dev}:${stats.ino}`;
}

export function transcriptPath(workspace: string, sessionId: string, env: NodeJS.ProcessEnv): string {
  const root = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || homedir(), ".claude");
  return path.join(root, "projects", sanitizeProjectSlug(workspace), `${sessionId}.jsonl`);
}

/** A fresh Claude invocation discovers its session ID from stream-json after it starts. */
export function freshTranscriptSnapshot(workspace: string, sessionId: string, env: NodeJS.ProcessEnv): TranscriptSnapshot {
  return { path: transcriptPath(workspace, sessionId, env), offset: 0, identity: null, readable: true };
}

/** Capture the exact file and byte offset immediately before spawning Claude. */
export async function snapshotTranscript(workspace: string, sessionId: string, env: NodeJS.ProcessEnv): Promise<TranscriptSnapshot> {
  const file = transcriptPath(workspace, sessionId, env);
  try {
    const stats = await stat(file);
    return { path: file, offset: stats.size, identity: identity(stats), readable: stats.isFile() };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { path: file, offset: 0, identity: null, readable: true };
    return { path: file, offset: 0, identity: null, readable: false };
  }
}

/** Returns null if the appended range cannot be read completely and trusted. */
export async function readTranscriptUsage(snapshot: TranscriptSnapshot): Promise<TranscriptUsage | null> {
  if (!snapshot.readable) return null;
  let file;
  try {
    file = await open(snapshot.path, "r");
    const stats = await file.stat();
    if (!stats.isFile() || stats.size < snapshot.offset ||
        (snapshot.identity !== null && identity(stats) !== snapshot.identity)) return null;
    const length = stats.size - snapshot.offset;
    const bytes = Buffer.alloc(length);
    let position = 0;
    while (position < length) {
      const { bytesRead } = await file.read(bytes, position, length - position, snapshot.offset + position);
      if (bytesRead === 0) return null;
      position += bytesRead;
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.length > 0 && !text.endsWith("\n")) return null;
    const modelUsage: Record<string, ModelUsage> = Object.create(null);
    const seen = new Set<string>();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let record: unknown;
      try { record = JSON.parse(line); } catch { return null; }
      if (!isRecord(record) || !isRecord(record.message) || record.message.role !== "assistant") continue;
      const message = record.message;
      if (typeof record.requestId !== "string" || !record.requestId ||
          typeof message.model !== "string" || !message.model || !isRecord(message.usage)) continue;
      if (seen.has(record.requestId)) continue;
      const usage = message.usage;
      const inputTokens = token(usage.input_tokens);
      const outputTokens = token(usage.output_tokens);
      const cacheReadInputTokens = token(usage.cache_read_input_tokens);
      const cacheCreationInputTokens = token(usage.cache_creation_input_tokens);
      if (inputTokens === null || outputTokens === null || cacheReadInputTokens === null || cacheCreationInputTokens === null) return null;
      seen.add(record.requestId);
      const entry = modelUsage[message.model] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, requests: 0 };
      entry.inputTokens += inputTokens;
      entry.outputTokens += outputTokens;
      entry.cacheReadInputTokens += cacheReadInputTokens;
      entry.cacheCreationInputTokens += cacheCreationInputTokens;
      entry.requests++;
      modelUsage[message.model] = entry;
    }
    return { modelUsage, requests: seen.size };
  } catch {
    return null;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Build the thinclaw usage contract; result JSON is a flagged fallback only. */
export function usageFromAttempt(result: Record<string, unknown> | null, transcript: TranscriptUsage | null, elapsedMs: number): TurnUsage | null {
  if (!transcript && !isRecord(result?.usage)) return null;
  const modelUsage: Record<string, ModelUsage> = transcript?.modelUsage ?? Object.create(null);
  if (!transcript && isRecord(result?.modelUsage)) {
    for (const [name, raw] of Object.entries(result.modelUsage)) {
      const m = isRecord(raw) ? raw : {};
      modelUsage[name] = {
        inputTokens: finiteNumber(m.inputTokens) ?? 0,
        outputTokens: finiteNumber(m.outputTokens) ?? 0,
        cacheReadInputTokens: finiteNumber(m.cacheReadInputTokens) ?? 0,
        cacheCreationInputTokens: finiteNumber(m.cacheCreationInputTokens) ?? 0,
        requests: 0,
      };
    }
  }
  let model: string | null = null;
  let best = -1;
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  for (const [name, entry] of Object.entries(modelUsage)) {
    if (entry.outputTokens > best) { model = name; best = entry.outputTokens; }
    if (transcript) {
      totals.inputTokens += entry.inputTokens;
      totals.outputTokens += entry.outputTokens;
      totals.cacheReadInputTokens += entry.cacheReadInputTokens;
      totals.cacheCreationInputTokens += entry.cacheCreationInputTokens;
    }
  }
  const fallback = isRecord(result?.usage) ? result.usage : {};
  return {
    provider: "anthropic",
    inputTokens: transcript ? totals.inputTokens : finiteNumber(fallback.input_tokens) ?? 0,
    outputTokens: transcript ? totals.outputTokens : finiteNumber(fallback.output_tokens) ?? 0,
    cacheReadInputTokens: transcript ? totals.cacheReadInputTokens : finiteNumber(fallback.cache_read_input_tokens) ?? 0,
    cacheCreationInputTokens: transcript ? totals.cacheCreationInputTokens : finiteNumber(fallback.cache_creation_input_tokens) ?? 0,
    requests: transcript ? transcript.requests : 0,
    durationMs: finiteNumber(result?.duration_ms) ?? elapsedMs,
    model,
    modelUsage,
    basis: transcript ? "transcript" : "result_json",
    session: {
      costUsd: finiteNumber(result?.total_cost_usd),
      numTurns: finiteNumber(result?.num_turns),
      durationApiMs: finiteNumber(result?.duration_api_ms),
    },
  };
}

/** Sum independent transcript attempts. Mixed or missing sources cannot be added safely. */
export function combineAttemptUsages(attempts: Array<TurnUsage | null>): TurnUsage | null {
  const available = attempts.filter((usage): usage is TurnUsage => usage !== null);
  if (available.length === 0) return null;
  const last = available[available.length - 1]!;
  if (available.length !== attempts.length || available.some((usage) => usage.basis !== "transcript")) {
    // Result JSON can be cumulative. Keep the final readable estimate and flag uncertainty.
    return {
      ...last,
      basis: "result_json",
      session: attempts[attempts.length - 1]?.session ?? { costUsd: null, numTurns: null, durationApiMs: null },
    };
  }
  const modelUsage: Record<string, ModelUsage> = Object.create(null);
  let durationMs = 0;
  let requests = 0;
  for (const usage of available) {
    durationMs += usage.durationMs;
    requests += usage.requests;
    for (const [name, entry] of Object.entries(usage.modelUsage)) {
      const target = modelUsage[name] ?? { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, requests: 0 };
      target.inputTokens += entry.inputTokens;
      target.outputTokens += entry.outputTokens;
      target.cacheReadInputTokens += entry.cacheReadInputTokens;
      target.cacheCreationInputTokens += entry.cacheCreationInputTokens;
      target.requests += entry.requests;
      modelUsage[name] = target;
    }
  }
  let model: string | null = null;
  let best = -1;
  const totals = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  for (const [name, entry] of Object.entries(modelUsage)) {
    totals.inputTokens += entry.inputTokens;
    totals.outputTokens += entry.outputTokens;
    totals.cacheReadInputTokens += entry.cacheReadInputTokens;
    totals.cacheCreationInputTokens += entry.cacheCreationInputTokens;
    if (entry.outputTokens > best) { best = entry.outputTokens; model = name; }
  }
  return { provider: "anthropic", ...totals, requests, durationMs, model, modelUsage, basis: "transcript", session: last.session };
}
