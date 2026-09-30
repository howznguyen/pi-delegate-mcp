import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { HISTORY_LIMIT } from "../config.js";
import { all, forget, must } from "../registry.js";
import { gated, json } from "./shared.js";

export function registerControl(server: McpServer): void {
  gated(
    server,
    "status",
    {
      description:
        "Check a background pi session. Returns state, turn count, tools used, latest text, and any " +
        "pending questions the agent is waiting on. A non-empty `questions` array means it is blocked " +
        "until you call `answer`. `toolCalls` traces every tool the delegate ran, in order.",
      inputSchema: {
        sessionId: z.string(),
        verbose: z.boolean().optional().describe("Include tool results and call ids in the trace"),
      },
    },
    async ({ sessionId, verbose }) => json(must(sessionId).snapshot({ verbose })),
  );

  gated(
    server,
    "steer",
    {
      description:
        "Redirect a running pi agent mid-task. The message lands after its current tool call finishes, " +
        "before the next model call. Use this instead of aborting when the agent is going the wrong way.",
      inputSchema: { sessionId: z.string(), message: z.string() },
    },
    async ({ sessionId, message }) => json(await must(sessionId).steer(message)),
  );

  gated(
    server,
    "answer",
    {
      description:
        "Answer a question raised by a pi agent. Get `requestId` from `status`. Only pi extensions " +
        "can ask, so questions appear only for delegates spawned with `extensions: true`; the " +
        "MCP adapter's tool-approval and elicitation prompts are the usual source. A delegate " +
        "waiting on one is blocked until you answer it.",
      inputSchema: {
        sessionId: z.string(),
        requestId: z.string(),
        value: z.union([z.string(), z.boolean()]).describe("Chosen option, text, or boolean for a confirm"),
      },
    },
    async ({ sessionId, requestId, value }) => json(must(sessionId).answer(requestId, value)),
  );

  gated(
    server,
    "follow_up",
    {
      description:
        "Send another prompt to a delegate that has already finished, keeping everything it read " +
        "and said. Use this instead of spawning a fresh delegate and re-explaining the task: the " +
        "session still holds its own context, which yours never had to absorb. Returns immediately; " +
        "poll with `status` as usual. For a delegate that is still working, use `steer` instead.",
      inputSchema: {
        sessionId: z.string(),
        prompt: z.string().describe("The next turn for this delegate"),
      },
    },
    async ({ sessionId, prompt }) => json(must(sessionId).followUp(prompt)),
  );

  gated(
    server,
    "abort",
    {
      description: "Stop a running pi session. Partial output stays readable via `status`.",
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => json(await must(sessionId).abort()),
  );

  gated(
    server,
    "sessions",
    {
      description:
        "List pi sessions held by this server, running and finished. Finished ones stay readable for " +
        `review until evicted (keeps the newest ${HISTORY_LIMIT}).`,
      inputSchema: {
        state: z.string().optional().describe("Filter by state: starting, running, done, aborted, error"),
        verbose: z.boolean().optional().describe("Include full text and tool calls"),
      },
    },
    async ({ state, verbose }) => {
      const snaps = all().map((w) => w.snapshot());
      const filtered = state ? snaps.filter((s) => s.state === state) : snaps;
      const list = verbose
        ? filtered
        : filtered.map((s) => ({
            sessionId: s.sessionId,
            label: s.label,
            state: s.state,
            model: s.model,
            turns: s.turns,
            startedAt: s.startedAt,
            finishedAt: s.finishedAt,
            pendingQuestions: s.questions.length,
          }));
      return json({ count: list.length, sessions: list });
    },
  );

  gated(
    server,
    "forget",
    {
      description: "Drop a finished session from the review history, freeing its id for reuse.",
      inputSchema: { sessionId: z.string() },
    },
    async ({ sessionId }) => {
      const w = must(sessionId);
      if (w.isActive)
        throw new Error(`Session ${sessionId} is still ${w.state}. Call abort first.`);
      w.dispose();
      forget(sessionId);
      return json({ forgotten: sessionId });
    },
  );
}
