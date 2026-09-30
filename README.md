```
██████╗ ██╗    ██████╗ ███████╗██╗     ███████╗ ██████╗  █████╗ ████████╗███████╗
██╔══██╗██║    ██╔══██╗██╔════╝██║     ██╔════╝██╔════╝ ██╔══██╗╚══██╔══╝██╔════╝
██████╔╝██║    ██║  ██║█████╗  ██║     █████╗  ██║  ███╗███████║   ██║   █████╗
██╔═══╝ ██║    ██║  ██║██╔══╝  ██║     ██╔══╝  ██║   ██║██╔══██║   ██║   ██╔══╝
██║     ██║    ██████╔╝███████╗███████╗███████╗╚██████╔╝██║  ██║   ██║   ███████╗
╚═╝     ╚═╝    ╚═════╝ ╚══════╝╚══════╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝   ╚═╝   ╚══════╝
                            ███╗   ███╗ ██████╗██████╗
                            ████╗ ████║██╔════╝██╔══██╗
                            ██╔████╔██║██║     ██████╔╝
                            ██║╚██╔╝██║██║     ██╔═══╝
                            ██║ ╚═╝ ██║╚██████╗██║
                            ╚═╝     ╚═╝ ╚═════╝╚═╝
```

[![npm](https://img.shields.io/npm/v/pi-delegate-mcp.svg)](https://www.npmjs.com/package/pi-delegate-mcp)
[![node](https://img.shields.io/node/v/pi-delegate-mcp.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/pi-delegate-mcp.svg)](./LICENSE)

MCP server that exposes the [pi](https://pi.dev) coding agent as a **delegable, steerable** worker.

Point Claude Code (or any MCP host) at it and delegate work to any of pi's ~38 providers
(DeepSeek, Grok, GLM, Kimi, Qwen, Codex, OpenRouter, local llama.cpp) with the sub-agent's
context staying out of your main conversation.

## What it's for

Your main harness runs on an expensive model, with a context window you care about. A lot of what
it does doesn't need that model, and actively damages that context: grepping a repo for every
call site, reading a 2000-line file to answer one question, auditing what a refactor left behind.

Hand that work to a delegate instead:

- **Cost.** The grunt work runs on DeepSeek, GLM, Kimi, Qwen, or a local llama.cpp. You pay
  frontier prices only for the reasoning that actually needs them.
- **Context.** The delegate reads the files on its own budget and returns a result. The 200 KB it
  read never enters your conversation.
- **Blast radius.** Delegates are read-only by default (`read, grep, find, ls`), enforced at
  session construction. A cheap model doing exploratory work cannot touch your tree unless you
  opt it in.

The delegate is always the pi agent. Codex, Grok, DeepSeek and the rest supply the _model_ behind
it; this is not a wrapper around their CLIs.

## Why pi, and not opencode or a CLI wrapper?

A delegate is only steerable if two channels stay open: you must be able to redirect it mid-task,
and it must be able to ask you something and block until you answer. Most ways of driving a coding
agent from another program close both.

|                             | `pi -p` / CLI wrappers | opencode SDK                         | this server                |
| --------------------------- | ---------------------- | ------------------------------------ | -------------------------- |
| Runs in-process             | no (subprocess)        | no (HTTP client to `opencode serve`) | yes (`createAgentSession`) |
| Redirect a running turn     | no                     | `abort` only                         | `steer`                    |
| Agent can ask you something | no (`ctx.hasUI` false) | not in the session API               | `status` → `answer` \*      |
| Model per call              | no                     | yes                                  | `model` argument           |

`pi -p` and `--mode json` set `ctx.hasUI = false`. A delegate started that way is fire-and-forget
by construction: it cannot raise a question, and you cannot redirect it.

opencode's SDK is a typed client for a **separate server process**: `createOpencode()` boots
`opencode serve` and talks HTTP to it. Clean design, but it means a second process to supervise,
and the session surface it exposes (`prompt`, `abort`, `revert`, `messages`) has no mid-turn
steering and no path for the agent to ask the caller anything.

pi ships `createAgentSession` as an embeddable library. This server holds the session object
in-process, so `session.steer()` can land a message after the current tool call and before the
next model call, and a synthetic `uiContext` catches the agent's questions and parks them for
`answer`. Nothing is shelled out; nothing has to be supervised.

\* Questions come from pi extensions, so that channel is open only for delegates spawned with
`extensions: true`. See [Web search and other extension tools](#web-search-and-other-extension-tools).

(The table compares the _delegation channel_, not sandboxing; opencode has its own permission
config. See [Read-only by default](#read-only-by-default) for what this server does and does not
enforce.)

## Tools

| Tool          | Purpose                                                                                                                                 |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `init`        | **Call first.** Reports reachable models, permitted tools, and how to drive a delegate. Every other tool refuses until it has run once. |
| `spawn`       | Delegate in the background. Returns `sessionId` immediately. **Use this by default.**                                                   |
| `spawn_batch` | Fan out up to 10 delegates in one call. Validated as a batch, so nothing starts if one task is bad.                                     |
| `run`         | Delegate and block until done. For quick questions only.                                                                                |
| `status`      | State, turns, tools used, latest text, and pending questions.                                                                           |
| `steer`       | Redirect a running agent. Lands after its current tool call.                                                                            |
| `follow_up`   | Give a finished delegate another turn. It keeps everything it read, so you do not re-explain the task.                                   |
| `answer`      | Answer a question surfaced by `status`. Only reachable with `extensions: true`, since only extensions can ask.                           |
| `abort`       | Stop a session; partial output stays readable.                                                                                          |
| `models`      | List models this delegate may use.                                                                                                      |
| `sessions`    | List sessions, running and finished. Filter by `state`, expand with `verbose`.                                                          |
| `forget`      | Drop a finished session from history, freeing its id.                                                                                   |

## Install

Requires Node.js 22.19+ and a working [pi](https://pi.dev) install that has been logged in once
(`pi`, then `/login`).

### Claude Code

```bash
claude mcp add pi -e PI_DELEGATE_MODEL=openrouter/stealth/ox-alpha -- npx -y pi-delegate-mcp
```

### Any MCP host, via `.mcp.json`

```json
{
  "mcpServers": {
    "pi": {
      "command": "npx",
      "args": ["-y", "pi-delegate-mcp"],
      "env": { "PI_DELEGATE_MODEL": "openrouter/stealth/ox-alpha" },
      "timeout": 1800000
    }
  }
}
```

`npx` resolves the package on every launch. To pin it, install globally and call the binary
directly:

```bash
npm install -g pi-delegate-mcp
```

```json
{ "mcpServers": { "pi": { "command": "pi-delegate-mcp", "timeout": 1800000 } } }
```

Keep the server key short, since it prefixes every tool name (`mcp__pi__spawn`).

### From source

```bash
git clone https://github.com/howznguyen/pi-delegate-mcp && cd pi-delegate-mcp
npm install && npm run build && npm link
```

## First run

Ask your agent to delegate something. It calls `init` once to learn what this server can reach,
then `spawn`:

```json
{ "id": "audit-01", "label": "who still imports onnxruntime",
  "prompt": "Search this repo for anything still importing onnxruntime and list the files.",
  "cwd": "/path/to/repo" }
```

```json
{ "sessionId": "audit-01", "state": "running", "model": "opencode-go/deepseek-v4-flash",
  "activeTools": ["read", "grep", "find", "ls"] }
```

`spawn` returns immediately. Poll with `status` for the ordered tool trace and the answer, or
`sessions` when several are in flight. If `init` fails, it says exactly what is missing: pi not
installed, no provider logged in, or a model scope that matches nothing.

Model names in the examples below are illustrative. Run `models` to see what your own pi install
can actually reach.

## Traceability

`spawn` and `run` both accept your own `id` and a free-text `label`:

```json
{
  "id": "search-audit-01",
  "label": "what ONNX removal left behind",
  "prompt": "...",
  "model": "opencode-go/deepseek-v4-flash"
}
```

Ids are `[A-Za-z0-9._:-]`, 1-64 chars, must start alphanumeric, and must be unique among live
sessions. Omit for a UUID.

Finished sessions stay readable via `status` and `sessions` instead of vanishing, so you can go
back and check what a delegate actually did. The newest `PI_DELEGATE_HISTORY` (default 50) are
kept; `forget` drops one early.

`status` returns an ordered `toolCalls` trace: every tool the delegate ran, with arguments and
timing. Add `verbose: true` for call ids and results:

```json
{
  "seq": 1,
  "id": "call_467b4bb4…",
  "name": "bash",
  "state": "ok",
  "ms": 10,
  "args": "{\"command\":\"echo hello-trace\"}",
  "result": "hello-trace\n"
}
```

Arguments and results are clipped (`PI_DELEGATE_TRACE_ARGS`, `PI_DELEGATE_TRACE_RESULT`) with the
dropped length recorded, so one `read` of a large file cannot flood your context.

## Giving a delegate another turn

A finished delegate is not spent. pi keeps its session in memory, so `follow_up` re-prompts
the same agent with everything it already read still in context:

```json
{ "sessionId": "search-audit-01", "prompt": "Now check whether the build files reference it too" }
```

```
{ "sessionId": "search-audit-01", "state": "running", "turnsSoFar": 1 }
```

The delegate picks up where it left off. It still holds the files it read on the first turn, so
the second question costs one model call rather than a fresh session re-reading the repository.

This is the cheap way to have a conversation with a delegate. Spawning a fresh one means
re-explaining the task and paying for it to re-read the same files, and its answer arrives
with none of the reasoning that led there.

`follow_up` refuses a delegate that is still working, because redirecting one mid-task is
what `steer` is for. The two are not interchangeable: `steer` lands between tool calls on a
running agent, `follow_up` starts a new turn on a finished one.

## Fanning out

`spawn_batch` starts a whole batch in one call. Tasks inherit the batch-level `model`, `cwd`,
`tools` and `extensions`, and override them individually where they need to:

```json
{
  "idPrefix": "audit",
  "model": "opencode-go/deepseek-v4-flash",
  "cwd": "/repo",
  "tools": ["ls"],
  "tasks": [
    { "prompt": "What still imports onnxruntime?", "label": "imports" },
    { "prompt": "Which build files still reference ONNX?", "label": "build" },
    {
      "prompt": "Any ONNX model files left on disk?",
      "label": "artifacts",
      "model": "opencode-go/ox-alpha-free"
    }
  ]
}
```

That names them `audit-01`, `audit-02`, `audit-03` and returns in a few milliseconds, since
launching a delegate does not wait for it to think.

The batch is validated before anything starts: id format, ids duplicated inside the batch, ids
already live, blocked tools, and every model name. One bad task fails the call and launches
nothing. Half a fan-out is the worst outcome, because you pay for the delegates that did start
and still have to work out which ones did not.

Poll the whole batch with one `sessions` call rather than one `status` per delegate. Drop to
`status` only for the delegate you actually want to read. `steer` and `abort` stay per session.

## Picking a model per call

`model` on any call overrides `PI_DELEGATE_MODEL`. An unresolvable name is a hard error, never a
silent fallback to the default model, because a silent fallback is how you end up billing a model
you never asked for.

Which names resolve is decided by pi's own `enabledModels` scope, which this server enforces
rather than merely displays:

```
opencode-go/deepseek-v4-flash  -> ok      (listed in enabledModels)
opencode-go/glm-5.3            -> refused (out of scope)
knowns-hub/claude-opus         -> ok      (custom provider, see below)
```

**Custom providers bypass the scope.** Any model served by a provider declared in
`~/.pi/agent/models.json` is offered even when `enabledModels` does not name it, on the grounds
that declaring a provider by hand is already an intent to use it. This is why the list can be
much longer than `enabledModels`: three entries in the scope plus two custom providers can easily
mean fifteen offered models. `init` says so explicitly in `models.scopeNote` when it applies.

Two switches change that:

| | Effect |
|---|---|
| `PI_DELEGATE_STRICT_SCOPE=1` | Honour `enabledModels` exactly. The custom-provider bypass is dropped. |
| `PI_DELEGATE_IGNORE_SCOPE=1` | Drop scoping altogether. Every authenticated model is usable. |

Call `models` to see what is actually reachable under whichever setting is in force.

## Status line

Claude Code allows exactly one `statusLine` command, so `pi-delegate-statusline` wraps whatever
you already run and appends a segment showing this workspace's delegates:

```json
{
  "statusLine": {
    "type": "command",
    "command": "PI_DELEGATE_STATUSLINE_WRAP=ccstatusline pi-delegate-statusline",
    "refreshInterval": 10
  }
}
```

Drop `PI_DELEGATE_STATUSLINE_WRAP` to print the pi segment alone.

```
π ▸ audit engine·t1·12s audit index·t2·8s   running, with turn counts and elapsed time
π ▸ migrate·t7·3m04s ?1 waiting             one delegate is blocked on a question
π ✓2                                        finished, nothing running
```

### Which delegates belong to which session

Filtering by directory is not enough: two Claude Code sessions open on the same repository
would show each other's delegates. Attribution uses process lineage instead.

The MCP host spawns one server per session, so the server records `process.ppid`, the host's
pid. The status line, spawned by that same host, walks its own ancestry and keeps only the
state files whose `hostPid` it finds there. Same repo, two sessions, no crosstalk. The
directory filter remains as a fallback for state files written before this existed.

State lives in `$XDG_STATE_HOME/pi-delegate-mcp/<pid>.json` (`PI_DELEGATE_STATE_DIR` to
relocate). Files are pruned when their process is gone, `ESRCH` only, since `EPERM` means the
process is alive under another user. Servers also exit on their own when stdin closes or the
host pid disappears, so a host that dies without closing the transport leaves nothing behind.

## Read-only by default

Tools are locked to `read, grep, find, ls` at session construction. Anything else is refused
before a session is even created.

Omit `tools` to use the defaults. Pass `tools: []` to disable all tools.

To widen that, name the extra tools on the server:

```json
"env": { "PI_DELEGATE_ALLOW_TOOLS": "bash" }
```

or `PI_DELEGATE_ALLOW_WRITE=1` to permit everything.

**`bash` is not a middle ground.** pi ships no permission system, so a delegate holding `bash`
can write files, delete them, and reach the network regardless of whether `write` and `edit` are
on its list. Refusing those two while allowing `bash` records your intent; it does not enforce
anything. Claude Code's permission prompts and hooks never see what pi does. If you need a real
boundary, run this server inside a container.

## Web search and other extension tools

pi's own tools are `read`, `grep`, `find`, `ls`, `bash`, `powershell`, `write`, `edit`. There is no
search and no fetch among them. Those come from pi extensions, which register their own tools, and a
delegate can use them.

Set `extensions: true` on the call and permit the tool names on the server:

```json
"env": { "PI_DELEGATE_ALLOW_TOOLS": "web_search,fetch_content" }
```

```json
{ "prompt": "Find the current Node LTS version and tell me just the number",
  "extensions": true, "tools": ["read", "grep", "find", "ls", "web_search"] }
```

```json
{ "seq": 1, "name": "web_search", "state": "ok", "ms": 2568,
  "args": "{\"query\":\"latest stable Node.js LTS version\",\"numResults\":5}" }
```

This is how you give a delegate network reach **without** handing it `bash`. `web_search` can search
and nothing else, and it passes through the same allowlist as every other tool, so the read-only
default is unchanged for calls that do not ask for it.

Which tools exist depends on what the user running the server has installed. `pi-web-access` provides
`web_search`, `fetch_content`, `source_check` and `get_search_content`. `pi-mcp-adapter` bridges the
MCP servers in `~/.pi/agent/mcp.json` and exposes them as `mcp`. pi has no MCP client of its own, so
that extension is the only route to one.

**`extensions: true` trusts every installed extension, not just the one you wanted.** They load as a
set, they run with the full privileges of this server's process, and some open sockets and timers
that outlive the session. Turn it on per call, for the delegates that need it, rather than leaving it
on by default. It also costs real startup time, which is why it is off unless asked for.

## Configuration

| Env var                       | Default          | Meaning                                                                  |
| ----------------------------- | ---------------- | ------------------------------------------------------------------------ |
| `PI_DELEGATE_MODEL`           | pi's own default | Model used when a call omits `model`                                     |
| `PI_DELEGATE_ALLOW_TOOLS`     | unset            | Comma list of extra tools to permit, e.g. `bash`                         |
| `PI_DELEGATE_ALLOW_WRITE`     | unset            | `1` permits every tool                                                   |
| `PI_DELEGATE_HISTORY`         | `50`             | Finished sessions kept for review                                        |
| `PI_DELEGATE_TRACE_ARGS`      | `400`            | Max chars of tool arguments kept in the trace                            |
| `PI_DELEGATE_TRACE_RESULT`    | `600`            | Max chars of tool results kept in the trace                              |
| `PI_DELEGATE_BATCH_MAX`       | `10`             | Ceiling on tasks per `spawn_batch` call                                  |
| `PI_DELEGATE_LIST_CAP`        | `60`             | Above this, `init` summarises models by provider instead of listing them |
| `PI_DELEGATE_STATE_DIR`       | XDG state dir    | Where status-line state is published                                     |
| `PI_DELEGATE_STATUSLINE_WRAP` | unset            | Status line command to wrap and append to                                |
| `PI_DELEGATE_STATUSLINE_LOG`  | unset            | File to append a timestamp to on every status line render, for debugging |
| `PI_DELEGATE_PROGRESS_MS`     | `15000`          | Progress notification interval during `run`                              |
| `PI_DELEGATE_IGNORE_SCOPE`    | unset            | `1` ignores pi's `enabledModels` scope, allowing any configured model    |
| `PI_DELEGATE_STRICT_SCOPE`    | unset            | `1` honours `enabledModels` exactly, dropping the custom-provider bypass |
| `PI_CODING_AGENT_DIR`         | `~/.pi/agent`    | Where pi's `auth.json` and config are read from                          |

## Long-running work

The MCP TypeScript SDK defaults to a **60 second** request timeout, which a real task will blow
through. Three defences, in order of preference:

1. Use `spawn` + `status`. Nothing blocks, so no timeout applies.
2. `run` emits periodic progress notifications, which reset the host's timeout.
3. Raise the ceiling with `"timeout"` in `.mcp.json` or `MCP_TOOL_TIMEOUT` in the environment.

`CLAUDE_AUTO_BACKGROUND_TASKS=1` makes Claude Code background long MCP calls after ~2 minutes.
Note that progress notifications are discarded once a call is backgrounded, so pick (1) or (3),
not both.

## Auth

The server does not handle credentials. pi authenticates itself from `~/.pi/agent/auth.json`,
then environment variables. MCP hosts often launch servers with a **stripped environment**, so
prefer `auth.json` (run `pi` once and `/login`) over exporting keys in a shell profile.

## Development

```bash
npm install
npm run build       # tsc, src/*.ts -> dist/
npm run typecheck   # tsc --noEmit, strict
npm run test:ci     # offline: boots the server over stdio and lists its tools
npm test            # full suite: needs a logged-in pi, makes real model calls
```

`test:ci` is what CI runs and what `prepublishOnly` gates on, because it needs no credentials and
no network. `npm test` drives real delegates against real providers, so it costs money and only
works where `pi` has been logged in.

| Path                 | What lives there                                     |
| -------------------- | ---------------------------------------------------- |
| `src/config.ts`      | Every environment variable, read in one place         |
| `src/permissions.ts` | The tool allowlist and the gate that enforces it      |
| `src/registry.ts`    | Session map, id claiming, history eviction            |
| `src/tools/`         | One module per group of MCP tools                     |
| `src/pi/`            | Everything that touches the pi SDK                    |
| `src/statusline/`    | State file publishing and the status line binary      |

Releases are tag-driven. `npm version patch && git push --follow-tags` runs the build and tests,
then publishes over OIDC trusted publishing, so no npm token is stored anywhere in the repository.

Issues and pull requests are welcome. If you are reporting a delegate that misbehaved, the
`toolCalls` trace from `status` with `verbose: true` is the useful thing to attach.

## Prior art

[`abatilo/pi-mcp-bridge`](https://github.com/abatilo/pi-mcp-bridge) takes the simpler route:
spawn `pi --mode json -p --session-id <uuid>` and let pi persist sessions on disk, so the bridge
holds no state at all. Elegant, and worth reading. It trades away steering, questions, and tool
control to get there.

## License

MIT
