import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleInject, parseInjectBody, type InjectDeps } from "../src/ui/services/inject.ts";

const telegram = { token: "bot-token", allowedUserIds: [42, 43] };

function makeDeps(overrides: Partial<InjectDeps> = {}) {
  const sent: Array<{ token: string; chatId: number; text: string }> = [];
  const deps: InjectDeps = {
    run: async () => ({ stdout: "  hello from claude  ", exitCode: 0 }),
    peekSession: async () => ({ sessionId: "11111111-1111-4111-8111-111111111111" }),
    telegram,
    sendTelegram: async (token, chatId, text) => {
      sent.push({ token, chatId, text });
    },
    ...overrides,
  };
  return { deps, sent };
}

describe("parseInjectBody", () => {
  it("rejects a missing or blank message", () => {
    assert.equal(parseInjectBody({}), null);
    assert.equal(parseInjectBody(null), null);
    assert.equal(parseInjectBody({ message: "   " }), null);
    assert.equal(parseInjectBody({ message: 7 }), null);
  });

  it("trims the message and defaults forward to true", () => {
    assert.deepEqual(parseInjectBody({ message: "  hi  " }), { message: "hi", forward: true });
  });

  it("only a strict boolean false disables forwarding", () => {
    assert.equal(parseInjectBody({ message: "hi", forward: false })?.forward, false);
    assert.equal(parseInjectBody({ message: "hi", forward: true })?.forward, true);
    assert.equal(parseInjectBody({ message: "hi", forward: "false" })?.forward, true);
    assert.equal(parseInjectBody({ message: "hi", forward: 0 })?.forward, true);
  });
});

describe("handleInject forward flag", () => {
  it("forwards the trimmed reply to the first allowed Telegram user by default", async () => {
    const { deps, sent } = makeDeps();
    await handleInject({ message: "hi", forward: true }, deps);
    assert.deepEqual(sent, [{ token: "bot-token", chatId: 42, text: "hello from claude" }]);
  });

  it("does not forward when forward is false, but still returns the reply", async () => {
    const { deps, sent } = makeDeps();
    const res = await handleInject({ message: "hi", forward: false }, deps);
    assert.deepEqual(sent, []);
    assert.equal(res.ok, true);
    assert.equal(res.result, "  hello from claude  ");
    assert.equal(res.exitCode, 0);
  });

  it("does not forward when Telegram is not configured or the reply is empty", async () => {
    const noToken = makeDeps({ telegram: { token: "", allowedUserIds: [42] } });
    await handleInject({ message: "hi", forward: true }, noToken.deps);
    assert.deepEqual(noToken.sent, []);

    const noUsers = makeDeps({ telegram: { token: "bot-token", allowedUserIds: [] } });
    await handleInject({ message: "hi", forward: true }, noUsers.deps);
    assert.deepEqual(noUsers.sent, []);

    const empty = makeDeps({ run: async () => ({ stdout: "   ", exitCode: 0 }) });
    await handleInject({ message: "hi", forward: true }, empty.deps);
    assert.deepEqual(empty.sent, []);
  });

  it("a Telegram send failure does not fail the inject call", async () => {
    const { deps } = makeDeps({ sendTelegram: async () => { throw new Error("telegram down"); } });
    const res = await handleInject({ message: "hi", forward: true }, deps);
    assert.equal(res.ok, true);
  });
});

describe("handleInject sessionId", () => {
  it("returns the main session id from peekSession", async () => {
    const { deps } = makeDeps();
    const res = await handleInject({ message: "hi", forward: false }, deps);
    assert.equal(res.sessionId, "11111111-1111-4111-8111-111111111111");
  });

  it("returns null when there is no session yet", async () => {
    const { deps } = makeDeps({ peekSession: async () => null });
    const res = await handleInject({ message: "hi", forward: false }, deps);
    assert.equal(res.sessionId, null);
  });

  it("returns null when the session row has no sessionId or peekSession throws", async () => {
    const missing = makeDeps({ peekSession: async () => ({}) });
    assert.equal((await handleInject({ message: "hi", forward: false }, missing.deps)).sessionId, null);

    const throwing = makeDeps({ peekSession: async () => { throw new Error("unreadable session.json"); } });
    const res = await handleInject({ message: "hi", forward: false }, throwing.deps);
    assert.equal(res.ok, true);
    assert.equal(res.sessionId, null);
  });

  it("passes the parsed message to the runner", async () => {
    const seen: string[] = [];
    const { deps } = makeDeps({ run: async (m) => { seen.push(m); return { stdout: "ok", exitCode: 0 }; } });
    await handleInject({ message: "do the thing", forward: false }, deps);
    assert.deepEqual(seen, ["do the thing"]);
  });
});

describe("server wiring", () => {
  it("the /api/inject route delegates to the tested helpers", () => {
    const src = readServerSource();
    assert.match(src, /import \{ handleInject, parseInjectBody \} from "\.\/services\/inject";/);
    assert.match(src, /const parsed = parseInjectBody\(await req\.json\(\)\);/);
    assert.match(src, /await handleInject\(parsed, \{/);
    assert.match(src, /peekSession: \(\) => peekSession\(\),/);
  });
});

function readServerSource(): string {
  return readFileSync(new URL("../src/ui/server.ts", import.meta.url), "utf8");
}
