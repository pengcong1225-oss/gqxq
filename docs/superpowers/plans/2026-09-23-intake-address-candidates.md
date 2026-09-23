# Intake Address Candidates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract reviewable address candidates during complaint intake and redelivery, backfill existing complaints safely, and clarify the unrelated 72% sensitive-rule score.

**Architecture:** A pure local extractor feeds a dedicated one-row-per-complaint candidate table. Intake and redelivery write the candidate in their existing transaction; an admin-only preview/execute workflow performs idempotent historical backfill. Read APIs expose the candidate to detail and correction UI, where only an explicit operator action copies it into an editable form.

**Tech Stack:** TypeScript, Node.js/Express, MySQL 8/Knex migrations, React/Ant Design, `tsx --test`, existing `npm run verify`.

**Spec:** `docs/superpowers/specs/2026-09-23-intake-address-candidate-design.md`

## Global Constraints

- Do not overwrite `complaint.address`, `corrected_address`, coordinates, or confirmed `correction_item` rows with extracted text.
- Do not call TianDiTu or any external model during intake/backfill; location search remains operator-triggered.
- Preserve the existing `created / duplicate_same / updated` intake branches and transaction boundaries.
- No numeric address confidence until calibrated. The existing 0.72/0.88 values describe sensitive-word matching only.
- The repository has unrelated, uncommitted UX/security changes. Stage only files belonging to each task; never reset them.
- Do not execute migration or backfill against `gqxq_service` until preflight, backup, preview, and explicit run decision.

## Review Focus

1. Two different address-like spans in one narrative must yield no candidate, not a confident arbitrary choice (Task 1 test).
2. A redelivery whose text loses the address must remove only the machine candidate, never human correction (Task 2 test).
3. A batch working from stale text must not overwrite a newer intake candidate (Task 3 concurrency test).
4. A non-admin must not execute or preview a privacy-sensitive bulk operation (Task 3 policy test).
5. A confirmed address correction must not expose an active “use candidate” control (Task 4 UI test).

## File Map

- `server/src/services/rules/addressExtract.ts`: pure extraction, evidence, hash/version; no I/O.
- `server/migrations/20260917101200__m12_address_candidate.js`: candidate table only.
- `server/src/repositories/addressCandidateRepo.ts`: parameterized read/upsert/delete and stable backfill scan.
- `server/src/services/intakeService.ts`: candidate writes in intake/redelivery transactions.
- `server/src/services/addressCandidateBackfillService.ts`: preview/execute summary, lock/recheck, audit.
- `server/src/routes/addressCandidates.ts`, `server/src/routes/index.ts`, `server/src/auth/rolePolicy.ts`, `docs/2026-09-21-角色权限映射.md`: explicit admin API route and policy.
- `packages/web-admin/src/api/addressCandidates.ts`, `packages/web-admin/src/views/AddressCorrection.tsx`: admin preview/execute UI with explicit confirmation.
- `server/src/services/complaintService.ts`, `server/src/types/api.ts`, `packages/web-admin/src/types/api.ts`: detail read contract.
- `packages/web-admin/src/views/ComplaintDetail.tsx`, `packages/web-admin/src/views/AddressCorrection.tsx`, `packages/web-admin/src/api/complaints.ts`: candidate display, opt-in copy, truthful rule label.
- `server/tests/address-extraction.test.ts`, `server/tests/address-candidate-intake.test.ts`, `server/tests/address-candidate-backfill.test.ts`, `packages/web-admin/tests/workflow-navigation.test.tsx`: behavior tests.

### Task 1: Pure extractor and durable candidate storage

**Files:**
- Create: `server/src/services/rules/addressExtract.ts`
- Create: `server/src/repositories/addressCandidateRepo.ts`
- Create: `server/migrations/20260917101200__m12_address_candidate.js`
- Create: `server/tests/address-extraction.test.ts`

**Interfaces:**
- Produces: `extractAddressCandidate(input: {title: string; content: string | null}): ExtractedAddressCandidate | null`, with `{value, evidence, sourceField, extractorVersion}`; `addressInputHash(input): string`; `syncAddressCandidate(tx, complaintId, input): Promise<'created'|'updated'|'unchanged'|'removed'|'none'>`.

