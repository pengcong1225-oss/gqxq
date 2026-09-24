import { getTownshipSnapshot, type TownshipSnapshot } from './townshipGazetteer';
import { hasImmediateComplaintPredicate, isRejectedLocationContext } from './locationContext';

export const LOCATION_EXTRACTOR_VERSION = 'location-extract.v2';

export interface ExtractedLocationClue {
  kind: 'township' | 'settlement';
  value: string;
  evidence: string;
  sourceField: 'title' | 'content';
  start: number;
  end: number;
  townshipCode: string | null;
  districtCode: string | null;
  parentMatch: 'explicit' | 'unique_township' | 'unresolved';
  extractorVersion: string;
  snapshotId: string;
}

export interface LocationExtraction {
  clues: ExtractedLocationClue[];
  conflict: boolean;
}

interface TownshipMatch {
  name: string;
  code: string;
  countyCode: string;
  countyName: string;
  start: number;
  end: number;
}

const SETTLEMENT_SUFFIX = /^[\u4e00-\u9fff]{1,4}?(?:家园|小区|社区|村|花园|苑|公寓|家属院)/;
const UNPARENTED_SETTLEMENT_SUFFIX = /^[\u4e00-\u9fff]{1,4}?(?:家园|小区|社区|村|花园|苑|公寓|家属院)/;
const SETTLEMENT_CONNECTOR = /^(?:居民)?(?:居住在|住在)/;
const SETTLEMENT_SEPARATOR = /^[，,、：:\s]*/;
const DOOR_SUFFIX = /^(?:[0-9一二三四五六七八九十百]{1,5}号[0-9]{1,4}(?:室)?|[0-9]{1,4}栋[0-9]{1,4}(?:单元)?[0-9]{1,4}室)?/;
const SETTLEMENT_INTRODUCTION = /^(?:(?:您好|你好)[，,、：:\s]*)?(?:本人居住在|本人住在|本人家住|本人居住于|本人住于|我是|我家在|我住在|家住|地址是|位于|住在)/;
const SHORT_DOOR_INTRODUCTION = /^(?:实际(?:是|为)|准确(?:地址|门牌)?(?:是|为)|门牌(?:号)?(?:是|为)|更正(?:为|成)|具体(?:是|为)|应为|应该是)[，,：:\s]*/;
const REJECTED_LOCATION_CLAUSE = /^(?:原来|以前|过去|曾经|之前|旧址|不是|并非|不在|非|没有|无关|不属于)/;
const COMPLAINT_LOCATION_CLAUSE = /^(?:(?:居民|群众|本人|我)?(?:投诉|举报|反映|咨询|告知|要求|请求|催促|建议|希望|询问|追问))/;
const CLAUSE_BOUNDARY = /[^，,。；;：:\n]+/g;

function findTownships(text: string, snapshot: TownshipSnapshot): TownshipMatch[] {
  const matches: TownshipMatch[] = [];
  for (const county of snapshot.counties) {
    for (const township of county.townships) {
      let from = 0;
      while (from < text.length) {
        const start = text.indexOf(township.name, from);
        if (start < 0) break;
        const end = start + township.name.length;
        if (!isRejectedLocationContext(text, start)) {
          matches.push({ name: township.name, code: township.code, countyCode: county.code, countyName: county.name, start, end });
        }
        from = start + township.name.length;
      }
    }
  }
  return matches.sort((left, right) => left.start - right.start || right.end - left.end);
}

function explicitCountyCode(text: string, townshipStart: number, snapshot: TownshipSnapshot): string | null {
  const preceding = text.slice(Math.max(0, townshipStart - 12), townshipStart);
  const county = snapshot.counties.find((item) => preceding.endsWith(item.name) || preceding.endsWith(`${item.name}的`));
  return county?.code ?? null;
}

