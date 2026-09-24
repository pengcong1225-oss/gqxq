# Tiered Location Clues Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在诉求入库与历史补提取中识别有证据的详细地址和多条粗位置线索，并在详情及整体纠偏中安全展示。

**Architecture:** 保留 M12 单条详细地址候选，新增一对多位置线索表。服务端本地名录快照和确定性提取器共同驱动入库、详情和存量预览/执行；机器结果与来源地址、人工纠偏及地图坐标隔离。

**Tech Stack:** Node 24、TypeScript、Express 4、mysql2、knex migration、React 18、Ant Design 5、Node `node:test`/`tsx --test`。

**Spec:** `docs/superpowers/specs/2026-09-24-tiered-location-clues-design.md`（实施前必须完整阅读）。

## Global Constraints

- 范围仅宜昌，官方乡级名录本地快照；运行时不调用地名库、地图或外部模型，不发送诉求文本到第三方。
- 2026-09-23 官方查询为 13 个县级、110 个乡级、宜昌乡级名称无重名；这是核查时快照，不是永恒断言。`year` 参数对无效年份仍返回数据，不能作为版本证明。
- 详细地址候选只含原文片段；推定区县独立标注。粗线索不能带入地址、生成坐标或自动确认。位置冲突时两类结果都只读。
- 来源地址、人工纠偏、经纬度绝不由提取器或批量流程改写。预览绝不写业务数据，也不返回原文、姓名或电话。
- 本计划只覆盖代码、测试、测试库迁移及只读验收；真实 `gqxq_service` 回填、推送、部署均需单独决定。保护仓库既有未提交改动。

## Review Focus

1. “不是联棚乡”“以前住联棚乡”不应成为现址候选；Task 1 加否定/历史语境测试。
2. 同一诉求出现两个地点，不能因其中一个是完整地址而出现可带入按钮；Task 1、5 加冲突测试。
3. 名录更新或旧 M12 行缺少新元数据时，不能伪称已核验；Task 2、4 加空值及快照变更测试。
4. 批量扫描期间正文变化，必须以锁内文本写候选；Task 4 加并发重投测试。
5. 预览及审计不得泄露真实地址或诉求正文；Task 4 加 JSON 脱敏断言。

## File Map

- `server/src/data/yichangTownships.snapshot.json`：经人工核对的官方乡级名录、源 URL、抓取时间、校验值；仅业务范围数据。
- `server/src/services/rules/townshipGazetteer.ts`：载入与校验快照、乡级精确匹配、父级解析；不访问网络。
- `server/src/services/rules/locationExtract.ts`：纯文本分级提取、证据边界、冲突判定；使用名录模块，不写库。
- `server/src/services/rules/addressExtract.ts`：在原 M12 详细地址语义内改进“家园”等边界并返回可空推定区县元数据。
- `server/migrations/20260924100000__m13_location_clues.js`：机器线索表与 M12 兼容列；不回填。
- `server/src/repositories/locationClueRepo.ts`：按件读、幂等同步整组机器线索；不接触人工字段。
- `server/src/repositories/addressCandidateRepo.ts`：同步新增的可空元数据，保留现有 API 语义。
- `server/src/services/intakeService.ts`、`server/src/services/complaintService.ts`、`server/src/types/api.ts`：事务内同步、详情投影与新增兼容类型。
- `server/src/services/addressCandidateBackfillService.ts`、`server/src/routes/addressCandidates.ts`：复用既有管理员入口扩展预览/执行计数与线索同步；保留旧字段兼容。
- `packages/web-admin/src/components/LocationClues.tsx`：只读线索与冲突展示，供两页复用。
- `packages/web-admin/src/views/ComplaintDetail.tsx`、`AddressCorrection.tsx`、`src/types/api.ts`、`src/api/addressCandidates.ts`：详情、窗体及预览摘要。

---

### Task 1: 官方名录与纯提取规则

**Files:**
- Create: `server/src/data/yichangTownships.snapshot.json`
- Create: `server/src/services/rules/townshipGazetteer.ts`
- Create: `server/src/services/rules/locationExtract.ts`
- Modify: `server/src/services/rules/addressExtract.ts`
- Test: `server/tests/location-extraction.test.ts`
- Test: `server/tests/address-extraction.test.ts`

