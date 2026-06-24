/**
 * Builds the localStorage footprint a successful auth0-spa-js (v2) login leaves
 * behind, so an app can hydrate as authenticated with zero network calls.
 *
 * This is the single source of truth shared by two callers:
 *  - capture (`auth0-stub.ts`) seeds it via Playwright `addInitScript` so the
 *    crawled app is logged in;
 *  - codegen (`generate/msw.ts`) emits it into `mocks/auth-seed.ts` so the
 *    relaunched app the user actually opens is *also* logged in (otherwise the
 *    SPA redirects to the real Auth0 tenant → "Callback URL mismatch").
 *
 * A real login writes THREE entries (verified against auth0-spa-js v2 source);
 * seeding only the token entry relies on a version-specific fallback, so we
 * replicate all three:
 *   1. token entry   `@@auth0spajs@@::<clientId>::<audience>::<scope>` -> { body, expiresAt }
 *   2. id-token/user `@@auth0spajs@@::<clientId>::@@user@@`            -> { id_token, decodedToken }
 *   3. key manifest  `@@auth0spajs@@::<clientId>`                     -> { keys: [...] }
 *
 * `toKey()` joins `[prefix, clientId, audience, scope, suffix]` with `::` after
 * dropping falsy parts; `DEFAULT_SCOPE` is `openid profile email`.
 */

const CACHE_KEY_PREFIX = "@@auth0spajs@@";
const CACHE_KEY_ID_TOKEN_SUFFIX = "@@user@@";
export const DEFAULT_SCOPE = "openid profile email";

export interface SpaSeed {
  /** `@@auth0spajs@@::<clientId>::<audience>::<scope>` */
  tokenKey: string;
  /** The cached token entry body (wrapped in `{ body, expiresAt }` at write time). */
  tokenBody: Record<string, unknown>;
  /** `@@auth0spajs@@::<clientId>::@@user@@` */
  userKey: string;
  /** The id-token cache value `{ id_token, decodedToken }` (no expiry wrapper). */
  userValue: Record<string, unknown>;
  /** `@@auth0spajs@@::<clientId>` */
  manifestKey: string;
}

export interface SpaSeedParams {
  clientId: string;
  /** The audience the SDK uses in the cache key. Pass `"default"` when the app configures none. */
  audience: string;
  idToken: string;
  accessToken: string;
  user: Record<string, unknown>;
  scope?: string;
}

/** Build the three-entry localStorage footprint for a cached auth0-spa-js session. */
export function buildSpaSeed(p: SpaSeedParams): SpaSeed {
  const scope = p.scope ?? DEFAULT_SCOPE;
  const decodedToken = {
    claims: { __raw: p.idToken, ...p.user },
    user: p.user,
  };
  return {
    tokenKey: `${CACHE_KEY_PREFIX}::${p.clientId}::${p.audience}::${scope}`,
    tokenBody: {
      client_id: p.clientId,
      access_token: p.accessToken,
      id_token: p.idToken,
      scope,
      expires_in: 86_400,
      token_type: "Bearer",
      audience: p.audience,
      oauthTokenScope: scope,
      decodedToken,
    },
    userKey: `${CACHE_KEY_PREFIX}::${p.clientId}::${CACHE_KEY_ID_TOKEN_SUFFIX}`,
    userValue: { id_token: p.idToken, decodedToken },
    manifestKey: `${CACHE_KEY_PREFIX}::${p.clientId}`,
  };
}

/**
 * Render a self-contained IIFE (valid JS, usable as a Playwright init script or
 * a generated module) that writes the seed to `localStorage`. `expiresAt` is
 * recomputed on every load so the fake session never goes stale.
 */
export function renderSpaSeedScript(seed: SpaSeed): string {
  const tokenKey = JSON.stringify(seed.tokenKey);
  const tokenBody = JSON.stringify(seed.tokenBody); // JSON is a valid JS object literal here
  const userKey = JSON.stringify(seed.userKey);
  const userValue = JSON.stringify(JSON.stringify(seed.userValue)); // pre-serialized string literal
  const manifestKey = JSON.stringify(seed.manifestKey);
  const manifestValue = JSON.stringify(JSON.stringify({ keys: [seed.tokenKey, seed.userKey] }));
  return `(function () {
  if (typeof window === "undefined") return;
  try {
    var ls = window.localStorage;
    var expiresAt = Math.floor(Date.now() / 1000) + 86400;
    ls.setItem(${tokenKey}, JSON.stringify({ body: ${tokenBody}, expiresAt: expiresAt }));
    ls.setItem(${userKey}, ${userValue});
    ls.setItem(${manifestKey}, ${manifestValue});
    document.cookie = "auth0.is.authenticated=true; path=/";
  } catch (e) {
    /* storage may be unavailable in some contexts */
  }
})();`;
}