function clue(
  kind: ExtractedLocationClue['kind'],
  text: string,
  sourceField: 'title' | 'content',
  start: number,
  end: number,
  township: TownshipMatch | null,
  explicitDistrictCode: string | null,
  snapshot: TownshipSnapshot
): ExtractedLocationClue {
  const evidence = text.slice(start, end);
  return {
    kind,
    value: evidence,
    evidence,
    sourceField,
    start,
    end,
    townshipCode: township?.code ?? null,
    districtCode: township ? (explicitDistrictCode ?? township.countyCode) : null,
    parentMatch: township ? (explicitDistrictCode ? 'explicit' : 'unique_township') : 'unresolved',
    extractorVersion: LOCATION_EXTRACTOR_VERSION,
    snapshotId: snapshot.snapshotId,
  };
}

function extractBoundedClues(input: { title: string; content: string | null }, snapshot: TownshipSnapshot): ExtractedLocationClue[] {
  const fields: Array<{ name: 'title' | 'content'; text: string | null }> = [
    { name: 'title', text: input.title },
    { name: 'content', text: input.content },
  ];
  const found: ExtractedLocationClue[] = [];

  for (const field of fields) {
    const text = field.text;
    if (!text) continue;
    const townshipMatches = findTownships(text, snapshot);
    const firstTextOffset = /^\s*/.exec(text)?.[0].length ?? 0;
    for (const township of townshipMatches) {
      const explicitCode = explicitCountyCode(text, township.start, snapshot);
      found.push(clue('township', text, field.name, township.start, township.end, township, explicitCode, snapshot));

      const remainder = text.slice(township.end);
      const connector = SETTLEMENT_CONNECTOR.exec(remainder);
      const afterConnector = remainder.slice(connector?.[0].length ?? 0);
      const separator = SETTLEMENT_SEPARATOR.exec(afterConnector);
      const settlementStart = township.end + (connector?.[0].length ?? 0) + (separator?.[0].length ?? 0);
      if (!connector && hasImmediateComplaintPredicate(text.slice(settlementStart))) continue;
      const settlement = SETTLEMENT_SUFFIX.exec(text.slice(settlementStart));
      if (settlement) {
        const tailStart = settlementStart + settlement[0].length;
        const door = DOOR_SUFFIX.exec(text.slice(tailStart))?.[0] ?? '';
        const end = tailStart + door.length;
        found.push(clue('settlement', text, field.name, settlementStart, end, township, explicitCode, snapshot));
      }
    }

    for (const clause of text.matchAll(CLAUSE_BOUNDARY)) {
      const clauseStart = clause.index!;
      const clauseEnd = clauseStart + clause[0].length;
      if (townshipMatches.some((township) => township.start >= clauseStart && township.start < clauseEnd)) continue;
      const leading = /^\s*/.exec(clause[0])?.[0].length ?? 0;
      const candidateOffset = clauseStart + leading;
      const candidateText = text.slice(candidateOffset, clauseEnd);
      if (REJECTED_LOCATION_CLAUSE.test(candidateText) || COMPLAINT_LOCATION_CLAUSE.test(candidateText)) continue;
      const introduction = SETTLEMENT_INTRODUCTION.exec(candidateText);
      const afterIntroduction = candidateOffset + (introduction?.[0].length ?? 0);
      const separator = SETTLEMENT_SEPARATOR.exec(text.slice(afterIntroduction))?.[0].length ?? 0;
      const start = afterIntroduction + separator;
      const settlement = UNPARENTED_SETTLEMENT_SUFFIX.exec(text.slice(start, clauseEnd));
      if (!settlement || isRejectedLocationContext(text, start)) continue;
      const afterName = start + settlement[0].length;
      const door = DOOR_SUFFIX.exec(text.slice(afterName, clauseEnd))?.[0] ?? '';
      const hasEarlierNamedLocation = found.some((item) => item.sourceField === field.name && item.kind === 'settlement' && item.end <= start);
      const isStandaloneTitleAddress = field.name === 'title' && candidateOffset === firstTextOffset && !introduction &&
        candidateText.trim() === `${settlement[0]}${door}` && Boolean(door);
      if (!introduction && door && !hasEarlierNamedLocation && !isStandaloneTitleAddress) continue;
      found.push(clue('settlement', text, field.name, start, afterName + door.length, null, null, snapshot));
    }

    // A shortened door is useful only as an explicit correction in this clause, outside
    // named-location coverage, with one township and a complete address in the same field.
    if (townshipMatches.length === 1) {
      const completeMentions = found.filter((item) => item.sourceField === field.name && item.kind === 'settlement');
      const completeAddress = completeMentions.some((item) => /^[\u4e00-\u9fff].*\d{1,4}号\d{1,4}/.test(item.evidence));
      if (completeAddress) {
        for (const clause of text.matchAll(CLAUSE_BOUNDARY)) {
          const clauseStart = clause.index!;
          const clauseEnd = clauseStart + clause[0].length;
          const clauseText = clause[0].trimStart();
          if (REJECTED_LOCATION_CLAUSE.test(clauseText) || COMPLAINT_LOCATION_CLAUSE.test(clauseText)) continue;
          const introduction = SHORT_DOOR_INTRODUCTION.exec(clauseText);
          if (!introduction) continue;
          const start = clauseStart + (clause[0].length - clauseText.length) + introduction[0].length;
          const reference = DOOR_SUFFIX.exec(text.slice(start, clauseEnd))?.[0] ?? '';
          if (!reference) continue;
          const end = start + reference.length;
          if (completeMentions.some((item) => start >= item.start && end <= item.end)) continue;
          if (isRejectedLocationContext(text, start)) continue;
          const township = townshipMatches[0];
          found.push(clue('settlement', text, field.name, start, end, township, explicitCountyCode(text, township.start, snapshot), snapshot));
        }
      }
    }
  }

  const unique = new Map<string, ExtractedLocationClue>();
  for (const item of found) {
    const key = `${item.kind}\0${item.value}\0${item.townshipCode ?? ''}`;
    if (item.kind === 'settlement') {
      const samePlace = [...unique.entries()].find(([, existing]) => existing.kind === 'settlement' && existing.value === item.value &&
        (existing.townshipCode === null) !== (item.townshipCode === null));
      if (samePlace) {
        const [existingKey, existing] = samePlace;
        if (existing.townshipCode === null && item.townshipCode !== null) unique.delete(existingKey);
        else continue;
      }
    }
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()].sort((left, right) => left.sourceField.localeCompare(right.sourceField) || left.start - right.start || left.end - right.end);
}

