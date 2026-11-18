import {AppError} from '../http/errors';
import type {AlertBaselineSeason,AlertBaselineSnapshot} from '../types/businessEvents';

/**
 * 预警阈值基线（纯函数，不查库）。
 * 口径与 scripts/recalc-alert-thresholds.mjs 一致：
 *  1) 基线日集 = 区间内自然日（含 0 件日）；保障季场景再按保障月份过滤；
 *  2) 日均件数 = 基线日集内件数合计 / 基线日集天数；
 *  3) 常态窗口量 windowBase = 日均 × 窗口天数；
 *  4) 阈值 = ceil(windowBase × 倍数)，倍数 1.00–5.00（最多两位小数）。
 */
export interface AlertBaselineInput {
  /** 按自然日（YYYY-MM-DD）聚合的件数；缺失日按 0 件处理。 */
  dailyCounts:ReadonlyMap<string,number>;
  /** 基线候选自然日（可乱序、可重复，函数内部去重排序）；仅这些日期参与统计。 */
  days:readonly string[];
  windowDays:number;
  /** 保障季月份（1–12）；null/空数组表示全年。 */
  months?:readonly number[]|null;
}

const DAY_PATTERN=/^\d{4}-\d{2}-\d{2}$/;
const round=(value:number,digits:number)=>Number(value.toFixed(digits));

export function assertBaselineDay(value:string):void{
 if(!DAY_PATTERN.test(value))throw AppError.validation('基线日期格式须为 YYYY-MM-DD');
 const parsed=Date.parse(value+'T00:00:00Z');
 if(!Number.isFinite(parsed)||new Date(parsed).toISOString().slice(0,10)!==value)throw AppError.validation('基线日期无效');
}

/** 保障季月份展开（可跨年，如 11→3 = [11,12,1,2,3]）。 */
export function alertSeasonMonths(startMonth:number,endMonth:number):number[]{
 if(![startMonth,endMonth].every(m=>Number.isInteger(m)&&m>=1&&m<=12))throw AppError.validation('保障季月份无效');
 const months:number[]=[];
 for(let month=startMonth;months.length<12;month=month===12?1:month+1){months.push(month);if(month===endMonth)break;}
 return months;
}

export function normalizeBaselineMonths(months:readonly number[]|null|undefined):number[]|null{
 if(months==null||!months.length)return null;
 if(!months.every(m=>Number.isInteger(m)&&m>=1&&m<=12))throw AppError.validation('保障季月份无效');
 return [...new Set(months)].sort((a,b)=>a-b);
}

/** 由每日计数与基线日集计算常态窗口量；不直接查库，便于单测。 */
export function computeAlertBaseline(input:AlertBaselineInput):AlertBaselineSnapshot{
 const windowDays=input.windowDays;
 if(!Number.isInteger(windowDays)||windowDays<1||windowDays>366)throw AppError.validation('窗口天数须为 1–366 的整数');
 const days=[...new Set(input.days)];
 for(const day of days)assertBaselineDay(day);
 days.sort();
 if(!days.length)throw AppError.validation('基线日期集为空，无法计算常态窗口量');
 const months=normalizeBaselineMonths(input.months);
 const selected=months?days.filter(day=>months.includes(Number(day.slice(5,7)))):days;
 if(!selected.length)throw AppError.validation('保障季基线日期集为空，无法计算常态窗口量');
 let total=0;
 for(const day of selected)total+=input.dailyCounts.get(day)??0;
 const avgPerDay=round(total/selected.length,4);
 const windowBase=round(avgPerDay*windowDays,2);
 return {avgPerDay,windowBase,baseDays:selected.length,daysFrom:selected[0],daysTo:selected[selected.length-1]};
}

export function isValidAlertMultiplier(value:unknown):value is number{
 return typeof value==='number'&&Number.isFinite(value)&&value>=1&&value<=5&&Math.abs(Math.round(value*100)-value*100)<1e-9;
}

/** 冻结阈值：ceil(windowBase × multiplier)，容差处理二进制浮点（如 20.000000000000004）。 */
export function expectedAlertThreshold(windowBase:number,multiplier:number):number{
 if(!Number.isFinite(windowBase)||windowBase<0)throw AppError.validation('常态窗口量无效');
 if(!isValidAlertMultiplier(multiplier))throw AppError.validation('倍数须在 1.00–5.00 之间且最多两位小数');
 return Math.max(0,Math.ceil(windowBase*multiplier-1e-9));
}

/** UI 备选倍数（可自定义 1.00–5.00；此处给常用档位）。 */
export const ALERT_MULTIPLIER_SUGGESTIONS:readonly number[]=Object.freeze([1,1.1,1.2,1.5,2]);

/** 把服务端计算的基线快照冻结进规则；历史/手工阈值（multiplier=null）保持无基线。 */
export function freezeBusinessRuleBaseline<T extends {kind:string;multiplier:number|null;threshold:number|null}>(input:T,baseline:AlertBaselineSnapshot|null):T&{baseline:AlertBaselineSnapshot|null}{
 if(input.kind!=='alert'||input.multiplier===null)return {...input,baseline:null};
 if(!baseline)throw AppError.validation('缺少基线快照，请先计算常态窗口量');
 const expected=expectedAlertThreshold(baseline.windowBase,input.multiplier);
 if(input.threshold!==expected)throw AppError.validation('阈值须等于常态窗口量×倍数（当前应为 '+expected+'），请先重算基线');
 return {...input,baseline};
}

export type {AlertBaselineSeason};
