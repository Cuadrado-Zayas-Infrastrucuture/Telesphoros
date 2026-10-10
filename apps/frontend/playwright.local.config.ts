import { defineConfig } from "@playwright/test";
import foundation from "./playwright.config";

// Local review routes intentionally never ship in a production build. Test them in Vite development mode,
// with the same real fake-IdP login and backend /me checks as the foundation suite.
const servers = foundation.webServer as {
  command: string;
  url: string;
  reuseExistingServer: boolean;
  timeout: number;
  env?: Record<string, string>;
}[];
export default defineConfig({
  ...foundation,
  testDir: "./local-e2e",
  webServer: [
    ...servers.slice(0, -1),
    {
      command:
        "pnpm exec vite --mode e2e --host 127.0.0.1 --port 4173 --strictPort",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
