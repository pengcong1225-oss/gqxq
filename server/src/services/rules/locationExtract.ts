import { getTownshipSnapshot, type TownshipSnapshot } from './townshipGazetteer';
import type { AddressInput } from './addressExtract';

export const LOCATION_EXTRACTOR_VERSION = 'location-extract.v1';

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

const SETTLEMENT_SUFFIX = /^[\u4e00-\u9fff]{1,16}?(?:家园|小区|社区|村|花园|苑|公寓|家属院)/;
const SETTLEMENT_CONNECTOR = /^(?:居民)?(?:居住在|住在)/;
const SETTLEMENT_SEPARATOR = /^[，,、：:\s]*/;
const DOOR_SUFFIX = /^(?:[0-9一二三四五六七八九十百]{1,5}号[0-9]{1,4}(?:室)?|[0-9]{1,4}栋[0-9]{1,4}(?:单元)?[0-9]{1,4}室)?/;
const NEGATIVE_OR_REPORTED_CONTEXT = /(?:不是|并非|不在|非|没有|无关|不属于|以前|过去|原来|曾经|之前|旧址|转交到|搬离|离开)(?:[\u4e00-\u9fff]{0,4}|\s*)$/;
const SETTLEMENT_PATTERN = /[\u4e00-\u9fff]{2,16}?(?:家园|小区|社区|村|花园|苑|公寓|家属院)(?:[0-9一二三四五六七八九十百]{1,5}号[0-9]{1,4}(?:室)?|[0-9]{1,4}栋[0-9]{1,4}(?:单元)?[0-9]{1,4}室)?/g;
const SETTLEMENT_INTRODUCTION = /^(?:(?:您好|你好)[，,、：:\s]*)?(?:本人居住在|本人住在|本人家住|本人居住于|本人住于|我是|我家在|我住在|家住|地址是|位于|住在)/;

function isRejectedContext(text: string, start: number): boolean {
  return NEGATIVE_OR_REPORTED_CONTEXT.test(text.slice(Math.max(0, start - 12), start));
}

function findTownships(text: string, snapshot: TownshipSnapshot): TownshipMatch[] {
  const matches: TownshipMatch[] = [];
  for (const county of snapshot.counties) {
    for (const township of county.townships) {
      let from = 0;
      while (from < text.length) {
        const start = text.indexOf(township.name, from);
        if (start < 0) break;
        const end = start + township.name.length;
        if (!isRejectedContext(text, start)) {
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

function extractBoundedClues(input: AddressInput, snapshot: TownshipSnapshot): ExtractedLocationClue[] {
  const fields: Array<{ name: 'title' | 'content'; text: string | null }> = [
    { name: 'title', text: input.title },
    { name: 'content', text: input.content },
  ];
  const found: ExtractedLocationClue[] = [];

  for (const field of fields) {
    const text = field.text;
    if (!text) continue;
    const townshipMatches = findTownships(text, snapshot);
    for (const township of townshipMatches) {
      const explicitCode = explicitCountyCode(text, township.start, snapshot);
      found.push(clue('township', text, field.name, township.start, township.end, township, explicitCode, snapshot));

      const remainder = text.slice(township.end);
      const connector = SETTLEMENT_CONNECTOR.exec(remainder);
      const afterConnector = remainder.slice(connector?.[0].length ?? 0);
      const separator = SETTLEMENT_SEPARATOR.exec(afterConnector);
      const settlementStart = township.end + (connector?.[0].length ?? 0) + (separator?.[0].length ?? 0);
      const settlement = SETTLEMENT_SUFFIX.exec(text.slice(settlementStart));
      if (settlement) {
        const tailStart = settlementStart + settlement[0].length;
        const door = DOOR_SUFFIX.exec(text.slice(tailStart))?.[0] ?? '';
        const end = tailStart + door.length;
        found.push(clue('settlement', text, field.name, settlementStart, end, township, explicitCode, snapshot));

        const firstDoor = /\d{1,4}号\d{1,4}(?:室)?/g.exec(door);
        const firstDoorEnd = firstDoor ? tailStart + firstDoor.index + firstDoor[0].length : end;
        const laterReferences = [...text.matchAll(/\d{1,4}号\d{1,4}(?:室)?/g)].filter((match) => match.index! >= firstDoorEnd);
        for (const reference of laterReferences) {
          const start = reference.index!;
          found.push(clue('settlement', text, field.name, start, start + reference[0].length, township, explicitCode, snapshot));
        }
      }
    }

    if (townshipMatches.length === 0) {
      for (const settlement of text.matchAll(SETTLEMENT_PATTERN)) {
        const rawStart = settlement.index!;
        const end = rawStart + settlement[0].length;
        const introduction = SETTLEMENT_INTRODUCTION.exec(settlement[0]);
        const start = rawStart + (introduction?.[0].length ?? 0);
        if (!isRejectedContext(text, rawStart)) found.push(clue('settlement', text, field.name, start, end, null, null, snapshot));
      }
    }
  }

  const unique = new Map<string, ExtractedLocationClue>();
  for (const item of found) {
    const key = `${item.kind}\0${item.value}\0${item.townshipCode ?? ''}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  return [...unique.values()].sort((left, right) => left.sourceField.localeCompare(right.sourceField) || left.start - right.start || left.end - right.end);
}

export function hasLocationConflict(clues: ExtractedLocationClue[]): boolean {
  if (clues.some((item) => item.kind === 'township' && item.parentMatch === 'explicit' &&
    item.townshipCode !== null && item.districtCode !== item.townshipCode.slice(0, 6))) return true;
  const townships = new Set(clues.filter((item) => item.kind === 'township').map((item) => item.townshipCode).filter(Boolean));
  if (townships.size > 1) return true;
  const settlements = new Set(clues.filter((item) => item.kind === 'settlement').map((item) => item.value));
  return settlements.size > 1;
}

export function extractLocation(input: AddressInput): LocationExtraction {
  const clues = extractBoundedClues(input, getTownshipSnapshot());
  return { clues, conflict: hasLocationConflict(clues) };
}
