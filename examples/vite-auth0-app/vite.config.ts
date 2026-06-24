import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * A tiny dev-only backend so the fixture has real API calls to capture.
 * Set SAUCE_DISABLE_API=1 to make these endpoints unreachable — used by the
 * "authoritative mock" check: with mocks active the UI must still render.
 */
function fakeApi(): Plugin {
  const disabled = process.env.SAUCE_DISABLE_API === "1";
  return {
    name: "fixture-fake-api",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/api/")) return next();
        if (disabled) {
          res.statusCode = 503;
          res.end("api disabled");
          return;
        }
        res.setHeader("content-type", "application/json");
        if (req.url.startsWith("/api/messages")) {
          res.end(
            JSON.stringify([
              { id: 1, from: "real-backend", text: "Hello from the live API" },
              { id: 2, from: "real-backend", text: "This should be captured" },
            ]),
          );
          return;
        }
        if (req.url.startsWith("/api/profile")) {
          res.end(JSON.stringify({ plan: "pro", seats: 5, source: "live-api" }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), fakeApi()],
  server: { port: 5173 },
});
