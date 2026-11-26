import { createHash } from 'node:crypto';
import { getTownshipSnapshot } from './townshipGazetteer';
import { extractLocation } from './locationExtract';
import { hasImmediateComplaintPredicate, isRejectedLocationContext } from './locationContext';

export const ADDRESS_EXTRACTOR_VERSION = 'address-extract.v4';

export interface ExtractedAddressCandidate {
  value: string;
  evidence: string;
  sourceField: 'title' | 'content';
  extractorVersion: typeof ADDRESS_EXTRACTOR_VERSION;
  districtCode: string | null;
  parentMatch: 'explicit' | 'unique_township' | 'unresolved' | null;
  snapshotId: string | null;
}

export interface AddressInput { title: string; content: string | null }

const SETTLEMENT = '[\\u4e00-\\u9fff]{1,2}?(?:家园|小区|社区|村|花园|苑|公寓|家属院)';
const TOWNSHIP_SETTLEMENT = '[\\u4e00-\\u9fff]{1,4}?(?:家园|小区|社区|村|花园|苑|公寓|家属院)';
const DOOR = '(?:[0-9一二三四五六七八九十百]{1,5}号[0-9]{1,4}(?:室)?|[0-9]{1,4}栋[0-9]{1,4}(?:单元)?[0-9]{1,4}室)';
const RESIDENT_CONNECTOR = '(?:居民)?(?:居住在|住在)';
const DOOR_REFERENCE_PATTERN = /\d{1,4}号\d{1,4}(?:室)?/g;
const LEADING_INTRODUCTION = /^\s*(?:(?:您好|你好)[，,、：:\s]*)?(?:本人居住在|本人住在|本人家住|本人居住于|本人住于|我是|我家在|我住在|家住|地址是|位于|住在|请处理)/;
const ADDRESS_CLAUSE_INTRO = /^(?:事发地(?:点)?(?:在|是|为|位于)|诉求地址(?:在|是|为|位于)|(?:具体)?地址(?:在|是|为)|现住在|居住在|我家住|我家在|本人家住|家住|位于|住在|我是)\s*[：:]?\s*/;
const PLACE_NAME = '[\\u4e00-\\u9fffA-Za-z0-9·]{2,24}?';
const PLACE_SUFFIX = '(?:家园|小区|社区|花园|苑|公寓|家属院|住宅区|居民区)';
const HOUSE_NUMBER = '[0-9一二三四五六七八九十百]{1,5}(?:号|弄)';
const PLACE_ADDRESS = new RegExp(`^(?:${PLACE_NAME}${PLACE_SUFFIX}(?:${DOOR}|${HOUSE_NUMBER})?|${PLACE_NAME}(?:大道|路|街|巷|弄)${HOUSE_NUMBER})(?=$|的(?:居民|业主)|(?:居民|业主)?(?:反映|投诉|反馈))`);
const COMMUNITY_NAME = new RegExp(`^(${PLACE_NAME}${PLACE_SUFFIX})(?:${DOOR}|${HOUSE_NUMBER})?$`);
const NON_ADDRESS_NAME = /居民(?:投诉|反映|要求)|群众|投诉|反映|燃气|停气|停水|供水|问题|目前|尚待|同小区|该小区|本小区|[0-9]{7,}/;
export { hasImmediateComplaintPredicate } from './locationContext';

