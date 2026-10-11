import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist-ui" },
  test: {
    globals: true,
    include: ["test/**/*.test.{js,tsx}"],
    testTimeout: 15000,
  },
});
