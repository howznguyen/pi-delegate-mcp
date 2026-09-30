import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// No user config, credentials, or provider requests are needed for these regressions.
const dir = await mkdtemp(join(tmpdir(), "pi-delegate-regressions-"));
process.env.PI_DELEGATE_STATE_DIR = join(dir, "state");
delete process.env.PI_DELEGATE_ALLOW_WRITE;
delete process.env.PI_DELEGATE_ALLOW_TOOLS;
const { PiWorker } = await import("../dist/pi/worker.js");
const { Question } = await import("../dist/pi/ui.js");
const { pickTools } = await import("../dist/permissions.js");
const { publish, readAll, cleanup, STATE_DIR } = await import("../dist/statusline/state.js");

const assistant = (content, stopReason = "stop", errorMessage) => ({
  role: "assistant", content, stopReason, errorMessage,
});
const text = (value) => ({ type: "text", text: value });
const worker = new PiWorker({ cwd: dir, tools: [] });
try {
  assert.deepEqual(pickTools([]), []);
  assert.deepEqual(pickTools(), ["read", "grep", "find", "ls"]);
  assert.throws(() => pickTools(["bash"]), /blocked/);

  const complete = assistant([text("first"), { type: "thinking", thinking: "private" }, text("second")]);
  worker.onEvent({ type: "message_update", message: complete,
    assistantMessageEvent: { type: "text_end", content: "second" } });
  assert.equal(worker.lastText, "first\nsecond");
  worker.onEvent({ type: "message_end", message: complete });
  assert.equal(worker.lastText, "first\nsecond");

  // Pi can resolve prompt() normally while reporting provider failure in message_end.
  const run = async (messages, rejection) => {
    worker.track({ prompt: async () => {
      if (rejection) throw new Error(rejection);
      for (const message of messages) worker.onEvent({ type: "message_end", message });
    }, waitForIdle: async () => {} }, "test");
    await worker.run;
  };
  await run([assistant([], "error", "provider failed")]);
  assert.equal(worker.state, "error");
  assert.equal(worker.error, "provider failed");
  assert.equal(worker.lastText, "");
  await run([assistant([], "error", "retryable"), complete]);
  assert.equal(worker.state, "done");
  assert.equal(worker.error, undefined);
  assert.equal(worker.lastText, "first\nsecond");
  await run([], "follow-up failed");
  assert.equal(worker.lastText, "", "failed follow-up must not return stale success");

  // Cancellation must release an extension dialog before awaiting session.abort().
  const q = new Question("confirm", "approval");
  worker.questions.set(q.id, q);
  let finishPrompt, finishAbort;
  const prompt = new Promise((resolve) => { finishPrompt = resolve; });
  const abortReady = new Promise((resolve) => { finishAbort = resolve; });
  let abortCalls = 0;
  const session = { prompt: () => prompt, waitForIdle: async () => {},
    abort: async () => { abortCalls++; await q.promise; await abortReady; finishPrompt(); } };
  worker.session = session;
  worker.track(session, "approval");
  const abort = worker.abort();
  const repeatedAbort = worker.abort();
  assert.equal(worker.pendingQuestions().length, 0);
  assert.equal(await q.promise, undefined);
  assert.equal(worker.isActive, true);
  assert.equal(abortCalls, 1);
  assert.throws(() => worker.followUp("too soon"), /Use `steer`/);
  assert.equal(await worker.uiContext().input("late question"), undefined);
  finishAbort();
  await Promise.all([abort, repeatedAbort, worker.run]);
  assert.equal(worker.state, "aborted");
  assert.equal(worker.isActive, false);

  // Normal completion also removes abandoned dialogs from snapshots.
  const leftover = new Question("input", "leftover");
  worker.questions.set(leftover.id, leftover);
  await run([complete]);
  assert.equal(await leftover.promise, undefined);
  assert.equal(worker.pendingQuestions().length, 0);

  const stateWorker = { id: "test", cwd: dir, state: "done", turns: 0,
    questions: new Map(), startedAt: new Date().toISOString() };
  for (let i = 0; i < 3; i++) {
    stateWorker.turns = i;
    publish([stateWorker]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(readAll().find((s) => s.pid === process.pid).sessions[0].turns, i);
    assert.equal((await readdir(STATE_DIR)).filter((name) => name.endsWith(".tmp")).length, 0);
  }
  console.log("  OK -> empty tools, complete output, provider errors, cancellation and state publication");
} finally {
  cleanup();
  await rm(dir, { recursive: true, force: true });
}
