import { createHash } from 'node:crypto';
import snapshotData from '../../data/yichangTownships.snapshot.json';

export interface TownshipSnapshot {
  snapshotId: string;
  fetchedAt: string;
  sourceUrl: string;
  countyTownshipSha256: string;
  approved: boolean;
  counties: Array<{
    code: string;
    name: string;
    townships: Array<{ code: string; name: string; type: string }>;
  }>;
}

const snapshot = snapshotData as TownshipSnapshot;

function validateSnapshot(data: TownshipSnapshot): void {
  const countyCodes = new Set<string>();
  const townshipCodes = new Set<string>();
  const townshipNames = new Set<string>();

  for (const county of data.counties) {
    if (!/^\d{6}$/.test(county.code) || countyCodes.has(county.code)) {
      throw new Error(`Invalid or duplicate county code in township snapshot: ${county.code}`);
    }
    countyCodes.add(county.code);
    for (const township of county.townships) {
      if (!/^\d{9}$/.test(township.code) || !township.code.startsWith(county.code) || townshipCodes.has(township.code)) {
        throw new Error(`Invalid, duplicate, or mismatched township code in snapshot: ${township.code}`);
      }
      if (townshipNames.has(township.name)) {
        throw new Error(`Duplicate township name in Yichang snapshot: ${township.name}`);
      }
      townshipCodes.add(township.code);
      townshipNames.add(township.name);
    }
  }

  const digest = createHash('sha256').update(JSON.stringify(data.counties)).digest('hex');
  if (digest !== data.countyTownshipSha256) {
    throw new Error('Township snapshot county/township checksum does not match its contents');
  }
}

validateSnapshot(snapshot);

export function getTownshipSnapshot(): TownshipSnapshot {
  return snapshot;
}
