// Setup global dos testes (vitest setupFiles). Instala o mock de fetch, inicializa
// o PGlite + migrações e limpa estado entre cada teste.

import { beforeAll, beforeEach, afterAll } from "vitest";
import { initTestDb, resetTestDb } from "./helpers/db.js";
import { installFetchMock, resetFetchMock, uninstallFetchMock } from "./helpers/fetch-mock.js";
import { __resetPubsub } from "./stubs/encore-pubsub.js";

beforeAll(async () => {
  installFetchMock();
  await initTestDb();
});

beforeEach(async () => {
  await resetTestDb();
  resetFetchMock();
  __resetPubsub();
});

afterAll(() => {
  uninstallFetchMock();
});