- [ ] **Step 1: Write failing extractor tests.** Use a fictitious address and assert it yields exactly `点军区联棚乡示例小区18号1301`; assert null for no address and for two distinct complete addresses; assert no suffix after `的居民` or later gas-service narrative. Test that two equivalent inputs have the same hash and a changed body has a different hash.

```ts
assert.equal(extractAddressCandidate({
  title: '燃气安装',
  content: '我是点军区联棚乡示例小区18号1301的居民，我之前已经进行了燃气报装，到现在还没有装。',
})?.value, '点军区联棚乡示例小区18号1301');
assert.equal(extractAddressCandidate({ title: '报装催办', content: '何时可以安装？' }), null);
```
- [ ] **Step 2: Run** `npm --prefix server exec -- tsx --test tests/address-extraction.test.ts`; expect failure because `addressExtract.ts` does not exist.
- [ ] **Step 3: Implement minimal extractor.** Use bounded Chinese administrative/residential address markers and explicit stop markers; reject ambiguous multiple matches rather than selecting one. Hash `title + '\0' + (content ?? '')` with SHA-256. Keep evidence bounded; return `null` instead of inventing a score.

```ts
export const ADDRESS_EXTRACTOR_VERSION = 'address-extract.v1';
export interface ExtractedAddressCandidate {
  value: string;
  evidence: string;
  sourceField: 'title' | 'content';
  extractorVersion: typeof ADDRESS_EXTRACTOR_VERSION;
}
export function extractAddressCandidate(input: { title: string; content: string | null }): ExtractedAddressCandidate | null;
export function addressInputHash(input: { title: string; content: string | null }): string;
```
- [ ] **Step 4: Run the extractor test; expect all cases to pass.**
- [ ] **Step 5: Add a storage contract test first.** Test that equal `(complaintId, inputHash, extractorVersion)` is unchanged, changed text updates exactly one row, and null extraction removes only candidate data. Use `gqxq_service_test` or a queryable fake; never use `gqxq_service`.

```ts
assert.equal(await syncAddressCandidate(tx, 'C1', input), 'created');
assert.equal(await syncAddressCandidate(tx, 'C1', input), 'unchanged');
assert.equal(await syncAddressCandidate(tx, 'C1', { title: '催办', content: '何时安装？' }), 'removed');
```
- [ ] **Step 6: Run the storage test; expect failure before implementation.**
- [ ] **Step 7: Implement M12 and repository.** Table has unique `complaint_id`, `candidate_text varchar(500)`, `evidence_text varchar(500)`, `source_field varchar(16)`, `extractor_version varchar(32)`, `input_hash char(64)`, timestamps; repository uses parameterized SQL and transaction `Queryable`. `syncAddressCandidate` takes the current title/content, computes the hash, and upserts/deletes only this table.

```ts
export interface AddressCandidate extends ExtractedAddressCandidate { inputHash: string }
export async function findAddressCandidate(db: Queryable, complaintId: string): Promise<AddressCandidate | null>;
export async function syncAddressCandidate(
  db: Queryable, complaintId: string, input: { title: string; content: string | null }
): Promise<'created' | 'updated' | 'unchanged' | 'removed' | 'none'>;
```
- [ ] **Step 8: Re-run both tests and server typecheck; then commit only Task 1 files.**

### Task 2: Intake and redelivery transaction integration

**Files:**
- Modify: `server/src/services/intakeService.ts`
- Create: `server/tests/address-candidate-intake.test.ts`

**Interfaces:**
- Consumes: `syncAddressCandidate(tx, complaintId, {title, content})` from Task 1.
- Produces: no public API shape change; candidate row follows the complaint source snapshot.

- [ ] **Step 1: Write failing three-branch tests.** New complaint creates candidate inside the same transaction; same-payload duplicate does not call candidate write; changed title/content updates or clears candidate while `complaint.address` and human correction remain untouched. Force a candidate write error and assert full transaction rollback.

