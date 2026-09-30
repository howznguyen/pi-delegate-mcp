import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const dir = await mkdtemp(join(tmpdir(), "pi-delegate-integration-"));
const requests = [];
const http = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  requests.push(request);
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({
    id: "chatcmpl-test", object: "chat.completion.chunk", created: 1, model: request.model,
    choices: [{ index: 0, delta, finish_reason }],
  })}\n\n`);
  emit({ role: "assistant", content: "OK" });
  emit({}, "stop");
  res.end("data: [DONE]\n\n");
});
await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
const client = new Client({ name: "offline-integration", version: "1" });
try {
  const agentDir = join(dir, "agent");
  await mkdir(agentDir);
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: "test", defaultModel: "one", defaultThinkingLevel: "off", enabledModels: ["test/*"],
  }));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { test: {
    baseUrl: `http://127.0.0.1:${http.address().port}/v1`, api: "openai-completions", apiKey: "fake-key",
    models: ["one", "two"].map((id) => ({ id, name: id, reasoning: false, input: ["text"],
      contextWindow: 16000, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  } } }));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"],
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("PI_DELEGATE_") && key !== "PI_CODING_AGENT_DIR")), PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir,
      PI_DELEGATE_MODEL: "test/one", PI_DELEGATE_IGNORE_SCOPE: "1" } }));
  const raw = (name, args = {}) => client.callTool({ name, arguments: args });
  const call = async (name, args = {}) => {
    const result = await raw(name, args);
    assert.ok(!result.isError, result.content?.[0]?.text);
    return JSON.parse(result.content[0].text);
  };
  assert.equal((await raw("sessions")).isError, true, "init gate is enforced");
  await call("init", { cwd: dir });

  const first = await call("run", { cwd: dir, id: "default", prompt: "Reply OK", tools: [] });
  assert.equal(first.model, "test/one");
  assert.equal(first.lastText, "OK");
  assert.equal(first.state, "done");
  assert.deepEqual(first.activeTools, []);
  assert.equal(requests[0].tools?.length ?? 0, 0);

  const defaults = await call("run", { cwd: dir, prompt: "Reply OK" });
  assert.deepEqual(defaults.activeTools.toSorted(), ["read", "grep", "find", "ls"].toSorted());
  assert.equal(requests[1].tools.length, 4);
  assert.equal((await raw("run", { cwd: dir, prompt: "blocked", tools: ["bash"] })).isError, true);

  await call("forget", { sessionId: "default" });
  assert.equal((await raw("status", { sessionId: "default" })).isError, true);
  console.log("  OK -> real MCP + Pi SDK against local fake provider: default tools and explicit empty tools");
} finally {
  await client.close();
  await new Promise((resolve) => http.close(resolve));
  await rm(dir, { recursive: true, force: true });
}
