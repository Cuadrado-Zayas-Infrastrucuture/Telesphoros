import { brandingPlugin } from "../../apps/frontend/scripts/branding-plugin.mjs";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [brandingPlugin, react()],
  build: { outDir: "dist-ui" },
  test: {
    globals: true,
    include: ["test/**/*.test.{js,tsx}"],
    testTimeout: 15000,
  },
});
