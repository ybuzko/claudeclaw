import { test, expect } from "bun:test";
import { parseTelegramState } from "../src/commands/telegram";

test("empty or missing input -> empty state", () => {
  const empty = { verboseChats: [], chatModels: {}, queueEnabledTopics: [] };
  expect(parseTelegramState(undefined)).toEqual(empty);
  expect(parseTelegramState({})).toEqual(empty);
  expect(parseTelegramState("nope")).toEqual(empty);
});

test("round-trips a valid state", () => {
  const state = {
    verboseChats: [-1003856225060, 42],
    chatModels: { "-1003856225060:7": "claude-haiku-4-5-20251001", "42": "claude-sonnet-4-6" },
    queueEnabledTopics: ["-1003856225060:7"],
  };
  expect(parseTelegramState(JSON.parse(JSON.stringify(state)))).toEqual(state);
});

test("drops malformed entries", () => {
  expect(parseTelegramState({
    verboseChats: [1, "2", 1.5, null],
    chatModels: { a: "claude-opus-4-7", b: 3, c: "" },
    queueEnabledTopics: ["x", 9],
  })).toEqual({
    verboseChats: [1],
    chatModels: { a: "claude-opus-4-7" },
    queueEnabledTopics: ["x"],
  });
});
