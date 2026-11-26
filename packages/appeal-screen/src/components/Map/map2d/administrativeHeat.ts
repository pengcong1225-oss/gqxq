export const HEAT_COLORS = {
  green: 'rgba(46, 204, 113, 0.42)',
  blue: 'rgba(52, 152, 219, 0.46)',
  yellow: 'rgba(241, 196, 15, 0.50)',
  orange: 'rgba(230, 126, 34, 0.55)',
  red: 'rgba(231, 76, 60, 0.60)',
} as const;
type Level = keyof typeof HEAT_COLORS;
type Geometry = {type:'Polygon';coordinates:number[][][]} | {type:'MultiPolygon';coordinates:number[][][][]};

export interface AdministrativeHeat {
  state: 'available' | 'partial' | 'unavailable';
  reason: string | null;
  data: {
    days: number | null;
    thresholds: number[] | null;
    ruleVersion: string | null;
    categories: {code:string;name:string;parentCode:string|null}[];
    grids: {code:string;name?:string;geometry?:Geometry;geometrySource?:string;count:number;level:Level|null;communities?:string[]}[];
  };
}

export function formalHeatColor(heat: AdministrativeHeat | null, level: Level | null, show: boolean): string | undefined {
  if (!show || !level || heat?.state === 'unavailable' || !heat?.data.ruleVersion
    || heat.data.ruleVersion === 'simulation-only' || !heat.data.thresholds) return undefined;
  return HEAT_COLORS[level];
}
