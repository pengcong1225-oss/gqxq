export const CIM_BOUNDARY_SOURCE_NAME = '宜昌网格20230512';
export const CIM_BOUNDARY_DATASETS = {
  'community-grid': {name: 'skjc_xzq_wangge_new', digits: 14},
  community: {name: 'skjc_xzq_cun_new', digits: 12},
} as const;

export type CimBoundaryLevel = keyof typeof CIM_BOUNDARY_DATASETS;

export function isCimBoundarySource(code: string, source: unknown, level: CimBoundaryLevel): boolean {
  const dataset = CIM_BOUNDARY_DATASETS[level];
  return code.length === dataset.digits && /^\d+$/.test(code) && typeof source === 'string' &&
    source.startsWith(`宜昌 CIM ${CIM_BOUNDARY_SOURCE_NAME}/${dataset.name} SmID=`);
}