```ts
assert.equal(created.result, 'created');
assert.equal(candidateAfterCreate?.value, '点军区联棚乡示例小区18号1301');
assert.equal(duplicate.result, 'duplicate_same');
assert.equal(candidateAfterDuplicate?.inputHash, candidateAfterCreate?.inputHash);
assert.equal(addressAfterRedelivery, sourceAddressBeforeRedelivery);
```
- [ ] **Step 2: Run** `npm --prefix server exec -- tsx --test tests/address-candidate-intake.test.ts`; expect intake integration assertions to fail.
- [ ] **Step 3: Add `syncAddressCandidate` after the successful insert in `createNew`.** Keep it before transaction return and do not modify the `values.address` mapping.

```ts
await syncAddressCandidate(tx, complaintId, { title: cmd.title, content: cmd.content });
```
- [ ] **Step 4: In `applyRedelivery`, call it only when `changedColumns` contains `title` or `content`; do not call it in `recordDuplicateSame`.** Use the same `tx` and current command values, and do not add candidate columns to `REDELIVERY_UPDATABLE_COLUMNS`.

```ts
if (changedColumns.includes('title') || changedColumns.includes('content')) {
  await syncAddressCandidate(tx, complaintId, { title: cmd.title, content: cmd.content });
}
```
- [ ] **Step 5: Re-run the focused test, `npm --prefix server run typecheck`, and existing intake tests; commit only Task 2 files.**

### Task 3: Admin-only historical preview and idempotent execution

**Files:**
- Create: `server/src/services/addressCandidateBackfillService.ts`
- Create: `server/src/routes/addressCandidates.ts`
- Modify: `server/src/routes/index.ts`
- Modify: `server/src/auth/rolePolicy.ts`
- Modify: `docs/2026-09-21-角色权限映射.md`
- Create: `packages/web-admin/src/api/addressCandidates.ts`
- Modify: `packages/web-admin/src/views/AddressCorrection.tsx`
- Create: `server/tests/address-candidate-backfill.test.ts`
- Modify: `packages/web-admin/tests/workflow-navigation.test.tsx`

**Interfaces:**
- Produces: `POST /address-candidates/backfill-preview` (read-only computation) and `POST /address-candidates/backfill` (write), each returning `{total, extractable, noCandidate, created, updated, unchanged, removed, failed}` plus a small redacted preview only for the preview route. Both are admin-only.

- [ ] **Step 1: Write failing tests** for a read-only preview, explicit admin policies, repeated execution with no duplicate rows, a no-address row, and stale-snapshot protection: after another transaction updates title/content, the batch must use the locked current values or skip instead of writing stale extraction.

```ts
assert.deepEqual(matchRule('POST', '/address-candidates/backfill')?.roles, [ROLE_ADMIN]);
assert.equal(await candidateRowCount('C1'), 1);
await executeAddressCandidateBackfill(adminContext);
assert.equal(await candidateRowCount('C1'), 1);
assert.equal((await findAddressCandidate(db, 'C1'))?.inputHash, addressInputHash(currentLockedText));
```
- [ ] **Step 2: Run** `npm --prefix server exec -- tsx --test tests/address-candidate-backfill.test.ts`; expect missing service/policy failures.
- [ ] **Step 3: Implement stable, bounded scanning.** Use `complaint.id > lastId order by id limit 100`; preview computes without writes. Execute processes each page with per-row lock/re-read in a small transaction, calls Task 1 sync, advances cursor even for no-candidate rows, and accumulates explicit failures. Never include full address samples in response.

```ts
export interface AddressBackfillSummary {
  total: number; extractable: number; noCandidate: number;
  created: number; updated: number; unchanged: number; removed: number; failed: number;
}
export async function previewAddressCandidateBackfill(): Promise<AddressBackfillSummary>;
export async function executeAddressCandidateBackfill(operator: OperatorContext): Promise<AddressBackfillSummary>;
```
- [ ] **Step 4: Mount routes before generic complaint detail matching and add explicit `A` policy entries.** Follow existing route error forwarding and `insertAudit` conventions. Update the RBAC mapping document and its endpoint count; do not rely on default admin-only behavior.

```ts
{ method: 'POST', path: /^\/address-candidates\/backfill-preview$/, roles: A, desc: '地址候选存量预览' },
{ method: 'POST', path: /^\/address-candidates\/backfill$/, roles: A, desc: '地址候选存量补提取' },
```

- [ ] **Step 5: Add the admin UI and API client.** In `AddressCorrection`, use `useAdminAccess()` for the preview/execute control. Show summary counts, keep execute disabled until preview succeeds, and require a confirmation modal that repeats the expected write count; after execution show returned counts and errors. Never render full residential addresses in a bulk sample.