**Interfaces:**
- Produces `getTownshipSnapshot(): TownshipSnapshot`，其中 `TownshipSnapshot = { snapshotId: string; fetchedAt: string; sourceUrl: string; countyTownshipSha256: string; approved: boolean; counties: Array<{ code: string; name: string; townships: Array<{ code: string; name: string; type: string }> }> }`；`code` 为九位乡级码，SHA-256 只覆盖规范化排序后的 `counties` 子树，不包含自身元数据。
- Produces `extractLocation(input: AddressInput): LocationExtraction` and `hasLocationConflict(clues: ExtractedLocationClue[]): boolean`；`AddressInput = { title: string; content: string | null }`（从 `addressExtract.ts` 导出），`LocationExtraction = { clues: ExtractedLocationClue[]; conflict: boolean }`，`ExtractedLocationClue = { kind: 'township' | 'settlement'; value: string; evidence: string; sourceField: 'title' | 'content'; start: number; end: number; townshipCode: string | null; districtCode: string | null; parentMatch: 'explicit' | 'unique_township' | 'unresolved'; extractorVersion: string; snapshotId: string }`。
- Private helper in `locationExtract.ts`: `extractBoundedClues(input: AddressInput, snapshot: TownshipSnapshot): ExtractedLocationClue[]`; it preserves distinct door references.
- Extends `ExtractedAddressCandidate` with nullable `districtCode`, `parentMatch`, `snapshotId` while keeping `value` as an exact source substring.

- [ ] **Step 1: Write failing rule tests.** In `location-extraction.test.ts`, assert that `extractLocation({title:'燃气报装',content:'我是联棚乡示例家园18号1301的居民，催促安装'})` returns a `township` clue with `townshipCode === '420504202'`, `districtCode === '420504'`, and exact evidence; assert `不是联棚乡`, `以前住联棚乡`, and `联棚乡与艾家镇两处` are respectively no-current-clue, no-current-clue, and `conflict === true`. In `address-extraction.test.ts`, assert `extractAddressCandidate` on the same virtual full residence returns only `联棚乡示例家园18号1301` with separate inferred district metadata and never includes `催促安装`.

  ```ts
  const input = { title: '燃气报装', content: '我是联棚乡示例家园18号1301的居民，催促安装' };
  assert.equal(extractLocation(input).clues.find((c) => c.kind === 'township')?.townshipCode, '420504202');
  assert.equal(extractAddressCandidate(input)?.value, '联棚乡示例家园18号1301');
  assert.equal(extractLocation({ title: '核查', content: '联棚乡示例家园18号1301，实际是19号1301' }).conflict, true);
  ```
- [ ] **Step 2: Run red tests.** `npm --prefix server exec -- tsx --test server/tests/location-extraction.test.ts server/tests/address-extraction.test.ts` must fail for the missing module/new expectations.
- [ ] **Step 3: Build and validate the snapshot before coding the matcher.** Fetch read-only from `https://dmfw.mca.gov.cn/9095/xzqh/getList?code=4205&maxLevel=3`; compare to the current Hubei civil-affairs publication before marking the snapshot approved. Store only the public administrative names/codes, `fetchedAt`, source URL and SHA-256 in JSON; do not persist personal data. If the current provincial bulletin cannot be accessed, leave the snapshot explicitly unapproved and stop production enablement rather than inventing provenance. Validate unique codes, parent prefix, and township name uniqueness within Yichang, without hardcoding 110 as a future invariant.
- [ ] **Step 4: Implement minimal pure functions.** Export `getTownshipSnapshot`, `extractLocation`, `hasLocationConflict` with the signatures above. Match bounded exact official township names; detect explicit district or unique-township parent; recognize village/community/estate suffixes only with safe text boundaries; use source offsets for evidence; deduplicate identical mentions but **never distinct door references**; detect incompatible locations; reject negative/historical context. Revise `extractAddressCandidate` to admit `家园` and unique inferred township parent while preserving substring-only `value` and its existing conflict guard.

  ```ts
  export const LOCATION_EXTRACTOR_VERSION = 'location-extract.v1';
  export function extractLocation(input: AddressInput): LocationExtraction {
    const clues = extractBoundedClues(input, getTownshipSnapshot());
    return { clues, conflict: hasLocationConflict(clues) };
  }
  ```
- [ ] **Step 5: Run green tests and commit.** Run the two focused test files and `npm --prefix server run typecheck`; commit only Task 1 files after passing.

### Task 2: 兼容迁移与机器线索仓储

**Files:**
- Create: `server/migrations/20260924100000__m13_location_clues.js`
- Create: `server/src/repositories/locationClueRepo.ts`
- Modify: `server/src/repositories/addressCandidateRepo.ts`
- Test: `server/tests/location-clue-repo.test.ts`
- Modify: `server/tests/address-extraction.test.ts`

