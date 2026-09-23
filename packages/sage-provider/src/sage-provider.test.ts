import { describe, it, expect } from "vitest";
import { SageModelProvider } from "./model-provider.js";
import { SageOAuthLogins } from "./sage-oauth.js";
import {
  SAGE_DEV_PROVIDER,
  SAGE_PROD_PROVIDER,
  SAGE_STG_PROVIDER,
} from "./sage-env.js";

// ------------------------------------------------------------------ //
// SageModelProvider
// ------------------------------------------------------------------ //

describe("SageModelProvider", () => {
  it("describes itself correctly", () => {
    const provider = new SageModelProvider();
    const desc = provider.describe();
    expect(desc.id).toBe("sage-provider");
    expect(desc.capabilities.catalog).toBe(true);
    expect(desc.capabilities.byok).toBe(false);
  });

  it("returns an array from listModels (environments unreachable in unit tests)", async () => {
    const provider = new SageModelProvider();
    const models = await provider.listModels();
    expect(Array.isArray(models)).toBe(true);
  });
});

// ------------------------------------------------------------------ //
// SageOAuthLogins state machine
// ------------------------------------------------------------------ //

// Fake DeviceCodeResponse used by all test factories.
const FAKE_DC = {
  device_code: "dc",
  user_code: "XXXX-XXXX",
  verification_uri: "https://auth-dev.sage.zynga.com/activate",
  verification_uri_complete: "https://auth-dev.sage.zynga.com/activate?user_code=XXXX-XXXX",
  expires_in: 300,
  interval: 5,
} as const;

function makeNeverResolvingLogins(): SageOAuthLogins {
  return new SageOAuthLogins((_config, onUserCode) => {
    onUserCode(FAKE_DC);
    return { authenticate: () => new Promise(() => undefined) };
  });
}

function makeResolvingLogins(token: string): SageOAuthLogins {
  return new SageOAuthLogins((_config, onUserCode) => {
    onUserCode(FAKE_DC);
    return { authenticate: () => Promise.resolve({ access_token: token, token_type: "Bearer" }) };
  });
}

function makeRejectingLogins(message: string): SageOAuthLogins {
  return new SageOAuthLogins((_config, _onUserCode) => ({
    // onUserCode never called — begin() rejects via rejectDeviceCode
    authenticate: () => Promise.reject(new Error(message)),
  }));
}

const ACTOR = { userId: "u1", spaceId: "s1" };

describe("SageOAuthLogins", () => {
  it("begin returns auth-url mode with the provider's auth URL", async () => {
    const logins = makeNeverResolvingLogins();
    const begun = await logins.begin({ ...ACTOR, provider: SAGE_DEV_PROVIDER });

    expect(begun.mode).toBe("auth-url");
    expect(begun.loginId).toBeTruthy();
    expect(begun.provider).toBe(SAGE_DEV_PROVIDER);
    expect(begun.verificationUri).toContain("sage.zynga.com");
    expect(begun.expiresInSeconds).toBeGreaterThan(0);

    await logins.cancel(begun.loginId, ACTOR);
  });

  it("complete returns pending while the token has not yet resolved", async () => {
    const logins = makeNeverResolvingLogins();
    const begun = await logins.begin({ ...ACTOR, provider: SAGE_STG_PROVIDER });
    expect(logins.complete(begun.loginId, ACTOR).status).toBe("pending");
    await logins.cancel(begun.loginId, ACTOR);
  });

  it("complete returns error for an unknown loginId", () => {
    const logins = makeNeverResolvingLogins();
    expect(logins.complete("nonexistent", ACTOR).status).toBe("error");
  });

  it("cancel removes the session (complete returns error after cancel)", async () => {
    const logins = makeNeverResolvingLogins();
    const begun = await logins.begin({ ...ACTOR, provider: SAGE_PROD_PROVIDER });
    await logins.cancel(begun.loginId, ACTOR);
    expect(logins.complete(begun.loginId, ACTOR).status).toBe("error");
  });

  it("resolves to connected when the token arrives", async () => {
    const logins = makeResolvingLogins("tok-abc");
    const begun = await logins.begin({ ...ACTOR, provider: SAGE_PROD_PROVIDER });

    // Wait for the resolved microtask to propagate.
    await new Promise<void>((r) => setTimeout(r, 0));

    const status = logins.complete(begun.loginId, ACTOR);
    expect(status.status).toBe("connected");
    if (status.status === "connected") {
      expect(status.accessToken).toBe("tok-abc");
    }
  });

  it("finish returns the persisted value", async () => {
    const logins = makeResolvingLogins("tok-xyz");
    const begun = await logins.begin({ ...ACTOR, provider: SAGE_PROD_PROVIDER });

    await new Promise<void>((r) => setTimeout(r, 0));

    const finish = await logins.finish(
      begun.loginId,
      ACTOR,
      async (result) => result.credential,
    );

    expect(finish.status).toBe("connected");
    if (finish.status === "connected") {
      expect(finish.value.type).toBe("oauth");
      expect(finish.value.access).toBe("tok-xyz");
      expect(finish.value.refresh).toBe(SAGE_PROD_PROVIDER);
    }
  });

  it("finish returns error when the session never resolves", async () => {
    const logins = makeNeverResolvingLogins();
    const begun = await logins.begin({ ...ACTOR, provider: SAGE_DEV_PROVIDER });

    const finish = await logins.finish(
      begun.loginId,
      ACTOR,
      async (r) => r.credential,
    );
    expect(finish.status).toBe("pending");

    await logins.cancel(begun.loginId, ACTOR);
  });

  it("abortAll removes all pending sessions", async () => {
    const logins = makeNeverResolvingLogins();
    const s1 = await logins.begin({ ...ACTOR, provider: SAGE_DEV_PROVIDER });
    const s2 = await logins.begin({ ...ACTOR, provider: SAGE_STG_PROVIDER });

    logins.abortAll();

    // After abortAll, pending map is cleared — complete returns error.
    expect(logins.complete(s1.loginId, ACTOR).status).toBe("error");
    expect(logins.complete(s2.loginId, ACTOR).status).toBe("error");
  });
});
