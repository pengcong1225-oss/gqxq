# Final review fix report — tiered location clues

Date: 2026-09-24

Scope: one consolidated final-review fix wave in `.worktrees/gqxq-location-clues`. All fixtures use invented names and addresses. No real database reads or writes, migrations, backfills, pushes, or deployments were performed.

## RED

- Added regression fixtures for: an unparented settlement in a later clause; repeated complete addresses; a second township-linked address; negative and historical context across punctuation and whitespace; and M12 suppression for those contexts and conflicts.
- `npx tsx --test tests/location-extraction.test.ts tests/address-extraction.test.ts` initially failed six new behavior assertions: the later settlement was lost, repeated complete addresses generated a false conflict, a second address's door was attached to the first township, and both extractors retained rejected locations. This confirmed the three Important findings.
- Added workflow UI regressions for clue-only execution counts and the combined address-evidence view. `npm run verify:workflow-navigation` failed the new combined-view assertion before the view was introduced; the clue-count assertion also failed because the result only displayed M12 counts.
- Added extractor-version expectations first. The focused server command failed for both stale versions (`address-extract.v2`, `location-extract.v1`) before the version bumps.
- An initial attempt to run `npm test` failed because the server package has no `test` script. It was replaced with the repository's `tsx --test` invocation below.

## GREEN

- `npx tsx --test tests/location-extraction.test.ts tests/address-extraction.test.ts` — passed, 49 tests, 0 failures.
- `npm run verify:workflow-navigation` from `server` — passed, 13 tests, 0 failures. Output includes existing React SSR `useLayoutEffect`, Ant Design `destroyOnClose`, and React `act(...)` warnings.
- `npm --prefix server run typecheck` — passed.
- `npm --prefix packages/web-admin run typecheck` — passed.
- `npm run build` from `packages/web-admin` — passed. Vite reported the existing large-bundle advisory (main JS bundle 2.58 MB minified).
- `git diff --check` — passed; Git printed line-ending normalization notices for edited files.

## Changes

- M13 now scans each clause independently for settlement clues even when a different clause contains a township. Unparented evidence stays unparented, and distinct settlements set the complaint-level conflict.
- Complete address mentions own their door numbers. Repeated identical mentions deduplicate without false bare-door clues; complete addresses in later locations no longer have their door numbers attached to the first township. Shortened second-door evidence remains supported when a single township is unambiguous.
- M12 and M13 now share rejection-context filtering that normalizes common punctuation and whitespace. M12 returns no fillable candidate whenever extracted clues show a location conflict.
- Bumped extractor versions to `location-extract.v2` and `address-extract.v3`, so changed rules cause stored machine results to be recomputed on the next normal sync/backfill workflow.
- The correction view now composes candidate and clue evidence together and gates candidate fill when conflict exists. Execution summary reports address-candidate and location-clue created, updated, unchanged, and removed counts separately.

## Remaining limitations

- Verification used pure rules and UI fixtures only. No database-backed end-to-end test, migration, or real-data preview was run, consistent with the scope restrictions.
- Unparented door-only address fragments without an explicit residence introduction remain unpromoted when no township is present; this preserves the existing boundary regression against converting later complaint prose into a location.
- Rule-based context filtering cannot resolve every possible natural-language ambiguity. It preserves clues and suppresses fill on detected conflicts; human review remains required.

No review finding remains known-unfixed. No reviewer or subagent was dispatched.
