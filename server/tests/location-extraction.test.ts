import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { extractLocation, hasLocationConflict } from '../src/services/rules/locationExtract';
import { getTownshipSnapshot, validateTownshipSnapshot } from '../src/services/rules/townshipGazetteer';

test('ships the complete API snapshot with normalized nine-digit township codes and a matching tree hash', () => {
  const snapshot = getTownshipSnapshot();
  const townships = snapshot.counties.flatMap((county) => county.townships);
  const calculatedHash = createHash('sha256').update(JSON.stringify(snapshot.counties)).digest('hex');

  assert.equal(snapshot.approved, false);
  assert.equal(snapshot.sourceUrl, 'https://dmfw.mca.gov.cn/9095/xzqh/getList?code=4205&maxLevel=3');
  assert.equal(snapshot.counties.length, 13);
  assert.equal(townships.length, 110);
  assert.equal(new Set(townships.map((township) => township.code)).size, townships.length);
  assert.equal(new Set(townships.map((township) => township.name)).size, townships.length);
  assert.ok(townships.every((township) => /^\d{9}$/.test(township.code)));
  assert.ok(townships.every((township) => snapshot.counties.some((county) => township.code.startsWith(county.code))));
  assert.equal(townships.find((township) => township.name === '联棚乡')?.code, '420504202');
  assert.equal(calculatedHash, snapshot.countyTownshipSha256);
});

test('validates the same snapshot checksum when county and township arrays are reordered', () => {
  const snapshot = getTownshipSnapshot();
  const reordered = {
    ...snapshot,
    counties: [...snapshot.counties].reverse().map((county) => ({
      ...county,
      townships: [...county.townships].reverse(),
    })),
  };
  assert.doesNotThrow(() => validateTownshipSnapshot(reordered));
});

test('extracts an exact township clue and its unique district from current residence wording', () => {
  const result = extractLocation({ title: '燃气报装', content: '我是联棚乡示例家园18号1301的居民，催促安装' });
  const clue = result.clues.find((candidate) => candidate.kind === 'township');

  assert.equal(clue?.value, '联棚乡');
  assert.equal(clue?.evidence, '联棚乡');
  assert.equal(clue?.sourceField, 'content');
  assert.equal(clue?.townshipCode, '420504202');
  assert.equal(clue?.districtCode, '420504');
  assert.equal(clue?.parentMatch, 'unique_township');
  assert.equal(result.conflict, false);
});

test('rejects an explicitly denied township as a current location', () => {
  const result = extractLocation({ title: '核查', content: '不是联棚乡的住户' });
  assert.equal(result.clues.some((clue) => clue.kind === 'township'), false);
});

test('rejects a historical township as a current location', () => {
  const result = extractLocation({ title: '核查', content: '以前住联棚乡，现在搬走了' });
  assert.equal(result.clues.some((clue) => clue.kind === 'township'), false);
});

test('marks distinct current townships as conflicting and preserves both clues', () => {
  const result = extractLocation({ title: '核查', content: '联棚乡与艾家镇两处' });
  assert.equal(result.conflict, true);
  assert.deepEqual(result.clues.filter((clue) => clue.kind === 'township').map((clue) => clue.value), ['联棚乡', '艾家镇']);
  assert.equal(hasLocationConflict(result.clues), true);
});

test('retains a shortened second door reference as exact source evidence and reports location conflict', () => {
  const result = extractLocation({
    title: '核查',
    content: '联棚乡示例家园18号1301，实际是19号1301',
  });
  assert.equal(result.conflict, true);
  assert.deepEqual(result.clues.filter((clue) => clue.kind === 'settlement').map((clue) => clue.evidence), [
    '示例家园18号1301',
    '19号1301',
  ]);
});

test('uses exact source offsets for a township mention in the title', () => {
  const result = extractLocation({ title: '联棚乡燃气报装', content: null });
  const clue = result.clues.find((candidate) => candidate.kind === 'township');
  assert.equal(clue?.sourceField, 'title');
  assert.equal(clue?.start, 0);
  assert.equal(clue?.end, 3);
  assert.equal('联棚乡燃气报装'.slice(clue!.start, clue!.end), clue?.evidence);
});

test('attaches an explicit district only when the source names it', () => {
  const clue = extractLocation({ title: '核查', content: '点军区联棚乡居民来电' }).clues.find((candidate) => candidate.kind === 'township');
  assert.equal(clue?.districtCode, '420504');
  assert.equal(clue?.parentMatch, 'explicit');
});

test('marks an explicit county that disagrees with the township parent as conflicting', () => {
  const input = { title: '地址核查', content: '点军区西陵街道示例小区18号1301' };
  const result = extractLocation(input);
  const clue = result.clues.find((candidate) => candidate.kind === 'township');
  assert.equal(clue?.townshipCode, '420502001');
  assert.equal(clue?.districtCode, '420504');
  assert.equal(result.conflict, true);
});

test('bounds a settlement clue to the exact named home after a resident connector', () => {
  const text = '我是联棚乡居民住在示例家园18号1301';
  const result = extractLocation({ title: '地址核查', content: text });
  const settlement = result.clues.find((candidate) => candidate.kind === 'settlement');
  assert.equal(settlement?.evidence, '示例家园18号1301');
  assert.equal(settlement?.townshipCode, '420504202');
  assert.equal(text.slice(settlement!.start, settlement!.end), '示例家园18号1301');
  assert.equal(result.conflict, false);
});

test('does not treat a district mentioned elsewhere in the field as the township parent', () => {
  const clue = extractLocation({ title: '核查', content: '点军区另一个地方的工单已结。联棚乡居民来电' }).clues.find((candidate) => candidate.kind === 'township');
  assert.equal(clue?.districtCode, '420504');
  assert.equal(clue?.parentMatch, 'unique_township');
});

test('keeps an unparented settlement clue bounded after resident introduction wording', () => {
  const result = extractLocation({ title: '位置核查', content: '我是示例社区的居民' });
  const clue = result.clues.find((candidate) => candidate.kind === 'settlement');
  assert.equal(clue?.evidence, '示例社区');
  assert.equal(clue?.townshipCode, null);
  assert.equal(clue?.districtCode, null);
  assert.equal(clue?.parentMatch, 'unresolved');
  assert.equal('我是示例社区的居民'.slice(clue!.start, clue!.end), clue?.evidence);
});

test('does not join a distant named settlement across intervening complaint narrative', () => {
  const result = extractLocation({ title: '位置核查', content: '联棚乡居民询问安装，示例家园18号1301' });
  assert.equal(result.clues.some((candidate) => candidate.kind === 'settlement'), false);
  const township = result.clues.find((candidate) => candidate.kind === 'township');
  assert.equal(township?.evidence, '联棚乡');
});
