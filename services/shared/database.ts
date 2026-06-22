import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.js";

const pool = new Pool({
    connectionString:
        "postgresql://postgres:wpnvAiMxGPZTpTJHlsNAFekFvgzPDUGa@zephyr.proxy.rlwy.net:55938/railway",
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});

export const db = drizzle(pool, { schema });