interface AddressMatch {
  value: string;
  start: number;
  end: number;
  townshipCode: string | null;
  districtCode: string | null;
  explicitDistrict: boolean;
  parentConflict: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addressPattern(): RegExp {
  const snapshot = getTownshipSnapshot();
  const counties = snapshot.counties.map((county) => escapeRegExp(county.name)).sort((a, b) => b.length - a.length);
  const townships = snapshot.counties.flatMap((county) => county.townships.map((township) => ({ ...township, countyCode: county.code })))
    .sort((a, b) => b.name.length - a.name.length);
  const names = townships.map((township) => escapeRegExp(township.name)).join('|');
  const townshipSuffix = `(?:${TOWNSHIP_SETTLEMENT})${DOOR}`;
  const explicit = `(?:${counties.join('|')})(?:${names})(?:${RESIDENT_CONNECTOR}${townshipSuffix}|${townshipSuffix})`;
  const unique = `(?:${names})(?:${RESIDENT_CONNECTOR}${townshipSuffix}|${townshipSuffix})`;
  const fallback = `(?:${counties.join('|')})[\\u4e00-\\u9fff]{1,8}(?:乡|镇|街道|街)(?:${RESIDENT_CONNECTOR}${townshipSuffix}|${townshipSuffix})`;
  const unparented = `(?:${SETTLEMENT})${DOOR}`;
  return new RegExp(`(?<![\\u4e00-\\u9fff])(?:${explicit}|${unique}|${fallback}|${unparented})`, 'g');
}

function candidatesIn(text: string): AddressMatch[] {
  const introduction = LEADING_INTRODUCTION.exec(text);
  const offset = introduction?.[0].length ?? 0;
  const searchable = text.slice(offset);
  const snapshot = getTownshipSnapshot();
  const townships = snapshot.counties.flatMap((county) => county.townships.map((township) => ({ ...township, countyCode: county.code })));
  return [...searchable.matchAll(addressPattern())].flatMap((match) => {
    const absoluteStart = offset + match.index!;
    if (isRejectedLocationContext(text, absoluteStart)) return [];
    const town = townships.find((item) => match[0].includes(item.name));
    const county = snapshot.counties.find((item) => match[0].startsWith(item.name));
    const townshipEnd = town ? match[0].indexOf(town.name) + town.name.length : 0;
    const connector = town ? new RegExp(`^${RESIDENT_CONNECTOR}`).exec(match[0].slice(townshipEnd)) : null;
    if (town && !connector && hasImmediateComplaintPredicate(match[0].slice(townshipEnd))) return [];
    const valueOffset = townshipEnd + (connector?.[0].length ?? 0);
    const value = connector ? match[0].slice(valueOffset) : match[0];
    const unparented = !town && !county;
    const parentConflict = town !== undefined && county !== undefined && town.countyCode !== county.code;
    return [{
      value,
      start: offset + match.index! + (connector || unparented ? valueOffset : 0),
      end: offset + match.index! + match[0].length,
      townshipCode: town?.code ?? null,
      districtCode: county?.code ?? town?.countyCode ?? null,
      explicitDistrict: county !== undefined || town !== undefined &&
        match[0].startsWith(snapshot.counties.find((item) => item.code === town.countyCode)!.name),
      parentConflict,
    }];
  });
}

/** Resolve locally published administrative prefixes without changing the extracted span. */
export function addressParts(value: string) {
  const cityless = value.trim().replace(/^湖北省/, '').replace(/^宜昌市/, '');
  const counties = getTownshipSnapshot().counties;
  const county = counties.find(entry => cityless.startsWith(entry.name));
  const districtless = county ? cityless.slice(county.name.length) : cityless;
  const parent = counties.find(entry => entry.townships.some(town => districtless.startsWith(town.name)));
  const township = parent?.townships.find(town => districtless.startsWith(town.name));
  return { county, parent, township, local: township ? districtless.slice(township.name.length) : districtless };
}

export function addressCommunityName(value: string): string | null {
  const match = COMMUNITY_NAME.exec(addressParts(value).local);
  return match && !NON_ADDRESS_NAME.test(match[1]) ? match[1] : null;
}

function extendedCandidatesIn(text: string): AddressMatch[] {
  const matches: AddressMatch[] = [];
  for (const clause of text.matchAll(/[^，,。；;！？\r\n]+/g)) {
    const value = clause[0].trim();
    const introduction = ADDRESS_CLAUSE_INTRO.exec(value);
    const address = value.slice(introduction?.[0].length ?? 0);
    const start = clause.index! + clause[0].indexOf(value) + (introduction?.[0].length ?? 0);
    if (isRejectedLocationContext(text, start)) continue;
    const parts = addressParts(address);
    const place = PLACE_ADDRESS.exec(parts.local);
    if (!place || NON_ADDRESS_NAME.test(place[0])) continue;
    const length = address.length - parts.local.length + place[0].length;
    if (!introduction && !parts.county && !parts.township && length !== address.length) continue;
    matches.push({ value: address.slice(0, length), start, end: start + length,
      townshipCode: parts.township?.code ?? null, districtCode: parts.county?.code ?? parts.parent?.code ?? null,
      explicitDistrict: !!parts.county, parentConflict: !!parts.county && !!parts.parent && parts.county.code !== parts.parent.code });
  }
  return matches;
}

export function extractAddressCandidate(input: AddressInput): ExtractedAddressCandidate | null {
  if (extractLocation(input).conflict) return null;
  const fields: Array<{ name: 'title' | 'content'; value: string | null }> = [
    { name: 'title', value: input.title },
    { name: 'content', value: input.content },
  ];
  const doorReferences = fields.flatMap((field) =>
    field.value ? [...field.value.matchAll(DOOR_REFERENCE_PATTERN)].map((match) => match[0]) : []
  );
  if (new Set(doorReferences).size > 1) return null;

  const matches: Array<AddressMatch & { sourceField: 'title' | 'content' }> = [];
  for (const field of fields) {
    if (!field.value) continue;
    const legacy = candidatesIn(field.value);
    const extended = extendedCandidatesIn(field.value).filter(candidate =>
      !legacy.some(existing => candidate.start < existing.end && existing.start < candidate.end));
    for (const match of [...legacy, ...extended]) matches.push({ ...match, sourceField: field.name });
  }
  if (matches.some((match) => match.parentConflict)) return null;
  const unique = [...new Set(matches.map((match) => match.value))];
  if (unique.length !== 1) return null;
  const value = unique[0];
  const selectedMatch = matches.find((match) => match.value === value)!;
  const sourceField = selectedMatch.sourceField;
  const text = fields.find((field) => field.name === sourceField)!.value!;
  const evidence = text.slice(selectedMatch.start, selectedMatch.end).slice(0, 500);
  return {
    value: value.slice(0, 500),
    evidence,
    sourceField,
    extractorVersion: ADDRESS_EXTRACTOR_VERSION,
    districtCode: selectedMatch.districtCode,
    parentMatch: selectedMatch.explicitDistrict ? 'explicit' : selectedMatch.townshipCode ? 'unique_township' : 'unresolved',
    snapshotId: getTownshipSnapshot().snapshotId,
  };
}

export function addressInputHash(input: AddressInput): string {
  return createHash('sha256').update(input.title + '\0' + (input.content ?? '')).digest('hex');
}
