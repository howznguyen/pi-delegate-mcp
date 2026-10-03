import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ALLOW_ALL, BATCH_MAX, DEFAULT_MODEL, PROGRESS_MS } from "../config.js";
import { PERMITTED, pickTools, READ_ONLY_TOOLS } from "../permissions.js";
import { resolveModel } from "../pi/models.js";
import { message } from "../pi/worker.js";
import { claimId, evictHistory, launch } from "../registry.js";
import { gated, json } from "./shared.js";

const spawnShape = {
  prompt: z.string().describe("The task for the pi agent"),
  model: z.string().optional().describe('Model as "provider/modelId", e.g. "openrouter/stealth/ox-alpha"'),
  cwd: z.string().optional().describe("Working directory for the agent"),
  id: z
    .string()
    .optional()
    .describe(
      'Your own session id for traceability, e.g. "search-audit-01". 1-64 chars of [A-Za-z0-9._:-], ' +
        "must start alphanumeric, must not already be in use. Defaults to a UUID.",
    ),
  label: z.string().optional().describe("Free-text note shown in `sessions`, e.g. what this delegate is for"),
  callbackTarget: z.string().optional().describe("Explicit completion callback target. Never inferred; for ChatGPT/Web2API this is the supervising conversation UUID."),
  tools: z
    .array(z.string())
    .optional()
    .describe(
      `Tool allowlist for this delegate. Default: ${READ_ONLY_TOOLS.join(", ")}. ` +
        `Permitted on this server: ${ALLOW_ALL ? "any" : [...PERMITTED].join(", ")}.`,
    ),
  extensions: z
    .boolean()
    .optional()
    .describe("Load pi extensions for this delegate. Off by default; they add startup cost and can misbehave."),
};

const taskShape = z.object({
  prompt: z.string().describe("The task for this delegate"),
  id: z.string().optional().describe("Session id for this task. Defaults to `idPrefix`-NN, or a UUID."),
  label: z.string().optional().describe("Free-text note for this task"),
  callbackTarget: z.string().optional().describe("Explicit completion callback target for this task"),
  model: z.string().optional().describe("Overrides the batch `model` for this task alone"),
  cwd: z.string().optional().describe("Overrides the batch `cwd` for this task alone"),
  tools: z.array(z.string()).optional().describe("Overrides the batch `tools` for this task alone"),
  extensions: z.boolean().optional(),
});

export function registerSpawn(server: McpServer): void {
  gated(
    server,
    "spawn",
    {
      description:
        "Delegate a task to a pi agent running in the background. Returns a sessionId immediately, so " +
        "nothing blocks. Poll with `status`, redirect with `steer`, answer its questions with `answer`. " +
        "Use this for anything that might take more than a minute.",
      inputSchema: spawnShape,
    },
    async (args) => {
      const w = await launch(args);
      return json({ sessionId: w.id, label: w.label, state: w.state, model: w.model, activeTools: w.activeTools });
    },
  );

  gated(
    server,
    "spawn_batch",
    {
      description:
        "Fan out several delegates in one call. Each task inherits the batch-level model, cwd, tools " +
        "and extensions unless it overrides them. The whole batch is validated before any delegate " +
        "starts, so a bad model name or a duplicate id fails everything instead of leaving half a " +
        "fan-out running. Poll the result with `sessions`, which reports all of them at once, rather " +
        "than one `status` per delegate.",
      inputSchema: {
        tasks: z.array(taskShape).min(1).max(BATCH_MAX).describe(`1 to ${BATCH_MAX} delegates to start`),
        model: z.string().optional().describe("Default model for every task in this batch"),
        cwd: z.string().optional().describe("Default working directory for every task in this batch"),
        tools: z.array(z.string()).optional().describe("Default tool allowlist for every task in this batch"),
        extensions: z.boolean().optional().describe("Default extensions setting for every task in this batch"),
        idPrefix: z
          .string()
          .optional()
          .describe('Names the tasks `<prefix>-01`, `<prefix>-02`, ... e.g. "audit" gives "audit-01"'),
      },
    },
    async ({ tasks, model, cwd, tools, extensions, idPrefix }) => {
      const width = Math.max(String(tasks.length).length, 2);
      const merged = tasks.map((t, i) => ({
        prompt: t.prompt,
        label: t.label,
        callbackTarget: t.callbackTarget,
        model: t.model ?? model,
        cwd: t.cwd ?? cwd,
        tools: t.tools ?? tools,
        extensions: t.extensions ?? extensions,
        id: t.id ?? (idPrefix ? `${idPrefix}-${String(i + 1).padStart(width, "0")}` : undefined),
      }));

      // Validate the batch up front. Every check here is cheap and deterministic, and a
      // half-started fan-out is the worst outcome: you pay for the delegates that launched
      // and still have to work out which ones did not.
      const seen = new Set<string>();
      for (const [i, t] of merged.entries()) {
        if (t.id) {
          if (seen.has(t.id))
            throw new Error(`tasks[${i}] reuses id "${t.id}" from earlier in the same batch. Ids must be unique.`);
          seen.add(t.id);
          claimId(t.id);
        }
        try {
          pickTools(t.tools);
          await resolveModel(t.model || DEFAULT_MODEL, t.cwd || process.cwd());
        } catch (e) {
          throw new Error(`tasks[${i}]${t.id ? ` (${t.id})` : ""}: ${message(e)}`);
        }
      }

      const started: Array<{ index: number; sessionId: string; label?: string; state: string; model?: string }> = [];
      const failures: Array<{ index: number; id?: string; error: string }> = [];
      await Promise.all(
        merged.map(async (t, index) => {
          try {
            const w = await launch(t);
            started.push({ index, sessionId: w.id, label: w.label, state: w.state, model: w.model });
          } catch (e) {
            failures.push({ index, id: t.id, error: message(e) });
          }
        }),
      );
      const byIndex = (a: { index: number }, b: { index: number }) => a.index - b.index;
      started.sort(byIndex);
      failures.sort(byIndex);

      return json({
        requested: merged.length,
        started: started.length,
        sessions: started,
        // Only reachable if a session dies during construction, after validation passed.
        ...(failures.length ? { failed: failures.length, failures } : {}),
        next: "Poll with `sessions` (one call covers the whole batch). `steer` and `abort` stay per session.",
      });
    },
  );

  gated(
    server,
    "run",
    {
      description:
        "Delegate a task to a pi agent and wait for the final answer. Blocks until done. " +
        "Prefer `spawn` for long work; this is for quick questions.",
      inputSchema: spawnShape,
    },
    async (args, extra) => {
      const w = await launch(args);
      // Progress notifications reset the MCP request timeout, which defaults to 60s.
      const token = extra?._meta?.progressToken;
      const ticker = token
        ? setInterval(() => {
            void extra
              ?.sendNotification?.({
                method: "notifications/progress",
                params: { progressToken: token, progress: w.turns, message: `${w.state}, turn ${w.turns}` },
              })
              ?.catch(() => {});
          }, PROGRESS_MS)
        : undefined;
      try {
        await w.run;
      } finally {
        if (ticker) clearInterval(ticker);
      }
      const snap = w.snapshot();
      evictHistory();
      return json(snap);
    },
  );
}
