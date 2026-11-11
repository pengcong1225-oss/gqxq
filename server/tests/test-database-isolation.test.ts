import assert from 'node:assert/strict';
import test from 'node:test';
import { assertIsolatedDatabase } from './helpers/isolated-database';

test('database test guard requires explicit opt-in and isolated target before any connection', () => {
  const valid = {GQXQ_RUN_DB_TESTS:'1',GQXQ_DB_HOST:'127.0.0.1',GQXQ_DB_PORT:'13317',GQXQ_DB_USER:'synthetic-test',GQXQ_DB_NAME:'gqxq_test_synthetic',GQXQ_TEST_DB_NAME:'gqxq_test_synthetic',DOTENV_CONFIG_PATH:'tests/.env-disabled'};
  assert.equal(assertIsolatedDatabase(valid), 'gqxq_test_synthetic');
  for (const override of [
    {GQXQ_RUN_DB_TESTS:undefined}, {GQXQ_DB_HOST:'production.example'},
    {GQXQ_DB_PORT:undefined}, {GQXQ_DB_PORT:'invalid'}, {GQXQ_DB_USER:undefined},
    {GQXQ_DB_NAME:'gqxq_service'}, {GQXQ_DB_NAME:'gqxq_service',GQXQ_TEST_DB_NAME:'gqxq_service'},
    {DOTENV_CONFIG_PATH:undefined}, {DOTENV_CONFIG_PATH:'package.json'},
  ]) assert.throws(() => assertIsolatedDatabase({...valid,...override}), /DB tests require/);
});
