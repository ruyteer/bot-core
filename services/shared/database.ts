import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.js";
import { databaseUrl } from "../config/secrets.js";

const pool = new Pool({
    connectionString: databaseUrl(),
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
});

export const db = drizzle(pool, { schema });
