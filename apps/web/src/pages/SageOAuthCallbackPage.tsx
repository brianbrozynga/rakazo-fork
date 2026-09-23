import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { rpc } from "../lib/rpc";

const POPUP_NAME = "rakazo-model-oauth";

export function SageOAuthCallbackPage() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const handledState = useRef<string | null>(null);

  useEffect(() => {
    const error = params.get("error");
    if (error) {
      setError(params.get("error_description") ?? t`Authentication was cancelled.`);
      return;
    }
    const code = params.get("code");
    const state = params.get("state");
    if (!code || !state) {
      setError(t`Missing code or state parameter.`);
      return;
    }
    if (handledState.current === state) return;
    handledState.current = state;
    void fetch("/api/sage/oauth/receive", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, state }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${res.status}`);
        }
        if (window.name === POPUP_NAME) {
          setDone(true);
          window.close();
          return;
        }
        // Full-page redirect case: persist JWT to model credential then navigate back.
        const loginId = sessionStorage.getItem("sage_oauth_login_id");
        if (loginId) {
          await rpc.models.finishOAuth({ loginId }).catch(() => undefined);
          sessionStorage.removeItem("sage_oauth_login_id");
          sessionStorage.removeItem("sage_oauth_started_at");
        }
        const returnUrl = sessionStorage.getItem("sage_oauth_return_url") ?? "/";
        sessionStorage.removeItem("sage_oauth_return_url");
        setDone(true);
        window.location.replace(returnUrl);
      })
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : t`Could not complete authentication`),
      );
  }, [params, t]);

  const showReturn = Boolean(error) && window.name !== POPUP_NAME;
  return (
    <div className="grid min-h-screen place-items-center bg-background p-6 text-center">
      <div>
        <div className="text-lg text-foreground">
          {error ? (
            <Trans>Authentication failed</Trans>
          ) : done ? (
            <Trans>Connected</Trans>
          ) : (
            <Trans>Finishing authentication…</Trans>
          )}
        </div>
        {error ? <p className="mt-2 max-w-md text-sm text-muted-foreground">{error}</p> : null}
        <p className="mt-2 text-sm text-muted-foreground">
          {showReturn ? (
            <Trans>You can close this window and return to the app.</Trans>
          ) : error || done ? (
            <Trans>You can close this window.</Trans>
          ) : (
            <Trans>You can close this tab if it does not redirect automatically.</Trans>
          )}
        </p>
      </div>
    </div>
  );
}
