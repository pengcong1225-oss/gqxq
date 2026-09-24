import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressInputHash, extractAddressCandidate } from '../src/services/rules/addressExtract';
import { findAddressCandidate, syncAddressCandidate } from '../src/repositories/addressCandidateRepo';
import type { Queryable } from '../src/repositories/complaintSourceLogRepo';

class CandidateFake {
  row: Record<string, unknown> | null = null;
  operations = 0;

  async query(sql: string, values: unknown[] = []): Promise<[unknown[], unknown[]]> {
    if (sql.includes('select')) return [this.row ? [{ ...this.row }] : [], []];
    throw new Error(`unexpected query: ${sql}`);
  }

  async execute(sql: string, values: unknown[] = []): Promise<unknown> {
    this.operations++;
    if (sql.startsWith('insert')) {
      this.row = {
        complaintId: values[0], candidateText: values[1], evidenceText: values[2], sourceField: values[3],
        extractorVersion: values[4], inputHash: values[5], districtCode: values[6], parentMatch: values[7], snapshotId: values[8],
      };
    } else if (sql.startsWith('delete')) {
      this.row = null;
    } else if (sql.startsWith('update')) {
      if (this.row) {
        this.row = {
          complaintId: values[8], candidateText: values[0], evidenceText: values[1], sourceField: values[2],
          extractorVersion: values[3], inputHash: values[4], districtCode: values[5], parentMatch: values[6], snapshotId: values[7],
        };
      }
    } else throw new Error(`unexpected execute: ${sql}`);
    return [{ affectedRows: 1 }, []];
  }
}

test('extracts a bounded residential address and stops at resident narrative', () => {
  const result = extractAddressCandidate({
    title: '燃气安装',
    content: '我是点军区联棚乡示例小区18号1301的居民，我之前已经进行了燃气报装，到现在还没有装。',
  });
  assert.equal(result?.value, '点军区联棚乡示例小区18号1301');
  assert.equal(result?.sourceField, 'content');
});

test('keeps an exact home-garden address substring and stores inferred township metadata separately', () => {
  const result = extractAddressCandidate({
    title: '燃气报装',
    content: '我是联棚乡示例家园18号1301的居民，催促安装',
  });
  assert.equal(result?.value, '联棚乡示例家园18号1301');
  assert.equal(result?.districtCode, '420504');
  assert.equal(result?.parentMatch, 'unique_township');
  assert.equal(result?.snapshotId, 'yichang-2026-09-24-api-unapproved');
  assert.equal(result?.value.includes('催促安装'), false);
});

test('persists inferred township metadata separately from the exact address candidate text', async () => {
  const db = new CandidateFake() as unknown as CandidateFake & Queryable;
  const input = { title: '燃气报装', content: '我是联棚乡示例家园18号1301的居民，催促安装' };

  assert.equal(await syncAddressCandidate(db, 'C1', input), 'created');
  const stored = (db as unknown as CandidateFake).row!;
  assert.equal(stored.candidateText, '联棚乡示例家园18号1301');
  assert.equal(stored.districtCode, '420504');
  assert.equal(stored.parentMatch, 'unique_township');
  assert.equal(stored.snapshotId, 'yichang-2026-09-24-api-unapproved');
  assert.equal((await findAddressCandidate(db, 'C1'))?.districtCode, '420504');
});

test('rejects a township paired with an explicitly different county', () => {
  const input = { title: '地址核查', content: '点军区西陵街道示例小区18号1301' };
  assert.equal(extractAddressCandidate(input), null);
});

test('extracts only the continuous home substring after a resident connector', () => {
  const result = extractAddressCandidate({
    title: '地址核查',
    content: '我是联棚乡居民住在示例家园18号1301',
  });
  assert.equal(result?.value, '示例家园18号1301');
  assert.equal(result?.evidence, '示例家园18号1301');
  assert.equal(result?.districtCode, '420504');
});

test('rejects prose between a township and a settlement suffix instead of treating prose as the name', () => {
  assert.equal(
    extractAddressCandidate({ title: '地址核查', content: '我是联棚乡居民投诉示例家园18号1301' }),
    null
  );
});

test('rejects an unbounded clause between a township and a settlement suffix', () => {
  assert.equal(
    extractAddressCandidate({ title: '地址核查', content: '我是联棚乡群众告知示例家园18号1301' }),
    null
  );
});

test('still extracts a directly bounded settlement name after the township', () => {
  const result = extractAddressCandidate({ title: '地址核查', content: '我是联棚乡示例家园18号1301' });
  assert.equal(result?.value, '联棚乡示例家园18号1301');
});

test('extracts a four-character township-linked estate name and door as an exact candidate', () => {
  const text = '联棚乡恒大名都小区18号1301';
  const result = extractAddressCandidate({ title: '地址核查', content: text });
  assert.equal(result?.value, text);
  assert.equal(result?.evidence, text);
  assert.equal(result?.districtCode, '420504');
});

test('does not fabricate detailed candidates from complaint prose after a township', () => {
  for (const content of [
    '我是联棚乡群众告知示例家园18号1301',
    '我是联棚乡居民投诉示例家园18号1301',
  ]) {
    assert.equal(extractAddressCandidate({ title: '地址核查', content }), null, content);
  }
});

test('does not fabricate a detailed candidate when an immediate complaint predicate resembles the settlement name', () => {
  assert.equal(
    extractAddressCandidate({ title: '地址核查', content: '我是联棚乡投诉示例家园18号1301' }),
    null
  );
});

test('extracts an unparented settlement after an explicit leading location introduction', () => {
  const result = extractAddressCandidate({ title: '地址核查', content: '我住在示例社区18号1301' });
  assert.equal(result?.value, '示例社区18号1301');
});