**Interfaces:**
- Produces `findLocationClues(db: Queryable, complaintId: string): Promise<LocationClueRow[]>` and `syncLocationClues(db: Queryable, complaintId: string, input: AddressInput): Promise<'created' | 'updated' | 'unchanged' | 'removed' | 'none'>`.
- `LocationClueRow` carries Task 1 clue fields plus `inputHash`; all rows for a complaint are machine-generated and replaceable as one set.
- `LocationSyncResult = 'created' | 'updated' | 'unchanged' | 'removed' | 'none'`; private helpers `sameMachineSet(before: LocationClueRow[], next: ExtractedLocationClue[], inputHash: string): boolean` and `insertMachineClue(db: Queryable, complaintId: string, clue: ExtractedLocationClue, inputHash: string): Promise<void>` live in `locationClueRepo.ts`.
- `findAddressCandidate` retains its existing return type plus nullable `districtCode`, `parentMatch`, `snapshotId`.

- [ ] **Step 1: Write failing repository tests.** A fake `Queryable` should prove create, second-call no-op, changed-text replacement of only machine rows, no-clue removal, two conflicting rows preserved, and old M12 row mapping to null metadata. Assert SQL never updates `complaint`, `correction_item`, `address_correction`, longitude or latitude.

  ```ts
  assert.equal(await syncLocationClues(db, 'C1', { title: '核查', content: '联棚乡示例村' }), 'created');
  assert.equal(await syncLocationClues(db, 'C1', { title: '核查', content: '联棚乡示例村' }), 'unchanged');
  assert.equal((await findLocationClues(db, 'C1')).length, 2);
  assert.equal(db.sqlWrites.some((sql) => /update (complaint|correction_item|address_correction)/i.test(sql)), false);
  ```
- [ ] **Step 2: Run red tests.** `npm --prefix server exec -- tsx --test server/tests/location-clue-repo.test.ts server/tests/address-extraction.test.ts` must fail on missing schema/repo behavior.
- [ ] **Step 3: Add M13 and repository.** M13 creates `complaint_location_clue` with the repository's established complaint-id convention, bounded value/evidence, source field/offsets, nullable nine/six-digit codes, `parent_match`, versions/hash/timestamps, index by complaint; adds nullable `district_code`, `parent_match`, `snapshot_id` to M12 table. It neither deletes M12 nor runs backfill. `syncLocationClues` reads existing set, compares hash+extractor+snapshot+ordered clue payload, then replaces just the machine set in caller transaction. `addressCandidateRepo` reads/writes new nullable metadata without changing existing `candidate_text` semantics; update existing test fake for new select/parameter positions.

  ```ts
  export async function syncLocationClues(db: Queryable, complaintId: string, input: AddressInput): Promise<LocationSyncResult> {
    const next = extractLocation(input).clues;
    const before = await findLocationClues(db, complaintId);
    if (sameMachineSet(before, next, addressInputHash(input))) return 'unchanged';
    await db.execute('delete from complaint_location_clue where complaint_id = ?', [complaintId]);
    for (const clue of next) await insertMachineClue(db, complaintId, clue, addressInputHash(input));
    return before.length ? (next.length ? 'updated' : 'removed') : (next.length ? 'created' : 'none');
  }
  ```
- [ ] **Step 4: Run green tests and migration inspection.** Run focused tests, server typecheck, and migration up/down/up only against `gqxq_service_test` after checking target schema. Never run M13 on `gqxq_service` in this task.
- [ ] **Step 5: Commit.** Commit Task 2 files only after test and migration verification.

### Task 3: 入库事务与详情 API

**Files:**
- Modify: `server/src/services/intakeService.ts`
- Modify: `server/src/services/complaintService.ts`
- Modify: `server/src/types/api.ts`
- Test: `server/tests/address-candidate-intake.test.ts`
- Test: `server/tests/address-candidate-detail.test.ts`

**Interfaces:**
- `ComplaintDetail` gains `locationClues: LocationClueView[]` and `locationConflict: boolean` while retaining `addressCandidate` (now with nullable inference metadata).
- `LocationClueView = { kind: 'township' | 'settlement'; value: string; evidence: string; sourceField: 'title' | 'content'; townshipCode: string | null; districtCode: string | null; districtName: string | null; parentMatch: 'explicit' | 'unique_township' | 'unresolved'; extractorVersion: string; snapshotId: string }` is the authorized read-only projection; `locationConflict` is derived from the currently stored set, not a correction status.

