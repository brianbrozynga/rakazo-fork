import type { PiCatalogEntry } from "@rakazo/adapters";
import {
  SAGE_CATALOG_BILLING,
  SAGE_DEV_PROVIDER,
  SAGE_PROD_PROVIDER,
  SAGE_PROVIDER_NAMES,
  SAGE_STG_PROVIDER,
} from "@rakazo/sage-provider";

export function listSageCatalog(): PiCatalogEntry[] {
  return [SAGE_DEV_PROVIDER, SAGE_STG_PROVIDER, SAGE_PROD_PROVIDER].map((providerId) => ({
    provider: providerId,
    providerName: SAGE_PROVIDER_NAMES[providerId] ?? providerId,
    id: `${providerId}-default`,
    label: "Sage AI",
    billing: SAGE_CATALOG_BILLING,
    auth: "oauth" as const,
    oauthLabel: "Sign in with Zynga",
    subscription: true,
    signIn: "pkce" as const,
    placeholder: true,
  }));
}
