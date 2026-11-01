import { test, expect } from "bun:test";
import { parseSettings } from "../src/config";

test("timeouts.backgroundWait is unset by default", () => {
  expect(parseSettings({}).timeouts.backgroundWait).toBeUndefined();
});

test("timeouts.backgroundWait accepts positive minutes", () => {
  expect(parseSettings({ timeouts: { backgroundWait: 40 } }).timeouts.backgroundWait).toBe(40);
});

test("timeouts.backgroundWait ignores zero, negative and non-numeric values", () => {
  for (const backgroundWait of [0, -5, "40", null]) {
    expect(parseSettings({ timeouts: { backgroundWait } }).timeouts.backgroundWait).toBeUndefined();
  }
});
