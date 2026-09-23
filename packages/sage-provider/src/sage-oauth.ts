import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AgentModelOAuthCredential } from "@rakazo/adapter-kit";
import { DeviceCodeAuth, type DeviceCodeResponse, type TokenResponse, type SageConfig } from "sage-sdk";
import { sageConfigForProvider } from "./sage-env.js";

export type SageOAuthBegin = {
  loginId: string;
  provider: string;
  mode: "auth-url";
  verificationUri: string;
  expiresInSeconds: number;
};

export type SageOAuthPkceBegin = {
  loginId: string;
  provider: string;
  mode: "pkce";
  authUrl: string;
  expiresInSeconds: number;
};

export type SageOAuthComplete =
  | { status: "pending" }
  | { status: "connected"; accessToken: string; provider: string }
  | { status: "error"; error: string };

export type SageOAuthFinish<T> =
  | { status: "pending" }
  | { status: "connected"; value: T }
  | { status: "error"; error: string };

type SessionState = "pending" | "ready" | "error" | "consumed";

type Session = {
  id: string;
  provider: string;
  userId: string;
  spaceId: string;
  tokenPromise?: Promise<string>;
  abort: AbortController;
  state: SessionState;
  resolvedToken?: string;
  error?: string;
  expiresTimer?: ReturnType<typeof setTimeout>;
  // PKCE-specific — present only for sessions started via beginPkce()
  pkceState?: string;
  codeVerifier?: string;
  pkceRedirectUri?: string;
  tokenEndpoint?: string;
  clientId?: string;
  _resolveToken?: (token: string) => void;
  _rejectToken?: (err: unknown) => void;
};

// Device code grant has a server-enforced expiry; mirror it here for the session map.
const SAGE_DEVICE_CODE_TIMEOUT_S = 300;
const SAGE_PKCE_TIMEOUT_S = 300;

// Injectable factory — default creates a real DeviceCodeAuth; tests inject a mock.
type DeviceCodeFactory = (
  config: SageConfig,
  onUserCode: (dc: DeviceCodeResponse) => void,
) => { authenticate(): Promise<TokenResponse> };

const defaultFactory: DeviceCodeFactory = (config, onUserCode) =>
  new DeviceCodeAuth({
    baseUrl: config.authUrl,
    clientId: config.clientId,
    scope: config.scopes.join(" "),
    timeoutMs: SAGE_DEVICE_CODE_TIMEOUT_S * 1000,
    onUserCode,
  });

export class SageOAuthLogins {
  private readonly pending = new Map<string, Session>();
  private readonly pkceStates = new Map<string, string>(); // state → loginId
  private readonly makeAuth: DeviceCodeFactory;

  constructor(factory: DeviceCodeFactory = defaultFactory) {
    this.makeAuth = factory;
  }

