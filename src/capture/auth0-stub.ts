import * as jose from "jose";
import type { BrowserContext, Route } from "playwright";
import type { AuthInfo } from "../detect/auth.js";
import { buildSpaSeed, renderSpaSeedScript, DEFAULT_SCOPE, type SpaSeed } from "./spa-seed.js";

export interface AuthStub {
  /** Hostnames that belong to the auth provider (excluded from generated mocks). */
  authHosts: string[];
  /** The fake user object the app will see. */
  user: Record<string, unknown>;
  /**
   * For `auth0-spa` apps, the localStorage session footprint to also seed in the
   * relaunched app (codegen emits it as `mocks/auth-seed.ts`). Undefined otherwise.
   */
  spaSeed?: SpaSeed;
}

const FAKE_USER = {
  sub: "auth0|sauce-code-fake-user",
  name: "Sauce Tester",
  nickname: "sauce",
  given_name: "Sauce",
  family_name: "Tester",
  email: "tester@example.com",
  email_verified: true,
  picture: "https://www.gravatar.com/avatar/0?d=mp",
  updated_at: "2024-01-01T00:00:00.000Z",
};

/**
 * Install a fake Auth0 session so the app behaves as if a user is logged in,
 * without ever contacting the real tenant.
 *
 * Strategy:
 *  1. Mint a real RS256-signed id/access token with a freshly generated keypair
 *     and publish the matching JWKS, so even SDKs that verify signatures pass.
 *  2. Stub the tenant endpoints (discovery, JWKS, /authorize, /oauth/token,
 *     /userinfo). /authorize 302-redirects straight to the app callback with a
 *     fake code+state — this is why the real "allowed callback URL" never
 *     matters: Auth0 is never contacted.
 *  3. For SPAs, also seed the auth0-spa-js localStorage cache via addInitScript
 *     so `isAuthenticated` is true on first paint with zero network.
 *
 * Must be called BEFORE the recorder's catch-all is attached and before the
 * first navigation, so these handlers take precedence for the auth host.
 */
export async function installAuth0Stub(
  context: BrowserContext,
  appOrigin: string,
  auth: AuthInfo,
): Promise<AuthStub | undefined> {
  if (auth.flavor === "none" || !auth.domain) return undefined;

  const domain = auth.domain;
  const issuer = `https://${domain}/`;
  const clientId = auth.clientId ?? "sauce-code-client";
  const audience = auth.audience ?? clientId;
  const callbackUrl = auth.callbackUrl ?? appOrigin;

  // 1. Keypair + JWKS.
  const { publicKey, privateKey } = await jose.generateKeyPair("RS256", {
    extractable: true,
  });
  const kid = "sauce-code-key-1";
  const jwk = await jose.exportJWK(publicKey);
  const jwks = { keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] };

  const signToken = (
    audClaim: string,
    nonce: string | undefined,
    extra: Record<string, unknown> = {},
  ) => {
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = { ...FAKE_USER, azp: clientId, ...extra };
    if (nonce) claims.nonce = nonce;
    return new jose.SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid })
      .setIssuer(issuer)
      .setSubject(FAKE_USER.sub)
      .setAudience(audClaim)
      .setIssuedAt(now)
      .setExpirationTime(now + 86_400)
      .sign(privateKey);
  };

  // The SDK generates a random nonce per /authorize and validates the returned
  // id_token's nonce matches. We capture nonce + state per generated code so the
  // token minted at /oauth/token carries the correct nonce.
  const txByCode = new Map<string, { nonce?: string; state?: string }>();
  let codeSeq = 0;

  // 2. Stub tenant endpoints.
  const authBase = `https://${domain}`;
  await context.route(`${authBase}/**`, async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const pathname = url.pathname;

    if (pathname === "/.well-known/openid-configuration") {
      return fulfillJson(route, openidConfig(domain));
    }
    if (pathname === "/.well-known/jwks.json") {
      return fulfillJson(route, jwks);
    }
    if (pathname === "/authorize") {
      const state = url.searchParams.get("state") ?? "sauce-state";
      const nonce = url.searchParams.get("nonce") ?? undefined;
      const code = `sauce-code-${codeSeq++}`;
      txByCode.set(code, { nonce, state });
      return handleAuthorize(route, url, callbackUrl, code, state);
    }
    if (pathname === "/oauth/token") {
      const code = await readCodeFromTokenRequest(req);
      const tx = (code && txByCode.get(code)) || {};
      const idToken = await signToken(clientId, tx.nonce);
      const accessToken = await signToken(audience, undefined, {
        scope: "openid profile email",
      });
      return fulfillJson(route, {
        access_token: accessToken,
        id_token: idToken,
        token_type: "Bearer",
        expires_in: 86_400,
        scope: "openid profile email",
      });
    }
    if (pathname === "/userinfo") {
      return fulfillJson(route, FAKE_USER);
    }
    if (pathname === "/v2/logout" || pathname === "/logout") {
      const returnTo = url.searchParams.get("returnTo") ?? appOrigin;
      return route.fulfill({ status: 302, headers: { location: returnTo }, body: "" });
    }
    // Any other tenant call: empty 200 so nothing blocks.
    return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  // 3. Seed the auth0-spa-js localStorage cache for SPA flows (covers the
  //    cacheLocation:'localstorage' case where the SDK skips the network entirely).
  //    The same seed is returned so codegen can replay it in the relaunched app.
  let spaSeed: SpaSeed | undefined;
  if (auth.flavor === "auth0-spa") {
    const seedId = await signToken(clientId, undefined);
    const seedAccess = await signToken(audience, undefined, { scope: DEFAULT_SCOPE });
    spaSeed = buildSpaSeed({
      clientId,
      // The SDK uses the literal "default" in the cache key when no audience is configured.
      audience: auth.audience ?? "default",
      idToken: seedId,
      accessToken: seedAccess,
      user: FAKE_USER,
    });
    await context.addInitScript({ content: renderSpaSeedScript(spaSeed) });
  }

  return { authHosts: [domain], user: FAKE_USER, spaSeed };
}

