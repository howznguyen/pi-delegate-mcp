import { randomUUID } from "node:crypto";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  type AgentSessionEvent,
  type ExtensionUIContext,
  type CreateAgentSessionResult,
} from "@earendil-works/pi-coding-agent";
import { AGENT_DIR } from "../config.js";
import { deliveryId, resultHash, type CompletionCallback, type CompletionPayload } from "../callback.js";
import type { CallbackState, Notice, SessionState, Snapshot, ToolCall, ToolCallSummary } from "../types.js";
import { resolveModel } from "./models.js";
import { getRuntime } from "./runtime.js";
import { clipArgs, flatten } from "./trace.js";
import { createUiContext, Question } from "./ui.js";

type AgentSession = CreateAgentSessionResult["session"];

const NOOP = (): void => {};

export interface WorkerOptions {
  id?: string | undefined;
  label?: string | undefined;
  cwd: string;
  model?: string | undefined;
  tools: string[];
  extensions?: boolean;
  callbackTarget?: string | undefined;
  callback?: CompletionCallback | undefined;
}

/**
 * One delegated pi session. Holds the live AgentSession in-process, which is what keeps
 * steering and questions available; a subprocess running `pi -p` can do neither.
 */
export class PiWorker {
  readonly id: string;
  readonly label: string | undefined;
  readonly cwd: string;
  readonly toolNames: string[];
  readonly startedAt: string;

  state: SessionState = "starting";
  turns = 0;
  lastText = "";
  model: string | undefined;
  activeTools: string[] | undefined;
  error: string | undefined;
  finishedAt: string | undefined;
  callbackState: CallbackState | undefined;

  readonly toolCalls: ToolCall[] = [];
  readonly notices: Notice[] = [];
  readonly questions = new Map<string, Question>();

  /** Resolves when the delegate stops, however it stops. Never rejects. */
  run: Promise<void> | undefined;
  /** Set by the registry so state reaches the status line on every transition. */
  onChange: (() => void) | undefined;

  private readonly extensionsEnabled: boolean;
  private readonly callbackTarget: string | undefined;
  private readonly callbackAdapter: CompletionCallback | undefined;
  private readonly modelSpec: string | undefined;
  private readonly openCalls = new Map<string, ToolCall>();
  private session: AgentSession | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor({ id, label, cwd, model, tools, extensions = false, callbackTarget, callback }: WorkerOptions) {
    this.id = id ?? randomUUID();
    this.label = label;
    this.cwd = cwd;
    this.modelSpec = model;
    this.toolNames = tools;
    this.extensionsEnabled = extensions;
    this.callbackTarget = callbackTarget;
    this.callbackAdapter = callback;
    this.startedAt = new Date().toISOString();
  }

  private uiContext(): ExtensionUIContext {
    return createUiContext({
      ask: (kind, title, detail, options) => {
        const q = new Question(kind, title, detail, options);
        this.questions.set(q.id, q);
        this.onChange?.();
        return q.promise;
      },
      notify: (message, type = "info") => {
        this.notices.push({ type, message, at: new Date().toISOString() });
      },
    });
  }

