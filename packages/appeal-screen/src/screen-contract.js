export const heatColors={green:'#48c978',blue:'#42a9eb',yellow:'#f0d34a',orange:'#f49b3f',red:'#ec5151'}
export function heatColor(section,code){const row=section?.data?.grids?.find(x=>x.code===code);return section?.state==='available'&&row?.level?heatColors[row.level]||null:null}
export function evidenceKeyFor(data,selector){
 if(!data||!selector)return null
 if(selector.type==='top3')return data.top3?.data?.items?.find(x=>x.code===selector.code)?.evidenceKey??null
 if(selector.type==='warning')return data.warnings?.data?.items?.find(x=>x.scenario===selector.scenario)?.evidenceKey??null
 const season=data.research?.data?.seasons?.find(x=>x.kind===selector.kind)
 if(selector.type==='year')return season?.years?.find(x=>x.year===selector.year)?.evidenceKey??null
 if(selector.type==='month')return season?.months?.find(x=>x.month===selector.month)?.[selector.period==='current'?'currentEvidenceKey':'previousEvidenceKey']??null
 if(selector.type==='grid')return season?.topGrids?.find(x=>x.id===selector.gridCode)?.[selector.period==='current'?'currentEvidenceKey':'previousEvidenceKey']??null
 return null
}
