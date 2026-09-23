import type { AdapterContext, AgentRunRequest } from "@rakazo/adapter-kit";
import { META_RUN_ID } from "./bot-home-identity.js";

/** Broker protocol ids captured from chat SSE. Not Rakazo's prisma run UUID. */
export type SwitchboardIds = { runId?: string; jobId?: string };

export const SWITCHBOARD_META_JOB_ID = "dev.switchboard/job_id";
export const SWITCHBOARD_HEADER_RUN_ID = "x-switchboard-run-id";
export const SWITCHBOARD_HEADER_JOB_ID = "x-switchboard-job-id";

export function switchboardSink(request: AgentRunRequest): SwitchboardIds {
  request.switchboard ??= {};
  return request.switchboard;
}

export function applySwitchboardEnvelope(
  envelope: { run_id?: unknown; job_id?: unknown } | undefined,
  sink: SwitchboardIds,
): void {
  if (!envelope) return;
  if (typeof envelope.run_id === "string") {
    const runId = envelope.run_id.trim();
    if (runId) sink.runId = runId;
  }
  if (typeof envelope.job_id === "string") {
    const jobId = envelope.job_id.trim();
    if (jobId) sink.jobId = jobId;
  }
}

export function captureSwitchboardFromSseLine(line: string, sink: SwitchboardIds): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return;
  const data = trimmed.slice(5).trim();
  if (!data || data === "[DONE]") return;
  try {
    const parsed = JSON.parse(data) as { switchboard?: { run_id?: unknown; job_id?: unknown } };
    applySwitchboardEnvelope(parsed.switchboard, sink);
  } catch {
    // ignore non-JSON SSE comments
  }
}

export async function tapSwitchboardResponse(response: Response, sink: SwitchboardIds): Promise<void> {
  const ctype = response.headers.get("content-type") ?? "";
  if (ctype.includes("application/json") && !ctype.includes("text/event-stream")) {
    try {
      const parsed = (await response.json()) as { switchboard?: { run_id?: unknown; job_id?: unknown } };
      applySwitchboardEnvelope(parsed.switchboard, sink);
    } catch {
      // ignore
    }
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      captureSwitchboardFromSseLine(buf.slice(0, nl), sink);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  if (buf) captureSwitchboardFromSseLine(buf, sink);
}

export function switchboardCallMeta(ids: SwitchboardIds | undefined): Record<string, string> | undefined {
  const runId = ids?.runId?.trim();
  if (!runId) return undefined;
  const meta: Record<string, string> = { [META_RUN_ID]: runId };
  const jobId = ids?.jobId?.trim();
  if (jobId) meta[SWITCHBOARD_META_JOB_ID] = jobId;
  return meta;
}

export function switchboardCallHeaders(ids: SwitchboardIds | undefined): Record<string, string> | undefined {
  const runId = ids?.runId?.trim();
  if (!runId) return undefined;
  const headers: Record<string, string> = { [SWITCHBOARD_HEADER_RUN_ID]: runId };
  const jobId = ids?.jobId?.trim();
  if (jobId) headers[SWITCHBOARD_HEADER_JOB_ID] = jobId;
  return headers;
}

/** Read Broker ids from AdapterContext. Never AdapterContext.runId (that is Rakazo's). */
export function brokerIdsFromContext(context: AdapterContext): SwitchboardIds {
  const extra = context as AdapterContext & { switchboardRunId?: string; switchboardJobId?: string };
  const runId = extra.switchboardRunId?.trim();
  const jobId = extra.switchboardJobId?.trim();
  return {
    ...(runId ? { runId } : {}),
    ...(jobId ? { jobId } : {}),
  };
}