```ts
export const previewAddressBackfill = () => request.post<never, AddressBackfillSummary>('/address-candidates/backfill-preview');
export const executeAddressBackfill = () => request.post<never, AddressBackfillSummary>('/address-candidates/backfill');
```
- [ ] **Step 6: Re-run focused test plus `npm run verify:workflow-navigation`, `npm --prefix server run verify:rbac`, `npm --prefix server run typecheck`; commit only Task 3 files.**

### Task 4: Read contract, correction affordance, and truthful score label

**Files:**
- Modify: `server/src/services/complaintService.ts`
- Modify: `server/src/types/api.ts`
- Modify: `packages/web-admin/src/types/api.ts`
- Modify: `packages/web-admin/src/views/ComplaintDetail.tsx`
- Modify: `packages/web-admin/src/views/AddressCorrection.tsx`
- Modify: `packages/web-admin/src/api/complaints.ts`
- Modify: `packages/web-admin/tests/workflow-navigation.test.tsx`

**Interfaces:**
- Consumes: `findAddressCandidate(complaintId)` from Task 1 and `ComplaintDetail.addressCandidate: {value,evidence,sourceField,extractorVersion}|null`.
- Produces: detail display and one-click copy into the pending position form; no automatic geocode/save.

- [ ] **Step 1: Write failing API/UI tests.** Detail API returns `addressCandidate: null` for no row or the four candidate fields for a row. Correction drawer exposes source address and candidate distinctly; clicking `填入待核实地址` sets the position form only when `address` correction is pending. A confirmed address shows candidate read-only. Score display says `敏感词规则分值` and does not label the 72% as address or global confidence.

```ts
assert.equal(detail.addressCandidate?.value, '点军区联棚乡示例小区18号1301');
assert.match(renderedDetail, /敏感词规则分值/);
assert.doesNotMatch(renderedConfirmedAddress, /填入待核实地址/);
```
- [ ] **Step 2: Run** `npm --prefix server exec -- tsx --test tests/address-candidate-backfill.test.ts` and `npm run verify:workflow-navigation`; expect the new assertions to fail.
- [ ] **Step 3: Extend `getComplaintDetail` with a separate candidate query, not an unbounded join.** Add the optional object in both API types. In `AddressCorrection`, fetch detail for selected complaint even when queue summary exists; guard stale response using existing `summarySeqRef`. Copy candidate only on an explicit click and only while the address item is pending; preserve any operator draft until that click.

```ts
export interface AddressCandidateView {
  value: string; evidence: string; sourceField: 'title' | 'content'; extractorVersion: string;
}
// Added to both ComplaintDetail interfaces:
addressCandidate: AddressCandidateView | null;
```
- [ ] **Step 4: Rename the rule display and show empty-dictionary (`sensitive_word/0`) as unavailable.** Explain that 72/88 are fixed sensitive rule scores and show address candidate as `待核实` without numeric confidence.
- [ ] **Step 5: Re-run focused tests, server/web typechecks, and frontend build; commit only Task 4 files.**

### Task 5: End-to-end verification and guarded data run

**Files:**
- Modify: `D:/codex/docs/task-log.md` for durable execution record.
- Update: `docs/superpowers/specs/2026-09-23-intake-address-candidate-design.md` status after acceptance.

**Interfaces:** No new API.

- [ ] **Step 1: Run** `npm run verify`, `npm --prefix packages/web-admin run build`, `git diff --check`, and M12 migration against an isolated test DB. Record exact outputs and any existing warnings.
- [ ] **Step 2: Review the diff against the spec.** Check that no server path sends narrative text to TianDiTu; no candidate write touches `complaint.address`, corrected fields, or `correction_item`; no unauthorized route slips past RBAC.
- [ ] **Step 3: If the owner requests a live run, perform DB preflight and backup, apply M12, run preview, compare counts, then run the explicitly approved batch and verify repeat-run idempotence.** A code-implementation approval alone is not a live-data run approval.
- [ ] **Step 4: Update task log with code commit, verification, migration/backfill status, and any remaining deployment step.** Do not claim publication unless actually pushed/deployed and checked.
