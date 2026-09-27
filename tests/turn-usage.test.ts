import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { combineAttemptUsages, freshTranscriptSnapshot, readTranscriptUsage, snapshotTranscript, subagentsDirFor, transcriptPath, usageFromAttempt } from "../src/turnUsage";

it("sums only appended assistant requests, first occurrence wins across models", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claudeclaw-usage-"));
  const env = { CLAUDE_CONFIG_DIR: path.join(root, "claude config") };
  const workspace = path.join(root, "project.with.dots");
  const sessionId = "00000000-0000-0000-0000-000000000001";
  const file = transcriptPath(workspace, sessionId, env);
  const assistant = (requestId: string, model: string, usage: Record<string, unknown>) =>
    JSON.stringify({ type: "assistant", requestId, message: { role: "assistant", model, usage } }) + "\n";
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, assistant("old", "old-model", { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 100, cache_creation_input_tokens: 100 }));
    const snapshot = await snapshotTranscript(workspace, sessionId, env);
    await appendFile(file,
      assistant("r1", "haiku", { input_tokens: 3, output_tokens: 9, cache_read_input_tokens: 5, cache_creation_input_tokens: 7 }) +
      assistant("r1", "haiku", { input_tokens: "bad duplicate", output_tokens: 999, cache_read_input_tokens: 999, cache_creation_input_tokens: 999 }) +
      assistant("r2", "sonnet", { input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 6, cache_creation_input_tokens: 8 }),
    );
    const transcript = await readTranscriptUsage(snapshot);
    const usage = usageFromAttempt({ duration_ms: 12, total_cost_usd: 1.2, num_turns: 99, duration_api_ms: 1234 }, transcript, 40);
    assert.deepEqual(JSON.parse(JSON.stringify(usage)), {
      provider: "anthropic", inputTokens: 5, outputTokens: 13, cacheReadInputTokens: 11, cacheCreationInputTokens: 15,
      requests: 2, durationMs: 12, model: "haiku",
      modelUsage: {
        haiku: { inputTokens: 3, outputTokens: 9, cacheReadInputTokens: 5, cacheCreationInputTokens: 7, requests: 1 },
        sonnet: { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 6, cacheCreationInputTokens: 8, requests: 1 },
      },
      basis: "transcript", malformedLines: 0, session: { costUsd: 1.2, numTurns: 99, durationApiMs: 1234 },
    });
    assert.match(file, /project-with-dots/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const childRecord = (requestId: string, model: string, outputTokens: number) => JSON.stringify({
  type: "assistant", requestId, isSidechain: true,
  message: { role: "assistant", model, usage: {
    input_tokens: 1, output_tokens: outputTokens, cache_read_input_tokens: 2, cache_creation_input_tokens: 3,
  } },
}) + "\n";

it("includes old and new subagent files, dedupes across files, and isolates the session path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claudeclaw-tree-"));
  const env = { CLAUDE_CONFIG_DIR: path.join(root, "claude config") };
  const workspace = path.join(root, "project.with.dots");
  const sessionId = "00000000-0000-0000-0000-000000000001";
  const main = transcriptPath(workspace, sessionId, env);
  const children = subagentsDirFor(main);
  try {
    await mkdir(children, { recursive: true });
    await writeFile(main, childRecord("old-main", "old", 100));
    await writeFile(path.join(children, "agent-old.jsonl"), childRecord("old-child", "old", 100));
    const otherSession = subagentsDirFor(transcriptPath(workspace, "00000000-0000-0000-0000-000000000002", env));
    await mkdir(otherSession, { recursive: true });
    await writeFile(path.join(otherSession, "agent-other.jsonl"), childRecord("other", "wrong-session", 999));

    const snapshot = await snapshotTranscript(workspace, sessionId, env);
    await appendFile(main, childRecord("r-main", "haiku", 10) + "\0".repeat(1300) + "{torn}\n");
    await appendFile(path.join(children, "agent-old.jsonl"), "\0".repeat(200) + "{torn}\n" + childRecord("r-old", "sonnet", 20));
    await writeFile(path.join(children, "agent-new.jsonl"),
      childRecord("r-main", "duplicate", 999) + childRecord("r-new", "opus", 30));

    const transcript = await readTranscriptUsage(snapshot);
    const usage = usageFromAttempt(null, transcript, 25);
    assert.equal(usage?.basis, "transcript");
    assert.equal(usage?.requests, 3);
    assert.equal(usage?.malformedLines, 2);
    assert.equal(usage?.outputTokens, 60);
    assert.equal(usage?.model, "opus");
    assert.deepEqual(Object.keys(usage!.modelUsage).sort(), ["haiku", "opus", "sonnet"]);
    assert.equal(usage?.modelUsage.duplicate, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reads a fresh session's main and child files from byte zero once its ID is reported", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claudeclaw-fresh-tree-"));
  const env = { CLAUDE_CONFIG_DIR: root };
  const sessionId = "00000000-0000-0000-0000-000000000001";
  const snapshot = freshTranscriptSnapshot(root, sessionId, env);
  try {
    await mkdir(snapshot.subagentsDir, { recursive: true });
    await writeFile(snapshot.path, childRecord("main", "haiku", 5));
    await writeFile(path.join(snapshot.subagentsDir, "agent-new.jsonl"), childRecord("child", "opus", 15));
    const usage = usageFromAttempt(null, await readTranscriptUsage(snapshot), 12);
    assert.equal(usage?.requests, 2);
    assert.equal(usage?.outputTokens, 20);
    assert.equal(usage?.model, "opus");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects a replaced or incomplete subagent file instead of returning partial usage", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claudeclaw-tree-"));
  const env = { CLAUDE_CONFIG_DIR: root };
  const sessionId = "00000000-0000-0000-0000-000000000001";
  const main = transcriptPath(root, sessionId, env);
  const children = subagentsDirFor(main);
  const old = path.join(children, "agent-old.jsonl");
  try {
    await mkdir(children, { recursive: true });
    await writeFile(main, "");
    await writeFile(old, childRecord("before", "sonnet", 10));
    const replaced = await snapshotTranscript(root, sessionId, env);
    await rename(old, `${old}.moved`);
    await writeFile(old, childRecord("after", "sonnet", 20));
    assert.equal(await readTranscriptUsage(replaced), null);
    const incomplete = await snapshotTranscript(root, sessionId, env);
    await writeFile(path.join(children, "agent-new.jsonl"), childRecord("new", "opus", 3).trimEnd());
    assert.equal(await readTranscriptUsage(incomplete), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("reports null without readable usage and flags result JSON fallback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "claudeclaw-usage-"));
  try {
    const snapshot = await snapshotTranscript(root, "00000000-0000-0000-0000-000000000001", { CLAUDE_CONFIG_DIR: root });
    assert.equal(await readTranscriptUsage(snapshot), null);
    assert.equal(usageFromAttempt(null, null, 10), null);
    const fallback = usageFromAttempt({ usage: { input_tokens: 9, output_tokens: 4 }, num_turns: 7 }, null, 10);
    assert.equal(fallback?.basis, "result_json");
    assert.equal(fallback?.malformedLines, null);
    assert.equal(fallback?.requests, 0);
    assert.equal(fallback?.session.numTurns, 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("sums transcript retries and keeps cumulative fallback estimates separate", () => {
  const first = usageFromAttempt({ num_turns: 3 }, {
    requests: 1,
    malformedLines: 1,
    modelUsage: { haiku: { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 4, cacheCreationInputTokens: 5, requests: 1 } },
  }, 10)!;
  const second = usageFromAttempt({ num_turns: 4 }, {
    requests: 1,
    malformedLines: 2,
    modelUsage: { sonnet: { inputTokens: 7, outputTokens: 11, cacheReadInputTokens: 13, cacheCreationInputTokens: 17, requests: 1 } },
  }, 20)!;
  const combined = combineAttemptUsages([first, second])!;
  assert.equal(combined.basis, "transcript");
  assert.equal(combined.requests, 2);
  assert.equal(combined.malformedLines, 3);
  assert.equal(combined.outputTokens, 14);
  assert.equal(combined.durationMs, 30);
  assert.equal(combined.model, "sonnet");
  assert.equal(combined.session.numTurns, 4);

  const fallback = usageFromAttempt({ usage: { output_tokens: 100 }, num_turns: 99 }, null, 30)!;
  const mixed = combineAttemptUsages([first, fallback])!;
  assert.equal(mixed.basis, "result_json");
  assert.equal(mixed.malformedLines, null);
  assert.equal(mixed.outputTokens, 100, "cumulative JSON must not be added to transcript totals");
  assert.equal(combineAttemptUsages([null, second])?.basis, "result_json");
  assert.equal(combineAttemptUsages([null, second])?.malformedLines, null);
  const timedOutCompact = combineAttemptUsages([first, null]);
  assert.equal(timedOutCompact?.basis, "result_json");
  assert.deepEqual(timedOutCompact?.session, { costUsd: null, numTurns: null, durationApiMs: null });
});
