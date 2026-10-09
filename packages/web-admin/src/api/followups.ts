import request from './request';
import type {ComplaintFollowupsView,FollowupFacts,FollowupRevisionInput,FollowupConclusionInput,FollowupView} from '../types/api';
export const getFollowups=(complaintId:string)=>request.get<never,ComplaintFollowupsView>('/complaints/'+encodeURIComponent(complaintId)+'/followups');
export const createFollowup=(complaintId:string,body:FollowupFacts&{requestId:string})=>request.post<never,FollowupView>('/complaints/'+encodeURIComponent(complaintId)+'/followups',body);
export const reviseFollowup=(id:string,body:FollowupRevisionInput)=>request.patch<never,FollowupView>('/followups/'+encodeURIComponent(id),body);
export const concludeFollowup=(id:string,body:FollowupConclusionInput)=>request.patch<never,FollowupView>('/followups/'+encodeURIComponent(id)+'/conclusion',body);
