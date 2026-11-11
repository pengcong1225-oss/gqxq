# Backend test groups

Repository verification: `npm run verify` runs type checking, the G1 gate, all isolated backend unit tests, admin interaction tests and the existing screen contract tests. It does not connect to a business database. `npm run test:web` and `npm run test:screen` can be run separately.

`GQXQ_ISOLATED_MIGRATION_TEST=1 node server/scripts/verify-suite.mjs migrations` (from the repository root) runs migration and full-chain HTTP/import integration tests. These checks independently verify port 13317 and the dedicated `gqxq-merge-mysql-20261111/data` directory before creating synthetic databases. They require the disposable instance described below; never redirect them to an existing business instance. `npm run verify:db` combines these checks with the separately configured DB group below. No DB checks are silently part of the default unit group.

- `node tests/run-tests.mjs unit`: all top-level `*.test.ts` files with dotenv disabled, DB at `127.0.0.1:1`, synthetic credentials and external workers disabled. No filename exclusions or skipped tests.
- `node tests/run-tests.mjs db:sensitive`: eight real-MySQL sensitive-word transaction/rescan tests.
- `node tests/run-tests.mjs db:callback`: the two existing callback/replay MySQL tests. They require the original `gqxq_rehearsal_20261003` full-schema synthetic rehearsal fixture (`REHEARSAL-C1`, clean pending inbox).
- `node tests/run-tests.mjs db`: all real-DB tests; requires a fixture satisfying both groups.

DB tests fail before opening a connection unless `GQXQ_RUN_DB_TESTS=1`, an explicit loopback host, explicit user, matching `GQXQ_TEST_DB_NAME` and `GQXQ_DB_NAME` with an isolated allowed name, and a nonexistent `DOTENV_CONFIG_PATH` are provided. Never use an ordinary application database or its `.env`.

## Reproduce sensitive-word DB checks

Start a separate disposable MySQL instance. From the server directory, in PowerShell:

```powershell
$env:DOTENV_CONFIG_PATH = 'nonexistent-test.env'
$env:GQXQ_RUN_DB_TESTS = '1'
$env:GQXQ_DB_HOST = '127.0.0.1'
$env:GQXQ_DB_PORT = '13317'
$env:GQXQ_DB_USER = 'root'
$env:GQXQ_DB_PASSWORD = ''
$env:GQXQ_DB_NAME = 'gqxq_merge_sensitive_test'
$env:GQXQ_TEST_DB_NAME = $env:GQXQ_DB_NAME
$env:GQXQ_TEST_DB_DATADIR = 'D:/codex/tmp/gqxq-merge-mysql-20261111/data'
$env:GQXQ_JWT_SECRET = 'isolated-test-no-production-secret'
node --import tsx tests/setup-sensitive-db.mts
node tests/run-tests.mjs db:sensitive
```

Setup verifies `@@datadir` and refuses an existing database. It creates only synthetic words and a synthetic complaint. Its five-table fixture tests sensitive-word SQL and transactions; it does **not** replace full migration-chain verification. Each test rolls back its changes, so execution is repeatable without re-running setup.

## Full-schema callback and DB group

Using the same isolated instance/environment above, set both database names to `gqxq_rehearsal_20261003`, then run:

```powershell
node --import tsx tests/setup-callback-db.mts
node tests/run-tests.mjs db
```

This setup verifies the datadir, refuses an existing database, applies the DDL-only external baseline and every current migration, then inserts one synthetic complaint and one sensitive word. The DB runner executes files serially because callback tests share the durable replay cursor. Callback tests establish the same trusted-system context as authenticated ingress and clean up their own synthetic event rows, preserving replay repeatability. No existing business database is copied.
