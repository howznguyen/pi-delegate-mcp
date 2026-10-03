import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { CallbackState, SessionState } from "./types.js";

export interface CompletionPayload {
  sessionId: string;
  label: string | undefined;
  terminalState: SessionState;
  finalText: string;
  error: string | undefined;
  startedAt: string;
  finishedAt: string;
  providerModel: string | undefined;
}

export interface CompletionCallback {
  deliver(target: string, payload: CompletionPayload, state: CallbackState): Promise<void>;
}

export function resultHash(payload: CompletionPayload): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
export function deliveryId(sessionId: string, hash: string): string {
  return `pi-delegate:${sessionId}:${hash.slice(0, 24)}`;
}
function textContent(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  return Array.isArray(content) ? content.filter((x) => x.type === "text").map((x) => x.text ?? "").join("\n") : "";
}

export class McpCompletionCallback implements CompletionCallback {
  constructor(
    private readonly url: string,
    private readonly tool = "chat_completion",
    private readonly targetArg = "conversation_id",
    private readonly messageArg = "message",
    private readonly verifyTool?: string,
  ) {}
  private async client(): Promise<{ client: Client; transport: SSEClientTransport }> {
    const transport = new SSEClientTransport(new URL(this.url));
    const client = new Client({ name: "pi-delegate-callback", version: "1.0.0" });
    await client.connect(transport);
    return { client, transport };
  }
  private message(payload: CompletionPayload, state: CallbackState): string {
    return ["[delegated-worker-completion]", `delivery_id: ${state.deliveryId}`,
      `result_sha256: ${state.resultHash}`, JSON.stringify(payload, null, 2)].join("\n");
  }
  private async verify(target: string, id: string): Promise<boolean> {
    if (!this.verifyTool) return false;
    const { client, transport } = await this.client();
    try {
      const result = await client.callTool({ name: this.verifyTool,
        arguments: { [this.targetArg]: target, offset: 0, limit: 500 } });
      return textContent(result).includes(id);
    } finally { await transport.close().catch(() => {}); }
  }
  async deliver(target: string, payload: CompletionPayload, state: CallbackState): Promise<void> {
    if (state.status === "delivered" || state.attempts > 0) return;
    state.attempts = 1;
    const { client, transport } = await this.client();
    try {
      await client.callTool({ name: this.tool, arguments: {
        [this.targetArg]: target, [this.messageArg]: this.message(payload, state), model: "auto",
      }});
      state.status = "delivered"; state.deliveredAt = new Date().toISOString(); state.error = undefined;
    } catch (e) {
      const seen = await this.verify(target, state.deliveryId).catch(() => false);
      if (seen) {
        state.status = "delivered"; state.deliveredAt = new Date().toISOString(); state.error = undefined;
      } else {
        state.status = "failed"; state.error = e instanceof Error ? e.message : String(e);
      }
    } finally { await transport.close().catch(() => {}); }
  }
}
export function callbackFromEnv(): CompletionCallback | undefined {
  const url = process.env.PI_DELEGATE_CALLBACK_MCP_URL;
  if (!url) return undefined;
  return new McpCompletionCallback(url,
    process.env.PI_DELEGATE_CALLBACK_MCP_TOOL || "chat_completion",
    process.env.PI_DELEGATE_CALLBACK_TARGET_ARG || "conversation_id",
    process.env.PI_DELEGATE_CALLBACK_MESSAGE_ARG || "message",
    process.env.PI_DELEGATE_CALLBACK_VERIFY_TOOL || undefined);
}
