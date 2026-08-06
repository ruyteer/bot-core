import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: [resolve(here, "test/setup.ts")],
    // Isola módulos por arquivo de teste → PGlite fresco por arquivo.
    isolate: true,
    include: ["services/**/*.test.ts", "test/**/*.test.ts"],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      // Substitui o runtime do Encore por stubs de teste.
      "encore.dev/config": resolve(here, "test/stubs/encore-config.ts"),
      "encore.dev/pubsub": resolve(here, "test/stubs/encore-pubsub.ts"),
      "encore.dev/api": resolve(here, "test/stubs/encore-api.ts"),
      "encore.dev/service": resolve(here, "test/stubs/encore-service.ts"),
      "encore.dev/auth": resolve(here, "test/stubs/encore-auth.ts"),
    },
  },
});
