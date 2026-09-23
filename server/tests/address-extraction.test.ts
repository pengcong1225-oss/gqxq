import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addressInputHash, extractAddressCandidate } from '../src/services/rules/addressExtract';
import { syncAddressCandidate } from '../src/repositories/addressCandidateRepo';
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
        extractorVersion: values[4], inputHash: values[5],
      };
    } else if (sql.startsWith('delete')) {
      this.row = null;
    } else if (sql.startsWith('update')) {
      if (this.row) {
        this.row = {
          complaintId: values[5], candidateText: values[0], evidenceText: values[1], sourceField: values[2],
          extractorVersion: values[3], inputHash: values[4],
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
  const second = '伍家岗区虚构乡另一个示例小区2号501';
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
