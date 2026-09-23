import request from './request';
import type {
  ManagedSensitiveWord,
  SensitiveRescanExecution,
  SensitiveRescanPreview,
  SensitiveWordStatus,
} from '../types/api';

/** 敏感词管理接口均为管理员独占；停用代替物理删除。 */
export async function listSensitiveWords(): Promise<ManagedSensitiveWord[]> {
  return request.get<never, ManagedSensitiveWord[]>('/dicts/sensitive-words');
}

export async function createSensitiveWord(word: string): Promise<ManagedSensitiveWord> {
  return request.post<never, ManagedSensitiveWord>('/dicts/sensitive-words', { word });
}

export async function updateSensitiveWord(
  itemId: string,
  body: { word?: string; status?: SensitiveWordStatus }
): Promise<ManagedSensitiveWord> {
  return request.patch<never, ManagedSensitiveWord>(
    '/dicts/sensitive-words/' + encodeURIComponent(itemId),
    body
  );
}

export async function previewSensitiveRescan(): Promise<SensitiveRescanPreview> {
  return request.post<never, SensitiveRescanPreview>('/dicts/sensitive-words/rescan-preview');
}

export async function executeSensitiveRescan(previewToken: string): Promise<SensitiveRescanExecution> {
  return request.post<never, SensitiveRescanExecution>('/dicts/sensitive-words/rescan', {
    previewToken,
  });
}
