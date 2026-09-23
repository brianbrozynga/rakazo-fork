import { META_RUN_ID, overlayMeta } from "./bot-home-identity.js";
import { createBrokerSession } from "./broker-mcp.js";
import { switchboardCallHeaders, switchboardCallMeta, type SwitchboardIds } from "./switchboard-ids.js";

/**
 * Verified against executeSubagent in pi-runtime.ts: host.queue.push({ type: "subagent",
 * agentId, name, task, status, progress?, result? }). host.subagentGate.acquire/release.
 */

export interface SubagentHost {
  queue: { push(event: Record<string, unknown>): void };
  subagentGate: { acquire(): Promise<void>; release(): void };
  signal: AbortSignal;
}

/** Rakazo model-facing MCP names are `mcp__{slug}__{wire}`. The Broker knows the wire. */
const MCP_HOST_TOOL = /^mcp__(.+?)__(.+)$/;

function clip(text: string, cap = 12_000): string {
  return text.length <= cap ? text : text.slice(0, cap);
}

function textFromResult(result: { content?: unknown; isError?: boolean }): string {
  const content = result.content;
  if (Array.isArray(content) && content[0] && typeof content[0] === "object" && "text" in content[0]) {
    return String((content[0] as { text: unknown }).text);
  }
  return "done.";
}

function looksFailed(result: { isError?: boolean }, text: string): boolean {
  if (result.isError) return true;
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.includes('"error"')) return true;
  return false;
}

function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/[A-Za-z0-9+/=_-]{40,}/g, "[redacted]");
}

/** Strip Rakazo's `mcp__{slug}__` prefix so the Broker sees the wire name. */
export function brokerWireName(configured: string): string {
  const match = configured.trim().match(MCP_HOST_TOOL);
  return match?.[2] ?? configured.trim();
}

export type BrokerSubagentIdentity = {
  botId: string;
  runId: string;
  threadId: string;
  spaceId?: string;
  userId?: string;
};

export async function callBrokerSubagent(
  host: SubagentHost,
  executionId: string,
  args: Record<string, unknown>,
  mcpUrl: string,
  mcpKey: string,
  mcpTool: string,
  identity: BrokerSubagentIdentity,
  switchboard?: SwitchboardIds,
): Promise<string> {
  const name =
    String(args.name ?? "helper")
      .trim()
      .slice(0, 80) || "helper";
  const task = String(args.task ?? "").trim();
  const wire = brokerWireName(mcpTool);

  host.queue.push({
    type: "subagent",
    agentId: executionId,
    name,
    task,
    status: "running",
    progress: "starting…",
  });
  await host.subagentGate.acquire();

  let session: Awaited<ReturnType<typeof createBrokerSession>> | undefined;
  try {
    session = await createBrokerSession({ url: mcpUrl, key: mcpKey, signal: host.signal });
    const rakazoMeta = overlayMeta(identity);
    delete rakazoMeta[META_RUN_ID];
    const result = await session.callTool(wire, args, {
      signal: host.signal,
      meta: { ...rakazoMeta, ...switchboardCallMeta(switchboard) },
      headers: switchboardCallHeaders(switchboard),
    });
    const text = clip(textFromResult(result));
    if (looksFailed(result, text)) {
      host.queue.push({
        type: "subagent",
        agentId: executionId,
        name,
        task,
        status: "failed",
        result: text,
      });
      return `Subagent failed: ${text}`;
    }
    host.queue.push({
      type: "subagent",
      agentId: executionId,
      name,
      task,
      status: "completed",
      result: text,
    });
    return text;
  } catch (err) {
    const msg = sanitizeErrorMessage(err);
    host.queue.push({
      type: "subagent",
      agentId: executionId,
      name,
      task,
      status: "failed",
      result: msg,
    });
    return `Subagent failed: ${msg}`;
  } finally {
    host.subagentGate.release();
    void session?.close().catch(() => undefined);
  }
}
