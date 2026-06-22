import { defineConfig } from "drizzle-kit";

export default defineConfig({
    schema: "./services/shared/schema/index.ts",
    out: "./migrations",
    dialect: "postgresql",
    dbCredentials: {
        url: "postgresql://postgres:wpnvAiMxGPZTpTJHlsNAFekFvgzPDUGa@zephyr.proxy.rlwy.net:55938/railway",
    },
});
