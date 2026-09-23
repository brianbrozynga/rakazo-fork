import { SageConfig } from "sage-sdk";

export const SAGE_DEV_PROVIDER = "sage-dev";
export const SAGE_STG_PROVIDER = "sage-stg";
export const SAGE_PROD_PROVIDER = "sage-prod";

export const SAGE_PROVIDER_NAMES: Record<string, string> = {
  [SAGE_DEV_PROVIDER]: "Sage (dev)",
  [SAGE_STG_PROVIDER]: "Sage (staging)",
  [SAGE_PROD_PROVIDER]: "Sage",
};

const SAGE_BILLING =
  "Sage subscription (Zynga internal). No model charges from Rakazo.";

export const SAGE_CATALOG_BILLING = SAGE_BILLING;

let _devConfig: SageConfig | undefined;
let _stgConfig: SageConfig | undefined;
let _prodConfig: SageConfig | undefined;
// Cached config when SAGE_AUTH_URL env override is present.
let _envConfig: SageConfig | undefined;

export function sageConfigForProvider(providerId: string): SageConfig {
  // SAGE_AUTH_URL overrides per-provider defaults — set it to point all providers
  // at a specific environment (e.g. SAGE_AUTH_URL=https://auth.sage.zynga.com).
  if (process.env["SAGE_AUTH_URL"]) {
    _envConfig ??= SageConfig.fromEnv();
    return _envConfig;
  }
  if (providerId === SAGE_DEV_PROVIDER) {
    _devConfig ??= SageConfig.forDev();
    return _devConfig;
  }
  if (providerId === SAGE_STG_PROVIDER) {
    _stgConfig ??= SageConfig.forStaging();
    return _stgConfig;
  }
  if (providerId === SAGE_PROD_PROVIDER) {
    _prodConfig ??= SageConfig.forProduction();
    return _prodConfig;
  }
  throw new Error(`Unknown Sage provider: ${providerId}`);
}

export const SAGE_PROVIDER_IDS = [
  SAGE_DEV_PROVIDER,
  SAGE_STG_PROVIDER,
  SAGE_PROD_PROVIDER,
] as const;
