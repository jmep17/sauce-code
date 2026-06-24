import React from "react";
import ReactDOM from "react-dom/client";
import { Auth0Provider } from "@auth0/auth0-react";
import { App } from "./App";

const domain = import.meta.env.VITE_AUTH0_DOMAIN as string;
const clientId = import.meta.env.VITE_AUTH0_CLIENT_ID as string;
const audience = import.meta.env.VITE_AUTH0_AUDIENCE as string | undefined;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Auth0Provider
      domain={domain}
      clientId={clientId}
      // localstorage so a cached session survives reloads; the stub seeds it.
      cacheLocation="localstorage"
      useRefreshTokens={false}
      authorizationParams={{
        redirect_uri: window.location.origin,
        // Custom scope, a superset of VITE_AUTH0_SCOPE, so sauce-code's capture must
        // observe it on /authorize and bake it into the relaunch seed's cache key.
        scope: "openid profile email read:reports admin:all",
        ...(audience ? { audience } : {}),
      }}
    >
      <App />
    </Auth0Provider>
  </React.StrictMode>,
);
