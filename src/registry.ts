import { DEFAULT_MODEL, HISTORY_LIMIT } from "./config.js";
import { callbackFromEnv } from "./callback.js";
import { pickTools } from "./permissions.js";
import { PiWorker } from "./pi/worker.js";
import { publish } from "./statusline/state.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** Live and finished delegates, newest last. Finished ones stay readable until evicted. */
const sessions = new Map<string, PiWorker>();

export const all = (): PiWorker[] => [...sessions.values()];
export const count = (): number => sessions.size;

/**
 * Validate a caller-supplied id and reserve nothing. Split out from `launch` so a batch
 * can check every id before starting any delegate.
 */
export function claimId(id?: string): string | undefined {
  if (id === undefined) return undefined;
  if (!ID_PATTERN.test(id))
    throw new Error(
      `Invalid id "${id}". Use 1-64 chars: letters, digits, then . _ : - are allowed. ` +
        `Something like "search-audit-01" or "review:engine.go".`,
    );
  if (sessions.has(id))
    throw new Error(`Session id "${id}" is already in use. Pick another or call abort/forget first.`);
  return id;
}

export function must(id: string): PiWorker {
  const w = sessions.get(id);
  if (!w) throw new Error(`Unknown sessionId: ${id}`);
  return w;
}

export function forget(id: string): void {
  sessions.delete(id);
}

/** Drop the oldest finished sessions once history is over budget. Running ones are safe. */
export function evictHistory(): void {
  const done = all().filter((w) => w.state !== "running" && w.state !== "starting");
  while (sessions.size > HISTORY_LIMIT && done.length) {
    const oldest = done.shift();
    if (!oldest) break;
    oldest.dispose();
    sessions.delete(oldest.id);
  }
}

export interface LaunchRequest {
  prompt: string;
  model?: string | undefined;
  cwd?: string | undefined;
  tools?: string[] | undefined;
  extensions?: boolean | undefined;
  id?: string | undefined;
  label?: string | undefined;
  callbackTarget?: string | undefined;
}

export async function launch(req: LaunchRequest): Promise<PiWorker> {
  const worker = new PiWorker({
    id: claimId(req.id),
    label: req.label,
    cwd: req.cwd || process.cwd(),
    model: req.model || DEFAULT_MODEL,
    tools: pickTools(req.tools),
    extensions: req.extensions ?? false,
    callbackTarget: req.callbackTarget,
    callback: callbackFromEnv(),
  });
  worker.onChange = () => publish(all());
  sessions.set(worker.id, worker);
  try {
    await worker.start(req.prompt);
  } catch (e) {
    // A session that never started must not occupy its id.
    sessions.delete(worker.id);
    publish(all());
    throw e;
  }
  evictHistory();
  publish(all());
  return worker;
}