test('maps a legacy stored address candidate without invented location metadata', async () => {
  const db = new CandidateFake() as unknown as CandidateFake & Queryable;
  db.row = {
    complaintId: 'C1', candidateText: '点军区联棚乡示例小区18号1301', evidenceText: '点军区联棚乡示例小区18号1301',
    sourceField: 'content', extractorVersion: 'address-extract.v1', inputHash: 'legacy-hash',
  };

  const result = await findAddressCandidate(db, 'C1');
  assert.equal(result?.districtCode, null);
  assert.equal(result?.parentMatch, null);
  assert.equal(result?.snapshotId, null);
});

test('starts the candidate at the address boundary after request wording', () => {
  const result = extractAddressCandidate({
    title: '地址诉求',
    content: '请处理点军区联棚乡示例小区18号1301的居民诉求。',
  });
  assert.equal(result?.value, '点军区联棚乡示例小区18号1301');
});

test('rejects a second conflicting door number even when the second mention is shortened', () => {
  assert.equal(
    extractAddressCandidate({
      title: '地址核实',
      content: '点军区联棚乡示例小区18号1301，实际是同小区19号1301',
    }),
    null
  );
});

test('keeps introduction wording out of the value and evidence without splicing text', () => {
  const result = extractAddressCandidate({
    title: '地址诉求',
    content: '本人居住在点军区联棚乡示例小区18号1301的居民',
  });
  assert.equal(result?.value, '点军区联棚乡示例小区18号1301');
  assert.equal(result?.evidence, '点军区联棚乡示例小区18号1301');
});

test('skips greeting and punctuation before an introduction', () => {
  const result = extractAddressCandidate({
    title: '地址诉求',
    content: '您好，我是点军区联棚乡示例小区18号1301的居民',
  });
  assert.equal(result?.value, '点军区联棚乡示例小区18号1301');
  assert.equal(result?.evidence, '点军区联棚乡示例小区18号1301');
});

test('skips leading whitespace before an introduction', () => {
  const result = extractAddressCandidate({
    title: '地址诉求',
    content: '  我是点军区联棚乡示例小区18号1301的居民',
  });
  assert.equal(result?.value, '点军区联棚乡示例小区18号1301');
  assert.equal(result?.evidence, '点军区联棚乡示例小区18号1301');
});

test('returns no candidate when there is no reliable address or multiple distinct addresses', () => {
  assert.equal(extractAddressCandidate({ title: '报装催办', content: '何时可以安装？' }), null);
  const first = '点军区联棚乡示例小区18号1301';
  const second = '伍家岗区虚构乡示例小区2号501';
  assert.equal(extractAddressCandidate({ title: '单地址', content: first })?.value, first);
  assert.equal(extractAddressCandidate({ title: '单地址', content: second })?.value, second);
  assert.equal(
    extractAddressCandidate({
      title: '两个地址',
      content: `${first}，${second}`,
    }),
    null
  );
});

test('hashes title and body deterministically and detects body changes', () => {
  assert.equal(
    addressInputHash({ title: '燃气安装', content: '示例正文' }),
    addressInputHash({ title: '燃气安装', content: '示例正文' })
  );
  assert.notEqual(
    addressInputHash({ title: '燃气安装', content: '示例正文' }),
    addressInputHash({ title: '燃气安装', content: '变更正文' })
  );
});

test('candidate storage creates once, updates changed input, and removes only the candidate', async () => {
  const db = new CandidateFake() as unknown as Queryable;
  const initial = {
    title: '燃气安装',
    content: '点军区联棚乡示例小区18号1301的居民反映安装进度。',
  };
  assert.equal(await syncAddressCandidate(db, 'C1', initial), 'created');
  assert.equal(await syncAddressCandidate(db, 'C1', initial), 'unchanged');
  assert.equal(await syncAddressCandidate(db, 'C1', {
    title: '燃气安装',
    content: '点军区联棚乡示例小区19号1301的居民反映安装进度。',
  }), 'updated');
  const fake = db as unknown as CandidateFake;
  const beforeRemove = fake.row;
  assert.equal(await syncAddressCandidate(db, 'C1', { title: '催办', content: '何时安装？' }), 'removed');
  assert.notEqual(fake.row, beforeRemove);
  assert.equal(fake.row, null);
  assert.equal(fake.operations, 3);
});

test('does not create a fillable candidate for historical or denied address wording', () => {
  for (const content of [
    '原来住在：联棚乡示例家园18号1301，现在地址尚待核实',
    '不是在 示例社区18号1301',
  ]) {
    assert.equal(extractAddressCandidate({ title: '地址核查', content }), null, content);
  }
});

test('does not keep a detailed candidate when a second incompatible settlement is named', () => {
  assert.equal(
    extractAddressCandidate({ title: '地址核查', content: '联棚乡示例家园18号1301，样例社区也有相同问题' }),
    null,
  );
});

test('re-extracts an unchanged input when the address rule version changes', async () => {
  const input = { title: '地址核查', content: '点军区联棚乡示例小区18号1301' };
  const db = new CandidateFake() as unknown as CandidateFake & Queryable;
  db.row = {
    complaintId: 'C1', candidateText: '点军区联棚乡示例小区18号1301', evidenceText: '点军区联棚乡示例小区18号1301',
    sourceField: 'content', extractorVersion: 'address-extract.v1', inputHash: addressInputHash(input),
  };

  assert.equal(await syncAddressCandidate(db, 'C1', input), 'updated');
  assert.equal((db as unknown as CandidateFake).row?.extractorVersion, 'address-extract.v3');
});
