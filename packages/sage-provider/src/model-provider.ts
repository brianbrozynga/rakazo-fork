import type { AdapterDescriptor, ModelProvider } from "@rakazo/adapter-kit";
import { createAuthClient, SageRESTClient } from "sage-sdk";
import {
  SAGE_CATALOG_BILLING,
  SAGE_PROVIDER_IDS,
  sageConfigForProvider,
} from "./sage-env.js";

export class SageModelProvider implements ModelProvider {
  describe(): AdapterDescriptor<{ catalog: boolean; byok: boolean }> {
    return {
      id: "sage-provider",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { catalog: true, byok: false },
    };
  }

  async listModels(): Promise<
    Array<{ provider: string; id: string; label: string; billing: string }>
  > {
    const results: Array<{
      provider: string;
      id: string;
      label: string;
      billing: string;
    }> = [];

    for (const providerId of SAGE_PROVIDER_IDS) {
      const config = sageConfigForProvider(providerId);
      try {
        const authClient = createAuthClient(config);
        const restClient = new SageRESTClient({ config, tokenProvider: authClient });
        const models = await restClient.listModels();
        for (const model of models) {
          results.push({
            provider: providerId,
            id: model.modelId,
            label: model.name,
            billing: SAGE_CATALOG_BILLING,
          });
        }
      } catch {
        // Environment unreachable or token unavailable — skip silently.
      }
    }

    return results;
  }
}
