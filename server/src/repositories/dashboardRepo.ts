import {normalizeStatisticsQuery,addDays,shanghaiToday} from '../domain/statisticsQuery';
import type {AccessContext} from '../auth/accessScope';
import {AppError} from '../http/errors';
/** Legacy days adapter; every panel delegates to one normalized D1 dataset. */
export function dashboardQuery(days:number,access:AccessContext,clock:()=>Date=()=>new Date()){
 if(!Number.isInteger(days)||days<1||days>365)throw AppError.validation('days须为1..365整数');const to=shanghaiToday(clock);
 return normalizeStatisticsQuery({dataset:'ledger',projection:'current',periodKind:'custom',from:addDays(to,1-days),to,comparisonPolicyId:'candidate-calendar-v1'},access,clock);
}
