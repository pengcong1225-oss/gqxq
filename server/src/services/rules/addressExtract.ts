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
const DOOR_REFERENCE_PATTERN = /\d{1,4}号\d{1,4}(?:室)?/g;
const LEADING_INTRODUCTION = /^\s*(?:(?:您好|你好)[，,、：:\s]*)?(?:本人居住在|本人住在|本人家住|本人居住于|本人住于|我是|我家在|我住在|家住|地址是|位于|住在|请处理)/;

interface AddressMatch {
  value: string;
  start: number;
  end: number;
}

function candidatesIn(value: string): AddressMatch[] {
  const introduction = LEADING_INTRODUCTION.exec(value);
  const offset = introduction?.[0].length ?? 0;
  const searchable = value.slice(offset);
  return [...searchable.matchAll(ADDRESS_PATTERN)].map((match) => ({
    value: match[0],
    start: offset + match.index!,
    end: offset + match.index! + match[0].length,
  }));
}

export function extractAddressCandidate(input: AddressInput): ExtractedAddressCandidate | null {
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
    for (const match of candidatesIn(field.value)) matches.push({ ...match, sourceField: field.name });
  }
  const unique = [...new Set(matches.map((match) => match.value))];
  if (unique.length !== 1) return null;
  const value = unique[0];
  const selectedMatch = matches.find((match) => match.value === value)!;
  const sourceField = selectedMatch.sourceField;
  const text = fields.find((field) => field.name === sourceField)!.value!;
  const evidence = text.slice(selectedMatch.start, selectedMatch.end).slice(0, 500);
  return { value: value.slice(0, 500), evidence, sourceField, extractorVersion: ADDRESS_EXTRACTOR_VERSION };
}

export function addressInputHash(input: AddressInput): string {
  return createHash('sha256').update(input.title + '\0' + (input.content ?? '')).digest('hex');
}
