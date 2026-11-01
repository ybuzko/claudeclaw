import { test, expect } from "bun:test";
import { extractSendVideoDirectives } from "../src/commands/telegram";

// --- extractSendVideoDirectives: [send-video:...] parsing ---

test("no directive present -> passthrough", () => {
  const { cleanedText, videoPaths } = extractSendVideoDirectives("just a plain reply");
  expect(cleanedText).toBe("just a plain reply");
  expect(videoPaths).toEqual([]);
});

test("one directive -> stripped from text, path collected", () => {
  const { cleanedText, videoPaths } = extractSendVideoDirectives(
    "here you go [send-video:/tmp/clip.mp4]"
  );
  expect(cleanedText).toBe("here you go");
  expect(videoPaths).toEqual(["/tmp/clip.mp4"]);
});

test("multiple directives -> all stripped, all paths collected in order", () => {
  const { cleanedText, videoPaths } = extractSendVideoDirectives(
    "[send-video:/tmp/a.mp4] first\nsecond [send-video:/tmp/b.mp4]"
  );
  expect(cleanedText).toBe("first\nsecond");
  expect(videoPaths).toEqual(["/tmp/a.mp4", "/tmp/b.mp4"]);
});

test("case-insensitive directive matching", () => {
  const { cleanedText, videoPaths } = extractSendVideoDirectives(
    "[SEND-VIDEO:/tmp/clip.mp4] done"
  );
  expect(cleanedText).toBe("done");
  expect(videoPaths).toEqual(["/tmp/clip.mp4"]);
});

test("collapses trailing whitespace and blank lines left behind by removed directives", () => {
  const { cleanedText, videoPaths } = extractSendVideoDirectives(
    "line one   \n[send-video:/tmp/clip.mp4]\n\n\n\nline two"
  );
  expect(cleanedText).toBe("line one\n\nline two");
  expect(videoPaths).toEqual(["/tmp/clip.mp4"]);
});