- [ ] **Step 1: Extend failing tests.** Existing `MemoryConnection` fake stores a clue-row array with transaction snapshot/rollback. Assert new intake creates both candidate types while source `address` is unchanged; duplicate same payload adds no writes; changed redelivery replaces/clears machine clues; forced clue write error rolls back complaint/candidate/clues. Detail test asserts multiple conflicting clues, evidence/source fields, and old M12 metadata null.

  ```ts
  const result = await intakeAppeal(command({ content: '我是联棚乡示例家园18号1301的居民' }));
  assert.equal(result.result, 'created');
  assert.equal(connection.clues.some((c) => c.townshipCode === '420504202'), true);
  assert.equal(connection.complaint?.address, '来源地址原值');
  ```
- [ ] **Step 2: Run red tests.** `npm --prefix server exec -- tsx --test server/tests/address-candidate-intake.test.ts server/tests/address-candidate-detail.test.ts` fails on new expectations.
- [ ] **Step 3: Wire transaction and projection.** Call `syncLocationClues(tx, complaintId, {title: cmd.title, content: cmd.content})` in the same two intake branches currently calling `syncAddressCandidate`; do not call it on same-payload duplicate. In complaint detail service, use `findLocationClues` and map to the two new API properties; calculate conflict using Task 1's `hasLocationConflict`, not client heuristics. Keep existing access control and the `addressCandidate` field.

  ```ts
  await syncAddressCandidate(tx, complaintId, { title: cmd.title, content: cmd.content });
  await syncLocationClues(tx, complaintId, { title: cmd.title, content: cmd.content });
  // Both writes stay inside the existing intake transaction.
  ```
- [ ] **Step 4: Run green tests and commit.** Run both focused tests, server typecheck, then commit Task 3 files.

### Task 4: 历史预览、执行、权限与审计

**Files:**
- Modify: `server/src/services/addressCandidateBackfillService.ts`
- Modify: `server/src/routes/addressCandidates.ts` only if request/response contract changes; preserve the existing paths
- Modify: `server/src/auth/rolePolicy.ts` only if a route is added; the preferred plan adds none
- Test: `server/tests/address-candidate-backfill.test.ts`

**Interfaces:**
- Existing `AddressBackfillSummary` keeps its fields and gains `townshipClues`, `settlementClues`, `conflicts`, `unresolved`, `clueCreated`, `clueUpdated`, `clueUnchanged`, `clueRemoved`, `recomputedForVersion` counts.
- `AddressBackfillPreview.samples` remains max five, with only item ordinal, action, category and fixed redacted marker.

- [ ] **Step 1: Extend failing backfill tests.** Fake scan has a township-only row, a conflict row and no-location row; assert preview does zero `execute` calls, reports grade/conflict counts, and `JSON.stringify(preview)` contains no input addresses, name or phone. Assert execution locks/re-reads changed text, commits one row and its audit together, repeats without writes, and counts audit failure without leaving un-audited clues. Assert a changed snapshot/version contributes to `recomputedForVersion`.

  ```ts
  const preview = await previewAddressCandidateBackfill();
  assert.equal(db.writes, 0);
  assert.equal(preview.conflicts, 1);
  assert.doesNotMatch(JSON.stringify(preview), /示例家园18号1301|13800000000/);
  ```
- [ ] **Step 2: Run red test.** `npm --prefix server exec -- tsx --test server/tests/address-candidate-backfill.test.ts` fails for new counts/behavior.
- [ ] **Step 3: Extend existing page scan.** Preview uses Task 1 pure extraction plus existing stored candidate/clues to compute action without writes. Execution retains per-complaint `for update` and transaction; call both sync functions using locked text and insert an audit record on any machine change, storing IDs, action and hashes but no raw clue or address. Keep admin-only endpoints; make failures isolated and response counters internally consistent.

  ```ts
  const input = { title: locked.title ?? '', content: locked.content };
  const addressChange = await syncAddressCandidate(tx, locked.complaintId, input);
  const clueChange = await syncLocationClues(tx, locked.complaintId, input);
  if ((addressChange !== 'none' && addressChange !== 'unchanged') || (clueChange !== 'none' && clueChange !== 'unchanged')) {
    await insertAudit(tx, {
      userId: operator.userId, appCode: GQXQ_APP_CODE, resourceCode: '/address-candidates/backfill',
      action: 'LOCATION_CLUE_BACKFILL_ROW', bizType: 'address_candidate', bizId: locked.complaintId,
      result: 'success', clientIp: operator.clientIp,
      detail: { complaintId: locked.complaintId, addressChange, clueChange, inputHash: addressInputHash(input) },
      createdAt: new Date(),
    });
  }
  ```
