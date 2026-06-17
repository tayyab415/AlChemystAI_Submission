import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests run by default. E2E tests need a running agent-server:
    //   npx vitest run e2e/protocol.e2e.test.ts   (server in normal mode)
    //   npx vitest run e2e/chaos.e2e.test.ts      (server in chaos mode)
    exclude: ["node_modules/**", ".next/**"],
  },
});
