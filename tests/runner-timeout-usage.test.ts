import assert from "node:assert/strict";
import { it } from "node:test";
import { terminateAndWaitForExit } from "../src/runner";

it("waits for a terminated child to finish before transcript capture", async () => {
  const signals: string[] = [];
  let finish!: () => void;
  const exited = new Promise<void>((resolve) => { finish = resolve; });
  const proc = {
    kill: (signal: "SIGTERM" | "SIGKILL") => {
      signals.push(signal);
      if (signal === "SIGTERM") setTimeout(finish, 10);
    },
    exited,
  };
  assert.equal(await terminateAndWaitForExit(proc, 100, 20), true);
  assert.deepEqual(signals, ["SIGTERM"]);
});

it("bounds the wait and escalates a child that does not exit", async () => {
  const signals: string[] = [];
  const proc = {
    kill: (signal: "SIGTERM" | "SIGKILL") => { signals.push(signal); },
    exited: new Promise<void>(() => {}),
  };
  const started = Date.now();
  assert.equal(await terminateAndWaitForExit(proc, 15, 15), false);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.ok(Date.now() - started < 250);
});