  async begin(input: {
    userId: string;
    spaceId: string;
    provider: string;
    signal?: AbortSignal;
  }): Promise<SageOAuthBegin> {
    if (input.signal?.aborted) {
      throw input.signal.reason ?? new Error("Sign-in cancelled.");
    }

    const config = sageConfigForProvider(input.provider);
    const loginId = randomUUID();
    const abort = new AbortController();

    // Create session early so the tokenPromise closure can reference it directly
    // rather than looking it up by ID. This avoids a microtask ordering problem
    // where the promise handler fires before the session is added to pending.
    const session: Session = {
      id: loginId,
      provider: input.provider,
      userId: input.userId,
      spaceId: input.spaceId,
      abort,
      state: "pending",
    };

    // DeviceCodeAuth works from inside a container: the server requests a device
    // code, the UI shows the verification URL + user_code, and the user completes
    // auth in their own browser. The server polls until the grant completes.
    let resolveDeviceCode!: (dc: DeviceCodeResponse) => void;
    let rejectDeviceCode!: (err: unknown) => void;
    const deviceCodeReady = new Promise<DeviceCodeResponse>((res, rej) => {
      resolveDeviceCode = res;
      rejectDeviceCode = rej;
    });

    const auth = this.makeAuth(config, resolveDeviceCode);

    const tokenPromise = auth.authenticate().then(
      (resp) => {
        session.resolvedToken = resp.access_token;
        session.state = "ready";
        return resp.access_token;
      },
      (err: unknown) => {
        // If the device code POST itself failed, surface it through deviceCodeReady too.
        rejectDeviceCode(err);
        session.error = err instanceof Error ? err.message : "Sage sign-in failed.";
        session.state = "error";
        throw err;
      },
    );
    // Suppress unhandled-rejection noise; callers observe state via complete()/finish().
    tokenPromise.catch(() => {});
    session.tokenPromise = tokenPromise;

    // Await the device code POST — one round-trip, returns the URL and user_code.
    const deviceCode = await deviceCodeReady;
    // verification_uri_complete embeds the user_code so the user just clicks once.
    const verificationUri =
      deviceCode.verification_uri_complete ?? deviceCode.verification_uri;

    session.expiresTimer = setTimeout(() => {
      if (session.state === "pending") {
        session.error = "Sign-in expired.";
        session.state = "error";
        session.abort.abort(new Error("Sign-in expired."));
        this._removeSession(session);
      }
    }, SAGE_DEVICE_CODE_TIMEOUT_S * 1000);
    session.expiresTimer.unref?.();

    this.pending.set(loginId, session);

    if (input.signal?.aborted) {
      abort.abort(input.signal.reason);
      this._removeSession(session);
      throw input.signal.reason ?? new Error("Sign-in cancelled.");
    }
    input.signal?.addEventListener("abort", () => abort.abort(input.signal?.reason), {
      once: true,
    });

    return {
      loginId,
      provider: input.provider,
      mode: "auth-url",
      verificationUri,
      expiresInSeconds: SAGE_DEVICE_CODE_TIMEOUT_S,
    };
  }

  complete(
    loginId: string,
    actor: { userId: string; spaceId: string },
  ): SageOAuthComplete {
    const session = this.pending.get(loginId);
    if (
      !session ||
      session.userId !== actor.userId ||
      session.spaceId !== actor.spaceId
    ) {
      return { status: "error", error: "Sign-in session not found. Start sign-in again." };
    }
    if (session.state === "error") {
      this._removeSession(session);
      return { status: "error", error: session.error ?? "Sage sign-in failed." };
    }
    if (session.state === "ready" && session.resolvedToken !== undefined) {
      return {
        status: "connected",
        accessToken: session.resolvedToken,
        provider: session.provider,
      };
    }
    return { status: "pending" };
  }

  async finish<T>(
    loginId: string,
    actor: { userId: string; spaceId: string },
    persist: (result: { accessToken: string; provider: string; credential: AgentModelOAuthCredential }) => Promise<T>,
  ): Promise<SageOAuthFinish<T>> {
    const session = this.pending.get(loginId);
    if (
      !session ||
      session.userId !== actor.userId ||
      session.spaceId !== actor.spaceId
    ) {
      return { status: "error", error: "Sign-in session not found. Start sign-in again." };
    }

    const polled = this.complete(loginId, actor);
    if (polled.status !== "connected") return polled;

    try {
      const credential: AgentModelOAuthCredential = {
        type: "oauth",
        access: polled.accessToken,
        // Provider ID stored here so agent-runtime knows which config to use on refresh.
        refresh: session.provider,
        // 55-minute initial window.
        expires: Date.now() + 55 * 60 * 1000,
      };
      const value = await persist({
        accessToken: polled.accessToken,
        provider: session.provider,
        credential,
      });
      session.state = "consumed";
      this._removeSession(session);
      return { status: "connected", value };
    } catch (err) {
      throw err;
    }
  }

  async cancel(
    loginId: string,
    actor: { userId: string; spaceId: string },
  ): Promise<void> {
    const session = this.pending.get(loginId);
    if (
      !session ||
      session.userId !== actor.userId ||
      session.spaceId !== actor.spaceId
    ) {
      return;
    }
    session.abort.abort(new Error("Sign-in cancelled."));
    this._removeSession(session);
  }

