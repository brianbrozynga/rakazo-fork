import type {
  AdapterContext,
  AgentRunRequest,
  AgentRuntime,
  AgentRuntimeEvent,
} from "@rakazo/adapter-kit";
import { SageAgentRuntime } from "./agent-runtime.js";
import { SAGE_PROVIDER_IDS } from "./sage-env.js";

const SAGE_IDS: ReadonlyArray<string> = SAGE_PROVIDER_IDS;

export class SageRuntimeBridge implements AgentRuntime {
  constructor(
    private readonly pi: AgentRuntime,
    private readonly sage: SageAgentRuntime,
  ) {}

  describe() {
    return this.pi.describe();
  }

  async *run(
    request: AgentRunRequest,
    context?: Partial<AdapterContext>,
  ): AsyncIterable<AgentRuntimeEvent> {
    if (SAGE_IDS.includes(request.model.provider)) {
      yield* this.sage.run(request, context);
    } else {
      yield* this.pi.run(request, context);
    }
  }

  async abort(runId: string): Promise<void> {
    await Promise.allSettled([this.sage.abort(runId), this.pi.abort(runId)]);
  }
}