function openidConfig(domain: string) {
  const base = `https://${domain}`;
  return {
    issuer: `${base}/`,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/oauth/token`,
    userinfo_endpoint: `${base}/userinfo`,
    jwks_uri: `${base}/.well-known/jwks.json`,
    end_session_endpoint: `${base}/v2/logout`,
    response_types_supported: ["code", "token", "id_token", "code id_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "profile", "email"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    code_challenge_methods_supported: ["S256"],
  };
}

/**
 * Short-circuit the login redirect. For response_mode=web_message (used by
 * auth0-spa-js silent auth inside a hidden iframe) we return an HTML page that
 * postMessages the code back. Otherwise we 302 to the app callback with the
 * fake code + echoed state.
 */
async function handleAuthorize(
  route: Route,
  url: URL,
  callbackUrl: string,
  code: string,
  state: string,
) {
  const redirectUri = url.searchParams.get("redirect_uri") ?? callbackUrl;
  const responseMode = url.searchParams.get("response_mode");

  if (responseMode === "web_message") {
    const html = webMessageHtml(code, state);
    return route.fulfill({ status: 200, contentType: "text/html", body: html });
  }

  const location = new URL(redirectUri);
  location.searchParams.set("code", code);
  location.searchParams.set("state", state);
  return route.fulfill({ status: 302, headers: { location: location.toString() }, body: "" });
}

/** Extract the authorization `code` from a token request (form or JSON body). */
async function readCodeFromTokenRequest(req: import("playwright").Request): Promise<string | undefined> {
  const body = req.postData() ?? "";
  if (!body) return undefined;
  // Form-encoded (auth0-spa-js uses application/x-www-form-urlencoded).
  try {
    const params = new URLSearchParams(body);
    const code = params.get("code");
    if (code) return code;
  } catch {
    /* not form-encoded */
  }
  // JSON fallback.
  try {
    const json = JSON.parse(body) as { code?: string };
    if (json.code) return json.code;
  } catch {
    /* not JSON */
  }
  return undefined;
}

function webMessageHtml(code: string, state: string): string {
  const payload = JSON.stringify({
    type: "authorization_response",
    response: { code, state },
  });
  return `<!doctype html><html><head><title>auth</title></head><body><script>
  (function () {
    var data = ${payload};
    var target = window.parent || window.opener;
    if (target) target.postMessage(data, "*");
  })();
  </script></body></html>`;
}

function fulfillJson(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify(body),
  });
}
