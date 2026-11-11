import { existsSync } from 'node:fs';
/** Fail before creating any connection; never load a developer or production .env. */
export function assertIsolatedDatabase(e: NodeJS.ProcessEnv = process.env): string {
  if (e.GQXQ_RUN_DB_TESTS !== '1' || !['127.0.0.1', 'localhost', '::1'].includes(e.GQXQ_DB_HOST ?? '') ||
      !e.GQXQ_DB_PORT || !Number.isInteger(Number(e.GQXQ_DB_PORT)) || Number(e.GQXQ_DB_PORT) < 1 || Number(e.GQXQ_DB_PORT) > 65535 ||
      !e.GQXQ_TEST_DB_NAME || e.GQXQ_DB_NAME !== e.GQXQ_TEST_DB_NAME ||
      !/^gqxq_(?:test_[a-z0-9_]+|rehearsal_[a-z0-9_]+|merge_sensitive_test)$/.test(e.GQXQ_TEST_DB_NAME) ||
      !e.GQXQ_DB_USER || !e.DOTENV_CONFIG_PATH || existsSync(e.DOTENV_CONFIG_PATH)) {
    throw new Error('DB tests require explicit GQXQ_RUN_DB_TESTS=1, loopback host, matching isolated GQXQ_TEST_DB_NAME/GQXQ_DB_NAME, explicit user, and a nonexistent dotenv path');
  }
  return e.GQXQ_TEST_DB_NAME;
}
