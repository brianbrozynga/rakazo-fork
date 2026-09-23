import { randomUUID } from "node:crypto";
import type {
  AdapterContext,
  AdapterDescriptor,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeCapabilities,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { createAuthClient, SageACPClient } from "sage-sdk";
import { sageConfigForProvider } from "./sage-env.js";

const SAGE_RUNTIME_CONTRACT_VERSION = "1";
const SAGE_RUNTIME_ADAPTER_VERSION = "0.1.0";

// Per-thread ACP sessions. The thread ID is stable across turns.
const activeSessions = new Map<string, { client: SageACPClient; sessionId: string }>();

// Per-run abort controllers for AgentRuntime.abort().
const activeRuns = new Map<string, AbortController>();

export class SageAgentRuntime implements AgentRuntime {
  describe(): AdapterDescriptor<AgentRuntimeCapabilities> {
    return {
      id: "sage-runtime",
      contractVersion: SAGE_RUNTIME_CONTRACT_VERSION,
      adapterVersion: SAGE_RUNTIME_ADAPTER_VERSION,
      capabilities: {
        streaming: false,
        compaction: false,
        tools: false,
        scripted: false,
      },
    };
  }

  async *run(
    request: AgentRunRequest,
    _context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    const runAbort = new AbortController();
    activeRuns.set(request.runId, runAbort);

    try {
      yield* this._runInner(request, runAbort.signal);
    } finally {
      activeRuns.delete(request.runId);
    }
  }

  async abort(runId: string): Promise<void> {
    activeRuns.get(runId)?.abort();
  }

  private async *_runInner(
    request: AgentRunRequest,
    signal: AbortSignal,
  ): AsyncIterable<AgentRuntimeEvent> {
    const { model, threadId, prompt, instructions } = request;

    // CCC (SAGE_CLIENT_ID + SAGE_CLIENT_SECRET) takes precedence — no user credential
    // needed. Without CCC, use the stored OAuth credential while it's still valid;
    // expired credentials require the user to re-authenticate via device code flow.
    const hasCCC = !!(process.env["SAGE_CLIENT_ID"] && process.env["SAGE_CLIENT_SECRET"]);
    const config = sageConfigForProvider(model.provider);

    let accessToken: string;
    if (hasCCC) {
      accessToken = await createAuthClient(config).getAccessToken();
    } else if (model.oauth && model.oauth.credential.expires - Date.now() > 30_000) {
      accessToken = model.oauth.credential.access;
    } else {
      throw new Error(
        "Sage access token expired. Please reconnect your Sage account from the model picker.",
      );
    }

    const tokenProvider = {
      getAccessToken: async (opts?: { forceRefresh?: boolean }) => {
        if (hasCCC && opts?.forceRefresh) {
          return createAuthClient(config).getAccessToken({ forceRefresh: true });
        }
        return accessToken;
      },
    };

    // Reuse the ACP client+session for this thread when possible.
    let session = activeSessions.get(threadId);
    if (!session) {
      const client = new SageACPClient({
        config,
        tokenProvider,
      });
      await client.connect();

      // Set the model before creating the session.
      const sessionInfo = await client.newSession({
        model: model.id,
        ...(instructions ? { agent: undefined } : {}),
      });

      session = { client, sessionId: sessionInfo.sessionId };
      activeSessions.set(threadId, session);
    }

    if (signal.aborted) {
      yield { type: "done" };
      return;
    }

    // Build the full prompt text including system instructions on the first turn.
    const messageText =
      instructions && request.history.length === 0
        ? `${instructions}\n\n${prompt}`
        : prompt;

    let responseText: string;
    try {
      const result = await session.client.prompt(session.sessionId, messageText);
      responseText = extractText(result);
    } catch (err) {
      // Session may have expired — remove it so the next run creates a fresh one.
      activeSessions.delete(threadId);
      throw err;
    }

    if (signal.aborted) {
      yield { type: "done" };
      return;
    }

    if (responseText) {
      yield { type: "text", text: responseText };
    }
    yield { type: "done" };
  }
}

function extractText(result: Record<string, unknown>): string {
  // Sage ACP returns the assistant reply under various shapes.
  if (typeof result["text"] === "string") return result["text"];
  if (typeof result["content"] === "string") return result["content"];
  const content = result["content"];
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        const block = c as Record<string, unknown>;
        return block["type"] === "text" && typeof block["text"] === "string"
          ? block["text"]
          : "";
      })
      .join("");
  }
  return JSON.stringify(result);
}

export function _clearSessionForThread(threadId: string): void {
  const session = activeSessions.get(threadId);
  if (session) {
    void session.client[Symbol.asyncDispose]?.().catch(() => undefined);
    activeSessions.delete(threadId);
  }
}
