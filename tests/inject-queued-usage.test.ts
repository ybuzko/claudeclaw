import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

const sessionId = "11111111-2222-4333-8444-555555555555";

it("captures each queued inject turn's main and child usage from a fake Claude CLI", { timeout: 15_000 }, async () => {
  // Runner and session-manager paths are fixed at import time, so run them in
  // a child process whose cwd, HOME, config directory, and CLI are all isolated.
  const root = await mkdtemp(path.join(tmpdir(), "claudeclaw-inject-tree-"));
  const workspace = path.join(root, "project.with.dots");
  const bin = path.join(root, "bin");
  const configDir = path.join(root, "claude-config");
  const fakeClaude = path.join(bin, "claude");
  const harness = path.join(root, "harness.ts");
  try {
    await mkdir(workspace, { recursive: true });
    await mkdir(bin);
    await mkdir(path.join(workspace, ".claude", "claudeclaw"), { recursive: true });
    await writeFile(path.join(workspace, ".claude", "claudeclaw", "settings.json"), "{}\n");
    await writeFile(fakeClaude, `#!/usr/bin/env bun
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const sid = ${JSON.stringify(sessionId)};
const resumeAt = process.argv.indexOf("--resume");
const resume = resumeAt >= 0;
const turn = resume ? 2 : 1;
const base = join(process.env.CLAUDE_CONFIG_DIR, "projects", process.env.FAKE_PROJECT_SLUG);
const children = join(base, sid, "subagents");
mkdirSync(children, { recursive: true });
const record = (requestId, model, output) => JSON.stringify({
  type: "assistant", requestId,
  message: { role: "assistant", model,
    usage: { input_tokens: 1, output_tokens: output,
      cache_read_input_tokens: 2, cache_creation_input_tokens: 3 } },
}) + "\\n";
const malformed = turn === 1 ? "\\0".repeat(1300) + "{torn}\\n" : "";
appendFileSync(join(base, sid + ".jsonl"), record("main-" + turn, "haiku", 9 + turn) + malformed);
appendFileSync(join(children, "agent-existing.jsonl"),
  record("main-" + turn, "duplicate", 999) + malformed + record("child-" + turn, "opus", 19 + turn));
if (turn === 2) writeFileSync(join(children, "agent-new.jsonl"), record("new-2", "sonnet", 7));
appendFileSync(join(process.cwd(), "cli-calls.jsonl"), JSON.stringify({
  turn, resume, resumedId: resume ? process.argv[resumeAt + 1] : null,
}) + "\\n");
console.log(JSON.stringify({ type: "system", subtype: "init", session_id: sid }));
await Bun.sleep(50);
console.log(JSON.stringify({ type: "result", session_id: sid, result: "turn " + turn,
  usage: { input_tokens: 999, output_tokens: 999 }, num_turns: 100 + turn }));
`);
    await chmod(fakeClaude, 0o755);
    await writeFile(harness, `
import { handleInject } from ${JSON.stringify(new URL("../src/ui/services/inject.ts", import.meta.url).href)};
import { runUserMessage } from ${JSON.stringify(new URL("../src/runner.ts", import.meta.url).href)};
import { peekThreadSession } from ${JSON.stringify(new URL("../src/sessionManager.ts", import.meta.url).href)};
import { loadSettings } from ${JSON.stringify(new URL("../src/config.ts", import.meta.url).href)};

await loadSettings();
const deps = {
  run: (message: string, thread?: string) => runUserMessage("inject", message, thread),
  peekSession: async () => null,
  peekThreadSession,
  telegram: { token: "", allowedUserIds: [] },
};
const responses = await Promise.all([
  handleInject({ message: "first", forward: false, thread: "tg:queued:1" }, deps),
  handleInject({ message: "second", forward: false, thread: "tg:queued:1" }, deps),
]);
await Bun.write("responses.json", JSON.stringify(responses));
`);

    const proc = Bun.spawn([process.execPath, harness], {
      cwd: workspace,
      env: {
        ...process.env,
        HOME: root,
        XDG_CONFIG_HOME: path.join(root, "xdg"),
        CLAUDE_CONFIG_DIR: configDir,
        FAKE_PROJECT_SLUG: workspace.replace(/[/\\.]/g, "-"),
        PATH: `${bin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    assert.equal(exitCode, 0, `${stdout}\n${stderr}`);

    const responses = JSON.parse(await readFile(path.join(workspace, "responses.json"), "utf8"));
    assert.equal(responses.length, 2);
    assert.deepEqual(responses.map((r: any) => r.sessionId), [sessionId, sessionId]);
    assert.deepEqual(responses.map((r: any) => r.result), ["turn 1", "turn 2"]);
    assert.deepEqual(responses.map((r: any) => r.usage?.basis), ["transcript", "transcript"]);
    assert.deepEqual(responses.map((r: any) => r.usage?.malformedLines), [2, 0]);
    assert.deepEqual(responses.map((r: any) => r.usage?.requests), [2, 3]);
    assert.deepEqual(responses.map((r: any) => r.usage?.outputTokens), [30, 39]);
    assert.deepEqual(responses.map((r: any) => Object.keys(r.usage?.modelUsage ?? {}).sort()), [
      ["haiku", "opus"], ["haiku", "opus", "sonnet"],
    ]);
    assert.deepEqual(responses.map((r: any) => r.usage?.modelUsage?.opus?.outputTokens), [20, 21]);
    assert.deepEqual(responses.map((r: any) => r.usage?.session?.numTurns), [101, 102]);

    const calls = (await readFile(path.join(workspace, "cli-calls.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(calls, [
      { turn: 1, resume: false, resumedId: null },
      { turn: 2, resume: true, resumedId: sessionId },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