  async start(prompt: string): Promise<this> {
    const model = await resolveModel(this.modelSpec, this.cwd);

    // Third-party pi extensions start timers and sockets that outlive dispose() and then
    // throw against a stale ctx. A delegate does not need them.
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.cwd,
      agentDir: AGENT_DIR,
      noExtensions: !this.extensionsEnabled,
    });

    // The loader is lazy: getExtensions() returns nothing until reload() has run, so
    // without this `extensions: true` silently loads zero extensions and costs startup
    // time for nothing. A failure is not fatal, since a delegate with none still works.
    if (this.extensionsEnabled) {
      try {
        await resourceLoader.reload();
      } catch (e) {
        this.notices.push({
          type: "warning",
          message: `extensions failed to load: ${message(e)}`,
          at: new Date().toISOString(),
        });
      }
    }

    const { session } = await createAgentSession({
      cwd: this.cwd,
      modelRuntime: await getRuntime(),
      model,
      sessionManager: SessionManager.inMemory(),
      tools: this.toolNames,
      resourceLoader,
    });
    this.session = session;
    this.model = model ? `${model.provider}/${model.id}` : "(pi default)";
    this.activeTools = session.getActiveToolNames();

    this.unsubscribe = session.subscribe((ev) => this.onEvent(ev));
    try {
      await session.bindExtensions({ uiContext: this.uiContext(), mode: "rpc" });
    } catch {
      // Extensions are optional. A binding failure must not sink the run.
    }

    this.track(session, prompt);
    return this;
  }

  /**
   * Drive one prompt to completion and fold the outcome back into this worker. Shared by
   * `start` and `followUp` so a second turn behaves exactly like the first.
   */
  private track(session: AgentSession, prompt: string): void {
    this.state = "running";
    this.error = undefined;
    this.finishedAt = undefined;
    this.run = session
      .prompt(prompt)
      .then(() => session.waitForIdle())
      .then(() => {
        this.state = this.state === "aborted" ? "aborted" : "done";
      })
      .catch((e: unknown) => {
        this.state = "error";
        this.error = message(e);
      })
      .finally(() => {
        this.finishedAt = new Date().toISOString();
        // Unblock anything still waiting on an answer that will now never come.
        for (const q of this.questions.values()) q.resolve(undefined);
        this.onChange?.();
        return this.deliverCompletionCallback();
      });
  }

  /**
   * Send another prompt to a delegate that has already finished. pi keeps the session's
   * history in memory, so the delegate still remembers everything it read and said. This
   * is the difference between a conversation and re-explaining yourself to a fresh agent.
   */
  followUp(prompt: string): { sessionId: string; state: SessionState; turnsSoFar: number } {
    if (!this.session) throw new Error(`Session ${this.id} never started, nothing to follow up on.`);
    if (this.state === "running" || this.state === "starting")
      throw new Error(
        `Session ${this.id} is ${this.state}. Use \`steer\` to redirect a delegate that is still working.`,
      );
    this.track(this.session, prompt);
    this.onChange?.();
    return { sessionId: this.id, state: this.state, turnsSoFar: this.turns };
  }

  private onEvent(ev: AgentSessionEvent): void {
    switch (ev.type) {
      case "turn_start":
        this.turns++;
        this.onChange?.();
        break;

      case "tool_execution_start": {
        const call: ToolCall = {
          seq: this.toolCalls.length + 1,
          id: ev.toolCallId,
          name: ev.toolName,
          args: clipArgs(ev.args),
          state: "running",
          startedAt: Date.now(),
        };
        this.toolCalls.push(call);
        if (ev.toolCallId) this.openCalls.set(ev.toolCallId, call);
        break;
      }

      case "tool_execution_end": {
        // pi does not always echo the call id back, so fall back to the newest open call
        // of the same name rather than losing the timing entirely.
        const call =
          (ev.toolCallId ? this.openCalls.get(ev.toolCallId) : undefined) ??
          [...this.toolCalls].reverse().find((c) => c.state === "running" && c.name === ev.toolName);
        if (call) {
          call.state = ev.isError ? "error" : "ok";
          call.ms = Date.now() - (call.startedAt ?? Date.now());
          call.result = flatten(ev.result);
          delete call.startedAt;
          if (ev.toolCallId) this.openCalls.delete(ev.toolCallId);
        }
        break;
      }

      case "message_update":
        if (ev.assistantMessageEvent?.type === "text_end")
          this.lastText = ev.assistantMessageEvent.content ?? this.lastText;
        break;

      case "message_end":
        if (ev.message.role === "assistant") {
          const text = ev.message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("");
          if (text) this.lastText = text;
          if (ev.message.errorMessage) this.error = ev.message.errorMessage;
        }
        break;
    }
  }

  private async deliverCompletionCallback(): Promise<void> {
    if (!this.callbackTarget) return;
    if (!this.callbackAdapter) {
      this.callbackState = { status: "failed", target: this.callbackTarget,
        deliveryId: `pi-delegate:${this.id}:unconfigured`, resultHash: undefined, attempts: 0,
        deliveredAt: undefined, error: "callback target supplied but no callback adapter is configured" };
      this.onChange?.(); return;
    }
    if (this.callbackState?.status === "delivered" || (this.callbackState?.attempts ?? 0) > 0) return;
    const payload: CompletionPayload = {
      sessionId: this.id, label: this.label, terminalState: this.state, finalText: this.lastText,
      error: this.error, startedAt: this.startedAt,
      finishedAt: this.finishedAt ?? new Date().toISOString(), providerModel: this.model,
    };
    const hash = resultHash(payload);
    this.callbackState = { status: "pending", target: this.callbackTarget,
      deliveryId: deliveryId(this.id, hash), resultHash: hash, attempts: 0,
      deliveredAt: undefined, error: undefined };
    this.onChange?.();
    await this.callbackAdapter.deliver(this.callbackTarget, payload, this.callbackState);
    this.onChange?.();
  }

  pendingQuestions() {
    return [...this.questions.values()].map((q) => q.toJSON());
  }

  answer(requestId: string, value: string | boolean): { answered: string } {
    const q = this.questions.get(requestId);
    if (!q) throw new Error(`No pending question ${requestId} on session ${this.id}`);
    this.questions.delete(requestId);
    q.resolve(q.kind === "confirm" ? value === true || value === "true" : value);
    this.onChange?.();
    return { answered: requestId };
  }

  async steer(text: string): Promise<{ steered: true; queued: number }> {
    if (this.state !== "running" || !this.session)
      throw new Error(`Session ${this.id} is ${this.state}, cannot steer`);
    await this.session.steer(text);
    return { steered: true, queued: this.session.getSteeringMessages().length };
  }

  async abort(): Promise<{ aborted: true }> {
    this.state = "aborted";
    this.onChange?.();
    await this.session?.abort().catch(NOOP);
    return { aborted: true };
  }

  dispose(): void {
    this.unsubscribe?.();
    this.session?.dispose?.();
  }

  snapshot({ verbose = false }: { verbose?: boolean } = {}): Snapshot {
    const trace: Array<ToolCall | ToolCallSummary> = this.toolCalls.map((c) =>
      verbose ? c : { seq: c.seq, name: c.name, state: c.state, ms: c.ms, args: c.args },
    );
    return {
      sessionId: this.id,
      label: this.label,
      state: this.state,
      model: this.model,
      cwd: this.cwd,
      activeTools: this.activeTools,
      turns: this.turns,
      toolCalls: trace,
      lastText: this.lastText,
      questions: this.pendingQuestions(),
      notices: this.notices,
      error: this.error,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      callback: this.callbackState,
    };
  }
}

/** Errors reach us as `unknown`; this is the one place that decides how to read them. */
export function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