- [ ] **Step 4: Run green and commit.** Run focused backfill and RBAC tests, server typecheck, then commit Task 4 files. On local real `gqxq_service`, only run the **read-only preview** after a separate migration preflight; do not call `/backfill` as part of this plan.

### Task 5: 两处页面展示与最终本地验收

**Files:**
- Create: `packages/web-admin/src/components/LocationClues.tsx`
- Modify: `packages/web-admin/src/views/ComplaintDetail.tsx`
- Modify: `packages/web-admin/src/views/AddressCorrection.tsx`
- Modify: `packages/web-admin/src/types/api.ts`
- Modify: `packages/web-admin/src/api/addressCandidates.ts`
- Test: `packages/web-admin/tests/workflow-navigation.test.tsx`

**Interfaces:**
- `LocationClues` accepts `{ clues: LocationClueView[]; conflict: boolean }` and renders evidence read-only.
- The existing address candidate fill control is enabled only when `addressItemPending && !detail.locationConflict`.

- [ ] **Step 1: Write failing UI tests.** Render a complaint with one township clue: assert “待核实位置线索”、所属区县、证据 are present but no line-clue address-fill button. Render two conflicting clues plus a detailed candidate: assert “位置冲突” and the candidate fill action is absent/disabled. Render no conflict with pending address item: assert existing explicit fill action remains, with no automatic save/map call. Render backfill preview with new grade/conflict counts and fixed redacted samples.

  ```tsx
  const twoClues: LocationClueView[] = [
    { kind: 'township', value: '联棚乡', evidence: '联棚乡', sourceField: 'content', townshipCode: '420504202', districtCode: '420504', districtName: '点军区', parentMatch: 'unique_township', extractorVersion: 'location-extract.v1', snapshotId: 'official-20260923' },
    { kind: 'township', value: '艾家镇', evidence: '艾家镇', sourceField: 'content', townshipCode: '420504101', districtCode: '420504', districtName: '点军区', parentMatch: 'unique_township', extractorVersion: 'location-extract.v1', snapshotId: 'official-20260923' },
  ];
  const html = renderToStaticMarkup(<LocationClues clues={twoClues} conflict={true} />);
  assert.match(html, /位置冲突/);
  assert.match(html, /待核实位置线索/);
  assert.doesNotMatch(html, /带入待填写地址/);
  ```
- [ ] **Step 2: Run red test.** `npm --prefix server run verify:workflow-navigation` fails on new expectations.
- [ ] **Step 3: Implement shared display and compatibility.** Add `LocationClues` read-only component, update front-end types and both views; keep clues visually separate from detailed candidate and source address. Guard the existing `positionForm.setFieldsValue({ address: ... })` branch with `!locationConflict`. Show version/refresh and counts in existing preview panel; do not print raw source text there.

  ```tsx
  {detail.locationClues.length > 0 && <LocationClues clues={detail.locationClues} conflict={detail.locationConflict} />}
  const canFillCandidate = positionItemsReady && positionItems[0]?.status === 'pending'
    && Boolean(detail.addressCandidate) && !detail.locationConflict;
  ```
- [ ] **Step 4: Run full local verification.** `npm run verify`, `npm --prefix packages/web-admin run build`, all relevant tests via `npm --prefix server exec -- tsx --test server/tests/address-extraction.test.ts server/tests/address-candidate-intake.test.ts server/tests/address-candidate-detail.test.ts server/tests/address-candidate-backfill.test.ts server/tests/location-extraction.test.ts server/tests/location-clue-repo.test.ts`, and `git diff --check`; confirm no tests use real PII. Preview test schema only after M13 is applied there; never execute real backfill, push or deploy in this step.
- [ ] **Step 5: Commit and summarize.** Commit Task 5 files; report commit IDs, test outputs, migration status by schema, current preview counts if read-only preview was run, and explicitly state that real backfill/release remain separate decisions.

## Execution Boundary

Before starting Task 1, inspect `git status`, current branch and existing M12/M13 migration state; use an isolated worktree if the chosen execution workflow requires it. Each task uses tests-first and a review gate. The five tasks implement one feature in dependency order; do not split into independent releases. Completion of this plan means code and test-schema verification, **not** a real-data write or deployment.