export function hasLocationConflict(clues: ExtractedLocationClue[]): boolean {
  if (clues.some((item) => item.kind === 'township' && item.parentMatch === 'explicit' &&
    item.townshipCode !== null && item.districtCode !== item.townshipCode.slice(0, 6))) return true;
  const townships = new Set(clues.filter((item) => item.kind === 'township').map((item) => item.townshipCode).filter(Boolean));
  if (townships.size > 1) return true;
  const settlementNames = new Set<string>();
  const doorsBySettlement = new Map<string, Set<string>>();
  for (const item of clues.filter((candidate) => candidate.kind === 'settlement')) {
    const namedLocation = SETTLEMENT_SUFFIX.exec(item.value)?.[0];
    const name = namedLocation ?? item.value;
    const door = namedLocation ? item.value.slice(namedLocation.length) : '';
    settlementNames.add(name);
    const doors = doorsBySettlement.get(name) ?? new Set<string>();
    if (door) doors.add(door);
    doorsBySettlement.set(name, doors);
  }
  return settlementNames.size > 1 || [...doorsBySettlement.values()].some((doors) => doors.size > 1);
}

export function extractLocation(input: { title: string; content: string | null }): LocationExtraction {
  const clues = extractBoundedClues(input, getTownshipSnapshot());
  return { clues, conflict: hasLocationConflict(clues) };
}
