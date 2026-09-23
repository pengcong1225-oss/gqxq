import { createHash } from 'node:crypto';

export const ADDRESS_EXTRACTOR_VERSION = 'address-extract.v1';

export interface ExtractedAddressCandidate {
  value: string;
  evidence: string;
  sourceField: 'title' | 'content';
  extractorVersion: typeof ADDRESS_EXTRACTOR_VERSION;
}

type AddressInput = { title: string; content: string | null };

const ADDRESS_PATTERN = /(?<![\u4e00-\u9fff])[\u4e00-\u9fff]{2,}(?:区|县|市)[\u4e00-\u9fff]{1,8}(?:乡|镇|街道|街)[\u4e00-\u9fff]{0,15}(?:小区|社区|村)[\u4e00-\u9fff\d号栋幢单元室楼座-]{0,18}?\d{1,4}号\d{1,4}(?:室)?/g;
const STOP_MARKERS = /(?:的居民|的住户|居民反映|住户反映|，|。|；|;|\n|\r)/;

function candidatesIn(value: string): string[] {
  const cleaned = value.replace(/(?:我是|我家在|我住在|地址是|位于|住在|请处理)/g, '');
  const matches = [...cleaned.matchAll(ADDRESS_PATTERN)].map((match) => match[0].trim());
  return [...new Set(matches)];
}

export function extractAddressCandidate(input: AddressInput): ExtractedAddressCandidate | null {
  const fields: Array<{ name: 'title' | 'content'; value: string | null }> = [
    { name: 'title', value: input.title },
    { name: 'content', value: input.content },
  ];
  const matches: Array<{ value: string; sourceField: 'title' | 'content' }> = [];
  for (const field of fields) {
    if (!field.value) continue;
    for (const value of candidatesIn(field.value)) matches.push({ value, sourceField: field.name });
  }
  const unique = [...new Set(matches.map((match) => match.value))];
  if (unique.length !== 1) return null;
  const value = unique[0];
  const sourceField = matches.find((match) => match.value === value)!.sourceField;
  const text = fields.find((field) => field.name === sourceField)!.value!;
  const index = text.indexOf(value);
  const trailing = text.slice(index + value.length);
  const stop = trailing.search(STOP_MARKERS);
  const evidence = (value + (stop < 0 ? '' : trailing.slice(0, stop))).slice(0, 500);
  return { value: value.slice(0, 500), evidence, sourceField, extractorVersion: ADDRESS_EXTRACTOR_VERSION };
}

export function addressInputHash(input: AddressInput): string {
  return createHash('sha256').update(input.title + '\0' + (input.content ?? '')).digest('hex');
}
