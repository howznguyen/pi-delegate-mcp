import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../config.js";
import type { PiWorker } from "../pi/worker.js";
import type { StateFile } from "../types.js";

export { STATE_DIR };

/**
 * The status line runs as a separate process, so live session state has to reach it
 * through the filesystem. One file per server instance, named by pid; readers treat a
 * file whose pid is gone as stale.
 */
const FILE = join(STATE_DIR, `${process.pid}.json`);
const WRITE_THROTTLE_MS = 250;

let pending: StateFile | undefined;
let timer: NodeJS.Timeout | undefined;

function flush(): void {
  timer = undefined;
  const payload = pending;
  pending = undefined;
  if (!payload) return;
  const temp = join(STATE_DIR, `${process.pid}.tmp`);
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    // Write-then-rename so a reader never sees a half-written file.
    writeFileSync(temp, JSON.stringify(payload));
    renameSync(temp, FILE);
  } catch {
    // The status line is a convenience. Never let it break a delegate.
  } finally {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Best-effort cleanup.
    }
  }
}

export function publish(sessions: Iterable<PiWorker>): void {
  pending = {
    pid: process.pid,
    // The host that launched this server. A status line spawned by the same host finds
    // this pid in its own ancestry, which is how delegates get attributed to the right
    // session even when two sessions share a repository.
    hostPid: process.ppid,
    updatedAt: new Date().toISOString(),
    sessions: [...sessions].map((w) => ({
      id: w.id,
      label: w.label,
      state: w.state,
      model: w.model,
      cwd: w.cwd,
      turns: w.turns,
      questions: w.questions.size,
      startedAt: w.startedAt,
    })),
  };
  timer ??= setTimeout(flush, WRITE_THROTTLE_MS).unref();
}

export function cleanup(): void {
  try {
    rmSync(FILE, { force: true });
  } catch {
    // Exiting anyway.
  }
}

/** Walk up from a pid, collecting ancestors. Used to match a server to its host. */
export function ancestors(startPid: number = process.pid, depth = 8): number[] {
  const chain: number[] = [];
  let pid = startPid;
  for (let i = 0; i < depth && pid > 1; i++) {
    chain.push(pid);
    try {
      const out = execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
      const parent = Number(out.trim());
      if (!Number.isInteger(parent) || parent <= 1) break;
      pid = parent;
    } catch {
      break;
    }
  }
  return chain;
}

/** Read every live server's state, dropping files whose process is gone. */
export function readAll(): StateFile[] {
  let names: string[];
  try {
    names = readdirSync(STATE_DIR);
  } catch {
    return [];
  }
  const out: StateFile[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const pid = Number(name.slice(0, -5));
    try {
      process.kill(pid, 0);
    } catch (err) {
      // ESRCH means the process is gone. EPERM means it exists but belongs to another
      // user, so it is still alive and the file stays. Treating EPERM as dead would
      // delete live state whenever a server runs under a different account.
      if ((err as NodeJS.ErrnoException)?.code === "ESRCH") {
        rmSync(join(STATE_DIR, name), { force: true });
        continue;
      }
    }
    try {
      out.push(JSON.parse(readFileSync(join(STATE_DIR, name), "utf8")) as StateFile);
    } catch {
      // A truncated or foreign file is not worth failing a status line over.
    }
  }
  return out;
}
