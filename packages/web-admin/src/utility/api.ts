import request from '../api/request';
import type {UtilityDetail, UtilityEvent, UtilityKind, UtilityList, UtilityMode, UtilityTimeouts} from './types';

export const getUtilityEvents = (mode: UtilityMode, kind: UtilityKind) => request.get<never, UtilityList>('/utility/events', {params: {mode, kind}});
export const getUtilityDetail = (mode: UtilityMode, id: string) => request.get<never, UtilityDetail>(`/utility/events/${encodeURIComponent(id)}`, {params: {mode}});
export const saveUtilityEvent = (mode: UtilityMode, expectedRevision: number, event: Partial<UtilityEvent>, token: string) => {
  const config = {params: {mode}, headers: {Authorization: `Bearer ${token}`}};
  return event.id ? request.patch(`/utility/events/${encodeURIComponent(event.id)}`, {expectedRevision, event}, config)
    : request.post('/utility/events', {expectedRevision, event}, config);
};
export const importUtilityEvents = (expectedRevision: number, events: unknown[], token: string) => request.post('/utility/import', {expectedRevision, events}, {params: {mode: 'real'}, headers: {Authorization: `Bearer ${token}`}});
export const getUtilityTimeouts = (mode: UtilityMode) => request.get<never, UtilityTimeouts>('/utility/timeouts', {params: {mode}});
export const pushUtilityTimeout = (mode: UtilityMode, id: string, expectedRevision: number, outcome: 'success' | 'failure', token: string) => request.post(`/utility/timeouts/${encodeURIComponent(id)}/push`, {expectedRevision, outcome}, {params: {mode}, headers: {Authorization: `Bearer ${token}`}});
