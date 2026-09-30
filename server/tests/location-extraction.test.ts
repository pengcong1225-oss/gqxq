import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { extractLocation, hasLocationConflict } from '../src/services/rules/locationExtract';
import { getTownshipSnapshot, validateTownshipSnapshot } from '../src/services/rules/townshipGazetteer';

test('ships the complete API snapshot with normalized nine-digit township codes and a matching tree hash', () => {
  const snapshot = getTownshipSnapshot();
  const townships = snapshot.counties.flatMap((county) => county.townships);
  const calculatedHash = createHash('sha256').update(JSON.stringify(snapshot.counties)).digest('hex');

  assert.equal(snapshot.approved, true);
  assert.equal(snapshot.snapshotId, 'yichang-2026-09-24-api-hubei-2025-approved');
  assert.deepEqual(snapshot.verification, {
    baselineAsOf: '2025-12-31',
    sourceUrl: 'https://mzt.hubei.gov.cn/ywzc/ywzc/qhc/202601/P020260112578515467143.xlsx',
    sourceSha256: '84ABDA454508280CE14262673B1547ACEDE071C1F68F5F4C394A409ECAF40403',
    verifiedAt: '2026-09-24T04:57:16.000Z',
  });
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
  assert.equal(clue?.extractorVersion, 'location-extract.v2');
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

test('does not accept intervening complaint prose as part of a settlement name', () => {
  const result = extractLocation({ title: '地址核查', content: '我是联棚乡居民投诉示例家园18号1301' });
  assert.equal(result.clues.some((candidate) => candidate.kind === 'settlement'), false);
});

test('does not accept clause prose before a township-associated settlement suffix', () => {
  const result = extractLocation({ title: '地址核查', content: '我是联棚乡群众告知示例家园18号1301' });
  assert.equal(result.clues.some((candidate) => candidate.kind === 'settlement'), false);
});

test('recognizes a directly bounded settlement name following a township', () => {
  const result = extractLocation({ title: '地址核查', content: '我是联棚乡示例家园18号1301' });
  const settlement = result.clues.find((candidate) => candidate.kind === 'settlement');
  assert.equal(settlement?.evidence, '示例家园18号1301');
  assert.equal(settlement?.townshipCode, '420504202');
});

test('extracts a four-character township-linked settlement name', () => {
  const text = '联棚乡恒大名都小区18号1301';
  const result = extractLocation({ title: '地址核查', content: text });
  const settlement = result.clues.find((candidate) => candidate.kind === 'settlement');
  assert.equal(settlement?.evidence, '恒大名都小区18号1301');
  assert.equal(settlement?.townshipCode, '420504202');
  assert.equal(text.slice(settlement!.start, settlement!.end), settlement?.evidence);
});

test('does not promote longer complaint prose to a township-linked settlement', () => {
  for (const content of [
    '我是联棚乡群众告知示例家园18号1301',
    '我是联棚乡居民投诉示例家园18号1301',
  ]) {
    const result = extractLocation({ title: '地址核查', content });
    assert.equal(result.clues.some((candidate) => candidate.kind === 'settlement'), false, content);
  }
});

test('does not treat an immediate complaint predicate as a four-character settlement name', () => {
  const result = extractLocation({ title: '地址核查', content: '我是联棚乡投诉示例家园18号1301' });
  assert.equal(result.clues.some((candidate) => candidate.kind === 'settlement'), false);
});

test('extracts an unparented settlement after the supported 我住在 introduction', () => {
  const text = '我住在示例社区';
  const result = extractLocation({ title: '地址核查', content: text });
  const settlement = result.clues.find((candidate) => candidate.kind === 'settlement');
  assert.equal(settlement?.evidence, '示例社区');
  assert.equal(text.slice(settlement!.start, settlement!.end), '示例社区');
  assert.equal(settlement?.parentMatch, 'unresolved');
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

test('keeps an unparented settlement in another clause and marks the two places conflicting', () => {
  const result = extractLocation({ title: '地址核查', content: '联棚乡示例家园18号1301，样例社区也有相同问题' });
  assert.equal(result.conflict, true);
  assert.deepEqual(result.clues.filter((clue) => clue.kind === 'settlement').map((clue) => [clue.evidence, clue.parentMatch]), [
    ['示例家园18号1301', 'unique_township'],
    ['样例社区', 'unresolved'],
  ]);
});

test('does not turn a repeated complete address into a bare door clue or conflict', () => {
  const result = extractLocation({ title: '地址核查', content: '联棚乡示例家园18号1301，请核查联棚乡示例家园18号1301' });
  assert.equal(result.conflict, false);
  assert.deepEqual(result.clues.filter((clue) => clue.kind === 'settlement').map((clue) => clue.evidence), ['示例家园18号1301']);
});

test('does not create a bare door clue or conflict for a repeated named address in the next clause', () => {
  const result = extractLocation({ title: '地址核查', content: '联棚乡示例家园18号1301，示例家园18号1301' });
  assert.equal(result.conflict, false);
  assert.deepEqual(result.clues.filter((clue) => clue.kind === 'settlement').map((clue) => [clue.evidence, clue.townshipCode]), [
    ['示例家园18号1301', '420504202'],
  ]);
});

test('preserves a second named address without inheriting the first township', () => {
  const result = extractLocation({ title: '地址核查', content: '联棚乡示例家园18号1301，样例社区20号1301' });
  assert.equal(result.conflict, true);
  assert.deepEqual(result.clues.filter((clue) => clue.kind === 'settlement').map((clue) => [clue.evidence, clue.townshipCode, clue.parentMatch]), [
    ['示例家园18号1301', '420504202', 'unique_township'],
    ['样例社区20号1301', null, 'unresolved'],
  ]);
});

test('preserves a four-character unparented estate name and its door after a complete address', () => {
  const result = extractLocation({ title: '地址核查', content: '联棚乡示例家园18号1301，恒大名都小区20号1301' });
  assert.equal(result.conflict, true);
  assert.deepEqual(result.clues.filter((clue) => clue.kind === 'settlement').map((clue) => [clue.evidence, clue.townshipCode, clue.parentMatch]), [
    ['示例家园18号1301', '420504202', 'unique_township'],
    ['恒大名都小区20号1301', null, 'unresolved'],
  ]);
});

test('compares a complete address in the title with the address in the content', () => {
  const result = extractLocation({ title: '样例社区20号1301', content: '联棚乡示例家园18号1301' });
  assert.equal(result.conflict, true);
  assert.deepEqual(result.clues.filter((clue) => clue.kind === 'settlement').map((clue) => [clue.sourceField, clue.evidence, clue.townshipCode]), [
    ['content', '示例家园18号1301', '420504202'],
    ['title', '样例社区20号1301', null],
  ]);
});

test('does not promote an address clause embedded in a complaint title to a standalone title address', () => {
  const result = extractLocation({ title: '投诉标题：样例社区20号1301', content: '联棚乡示例家园18号1301' });
  assert.equal(result.conflict, false);
  assert.deepEqual(result.clues.filter((clue) => clue.kind === 'settlement').map((clue) => [clue.sourceField, clue.evidence]), [
    ['content', '示例家园18号1301'],
  ]);
});

test('recognizes a standalone complete address in the content when the title has a township address', () => {
  const result = extractLocation({ title: '联棚乡示例家园18号1301', content: '样例社区20号1301' });
  assert.equal(result.conflict, true);
  assert.deepEqual(result.clues.filter((clue) => clue.kind === 'settlement').map((clue) => [clue.sourceField, clue.evidence, clue.townshipCode]), [
    ['content', '样例社区20号1301', null],
    ['title', '示例家园18号1301', '420504202'],
  ]);
});

test('recognizes standalone complete addresses in title and content symmetrically', () => {
  const result = extractLocation({ title: '样例社区20号1301', content: '恒大名都小区18号1301' });
  assert.equal(result.conflict, true);
  assert.deepEqual(result.clues.filter((clue) => clue.kind === 'settlement').map((clue) => [clue.sourceField, clue.evidence, clue.townshipCode]), [
    ['content', '恒大名都小区18号1301', null],
    ['title', '样例社区20号1301', null],
  ]);
});

test('recognizes a direct address in the first content clause without promoting complaint narrative', () => {
  const result = extractLocation({ title: '联棚乡示例家园18号1301', content: '样例社区20号1301，燃气未装' });
  assert.equal(result.conflict, true);
  assert.ok(result.clues.some((clue) => clue.kind === 'settlement' && clue.sourceField === 'content' && clue.evidence === '样例社区20号1301'));
});

test('does not promote complaint, historical, negative, or old-address clauses to current locations', () => {
  for (const content of [
    '居民投诉样例社区20号1301燃气未装',
    '投诉记录：样例社区20号1301',
    '原来住在样例社区20号1301',
    '不是样例社区20号1301',
    '样例社区20号1301是旧址',
  ]) {
    const result = extractLocation({ title: '联棚乡示例家园18号1301', content });
    assert.equal(result.conflict, false, content);
    assert.equal(result.clues.some((clue) => clue.kind === 'settlement' && clue.sourceField === 'content'), false, content);
  }
});

test('does not treat a second named address followed by an old-address label as current', () => {
  for (const suffix of ['是旧址', '为原地址', '是以前地址']) {
    const content = `联棚乡示例家园18号1301，样例社区20号1301${suffix}`;
    const result = extractLocation({ title: '地址核查', content });
    assert.equal(result.conflict, false, suffix);
    assert.deepEqual(result.clues.filter((clue) => clue.kind === 'settlement').map((clue) => clue.evidence), ['示例家园18号1301'], suffix);
  }
});

test('treats a no-door mention of the same named settlement as compatible with its full address', () => {
  const result = extractLocation({ title: '地址核查', content: '联棚乡示例家园18号1301，示例家园燃气还没装' });
  assert.equal(result.conflict, false);
});

test('keeps different door numbers within the same named settlement conflicting', () => {
  const result = extractLocation({ title: '地址核查', content: '联棚乡示例家园18号1301，示例家园20号1301' });
  assert.equal(result.conflict, true);
  assert.deepEqual(result.clues.filter((clue) => clue.kind === 'settlement').map((clue) => clue.evidence), [
    '示例家园18号1301',
    '示例家园20号1301',
  ]);
});

test('treats an optional 室 suffix as the same door number', () => {
  for (const content of [
    '联棚乡示例家园18号1301，示例家园18号1301室',
    '联棚乡示例家园18号1301室，示例家园18号1301',
  ]) {
    assert.equal(extractLocation({ title: '地址核查', content }).conflict, false, content);
  }
});

test('treats an explicit short-door correction matching the complete address as compatible', () => {
  const result = extractLocation({ title: '地址核查', content: '联棚乡示例家园18号1301，实际是18号1301' });
  assert.equal(result.conflict, false);
  assert.deepEqual(result.clues.filter((clue) => clue.kind === 'settlement').map((clue) => clue.evidence), [
    '示例家园18号1301',
    '18号1301',
  ]);
});

test('retains a later full address after an earlier mention of the same settlement without a door', () => {
  const result = extractLocation({ title: '地址核查', content: '联棚乡示例家园，示例家园18号1301' });
  assert.equal(result.conflict, false);
  assert.deepEqual(result.clues.filter((clue) => clue.kind === 'settlement').map((clue) => clue.evidence), [
    '示例家园',
    '示例家园18号1301',
  ]);
});

test('does not treat historical or denied second-clause locations as current addresses', () => {
  for (const clause of ['原来住在样例社区20号1301', '并非住在样例社区20号1301']) {
    const result = extractLocation({ title: '地址核查', content: `联棚乡示例家园18号1301，${clause}` });
    assert.equal(result.conflict, false, clause);
    assert.deepEqual(result.clues.filter((clue) => clue.kind === 'settlement').map((clue) => clue.evidence), ['示例家园18号1301'], clause);
  }
});

test('does not attach an address mentioned in a complaint clause to the first township', () => {
  const result = extractLocation({ title: '地址核查', content: '联棚乡示例家园18号1301，投诉示例家园20号1301' });
  assert.equal(result.conflict, false);
  assert.deepEqual(result.clues.filter((clue) => clue.kind === 'settlement').map((clue) => clue.evidence), ['示例家园18号1301']);
});

test('does not attribute the door number of a second named location to the first township', () => {
  const result = extractLocation({ title: '地址核查', content: '联棚乡示例家园18号1301，西陵街道样例家园20号1301' });
  assert.equal(result.conflict, true);
  assert.deepEqual(result.clues.filter((clue) => clue.kind === 'settlement').map((clue) => [clue.evidence, clue.townshipCode]), [
    ['示例家园18号1301', '420504202'],
    ['样例家园20号1301', '420502001'],
  ]);
});

test('rejects historical and negative settlement clues across punctuation and spaces', () => {
  for (const content of [
    '原来住在：联棚乡示例家园18号1301，现在地址尚待核实',
    '不是在 示例社区18号1301',
  ]) {
    assert.equal(extractLocation({ title: '地址核查', content }).clues.some((clue) => clue.kind === 'settlement'), false, content);
  }
});