  async beginPkce(input: {
    userId: string;
    spaceId: string;
    provider: string;
    redirectUri: string;
  }): Promise<SageOAuthPkceBegin> {
    const config = sageConfigForProvider(input.provider);
    const { authorizationEndpoint, tokenEndpoint } = await this._discover(config.authUrl);

    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const pkceState = randomBytes(16).toString("base64url");
    const loginId = randomUUID();

    const authUrl = new URL(authorizationEndpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", config.clientId);
    authUrl.searchParams.set("redirect_uri", input.redirectUri);
    authUrl.searchParams.set("scope", config.scopes.join(" "));
    authUrl.searchParams.set("state", pkceState);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");

    const abort = new AbortController();

    let resolveToken!: (token: string) => void;
    let rejectToken!: (err: unknown) => void;
    const tokenPromise = new Promise<string>((res, rej) => {
      resolveToken = res;
      rejectToken = rej;
    });
    tokenPromise.catch(() => {});

    const session: Session = {
      id: loginId,
      provider: input.provider,
      userId: input.userId,
      spaceId: input.spaceId,
      abort,
      state: "pending",
      tokenPromise,
      pkceState,
      codeVerifier,
      pkceRedirectUri: input.redirectUri,
      tokenEndpoint,
      clientId: config.clientId,
      _resolveToken: resolveToken,
      _rejectToken: rejectToken,
    };

    session.expiresTimer = setTimeout(() => {
      if (session.state === "pending") {
        session.error = "Sign-in expired.";
        session.state = "error";
        session.abort.abort(new Error("Sign-in expired."));
        rejectToken(new Error("Sign-in expired."));
        this._removeSession(session);
      }
    }, SAGE_PKCE_TIMEOUT_S * 1000);
    session.expiresTimer.unref?.();

    this.pending.set(loginId, session);
    this.pkceStates.set(pkceState, loginId);

    return {
      loginId,
      provider: input.provider,
      mode: "pkce",
      authUrl: authUrl.toString(),
      expiresInSeconds: SAGE_PKCE_TIMEOUT_S,
    };
  }

  async receiveCallback(code: string, state: string): Promise<void> {
    const loginId = this.pkceStates.get(state);
    if (!loginId) throw new Error("Unknown PKCE state — session may have expired.");
    const session = this.pending.get(loginId);
    if (
      !session ||
      !session.codeVerifier ||
      !session.pkceRedirectUri ||
      !session.tokenEndpoint ||
      !session.clientId
    ) {
      throw new Error("PKCE session data missing.");
    }
    if (session.state !== "pending") throw new Error("PKCE session already completed.");

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: session.pkceRedirectUri,
      client_id: session.clientId,
      code_verifier: session.codeVerifier,
    });

    const resp = await fetch(session.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const error = `Token exchange failed (${resp.status}): ${text}`;
      session.error = error;
      session.state = "error";
      session._rejectToken?.(new Error(error));
      this._removeSession(session);
      throw new Error(error);
    }

    const json = (await resp.json()) as { access_token?: string };
    if (!json.access_token) {
      const error = "Token response missing access_token";
      session.error = error;
      session.state = "error";
      session._rejectToken?.(new Error(error));
      this._removeSession(session);
      throw new Error(error);
    }

    session.resolvedToken = json.access_token;
    session.state = "ready";
    session._resolveToken?.(json.access_token);
    this.pkceStates.delete(state);
  }

  private async _discover(
    authUrl: string,
  ): Promise<{ authorizationEndpoint: string; tokenEndpoint: string }> {
    const discoveryUrl = authUrl.replace(/\/$/, "") + "/.well-known/openid-configuration";
    const resp = await fetch(discoveryUrl);
    if (!resp.ok) throw new Error(`OIDC discovery failed (${resp.status})`);
    const json = (await resp.json()) as {
      authorization_endpoint?: string;
      token_endpoint?: string;
    };
    if (!json.authorization_endpoint || !json.token_endpoint) {
      throw new Error("OIDC discovery response missing endpoints");
    }
    return {
      authorizationEndpoint: json.authorization_endpoint,
      tokenEndpoint: json.token_endpoint,
    };
  }

  abortAll(): void {
    for (const session of this.pending.values()) session.abort.abort();
    this.pending.clear();
    this.pkceStates.clear();
  }

  private _removeSession(session: Session): void {
    if (session.expiresTimer) clearTimeout(session.expiresTimer);
    session.expiresTimer = undefined;
    if (session.pkceState) this.pkceStates.delete(session.pkceState);
    if (this.pending.get(session.id) === session) this.pending.delete(session.id);
  }
}
