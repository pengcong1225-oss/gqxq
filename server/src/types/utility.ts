export type UtilityMode='simulation'|'real';
export interface UtilityEvent extends UtilityEventGridState {id:string;kind:'shutdown'|'pipeline';title:string;businessType:'water'|'gas';enterpriseId:string;gridIds:string[];districtCode:string;startsAt:string;endsAt:string;restoredAt:string|null;households:number;workers:number;reason:string;area:string;plan:string;housing:string;sourceApplicationNo:string;approvalStatus:'pending'|'approved'|'rejected';approvalNote:string;approvedBy:string;approvedAt:string|null;relatedTypes:string[];revision:number;updatedAt:string;mode:UtilityMode;sourceSystem?:'public-utility';sourceRevision?:string;sourceStatus?:string;approvalTraces?:unknown[]}
/**
 * 事件未解析到行政网格时的标记。
 * 来源事件成立（企业、时间、涉及户数都有）但影响范围无法映射到网格（admin_grid.geometry 全为 null）。
 * 前端据此如实展示「该事件未定位到网格」，而不是伪装成有位置或直接丢弃。
 */
export interface UtilityEventGridState {gridUnresolved?: boolean;hasVerifiedGrid?:boolean}

export interface UtilityComplaint {id:string;title:string;type:string;occurredAt:string;gridId:string}
export interface TimeoutItem {sourceSystem?:'public-utility';id:string;eventId:string;eventTitle:string;from:string;to:string;complaints:UtilityComplaint[];status:'pending'|'failed'|'simulated'|'blocked'|'sent'|'superseded';attempts:{at:string;result:string;message:string}[];eventRevision:number}
export interface UtilityState {events:UtilityEvent[];deliveries:Record<string,TimeoutItem>}
export interface UtilityOptions {enterprises:{id:string;name:string;businessType:string}[];grids:{id:string;name:string;districtCode:string}[]}
