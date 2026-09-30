import { ALLOW_ALL, ALLOW_EXTRA } from "./config.js";

/** What a delegate gets when a call names no tools. Nothing here can mutate anything. */
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

/** Everything this server will hand a delegate, whatever a call asks for. */
export const PERMITTED = new Set<string>([...READ_ONLY_TOOLS, ...ALLOW_EXTRA]);

export const permittedLabel = (): string => (ALLOW_ALL ? "any" : [...PERMITTED].join(", "));

/**
 * The single gate between a caller's wish list and what pi is actually handed. Called
 * before a session exists, so a denied tool never reaches a running delegate.
 */
export function pickTools(requested?: string[]): string[] {
  if (requested === undefined) return [...READ_ONLY_TOOLS];
  if (ALLOW_ALL) return requested;
  const denied = requested.filter((t) => !PERMITTED.has(t));
  if (denied.length)
    throw new Error(
      `Tools [${denied.join(", ")}] are blocked. Permitted here: ${[...PERMITTED].join(", ")}. ` +
        `Add them to PI_DELEGATE_ALLOW_TOOLS (comma list) in this server's env, or set ` +
        `PI_DELEGATE_ALLOW_WRITE=1 to permit everything. Note that granting bash grants writes too.`,
    );
  return requested;
}
