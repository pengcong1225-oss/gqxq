import {createHash} from 'node:crypto';
import {z} from 'zod';
import {pointInRing} from '../domain/rangeToGrid';
import type {BoundaryGeometry} from '../types/serviceGrid';
import {IMPORT_LIMITS, parseImportFile, safeCsvCell, TEMPLATE_VERSION} from './masterDataImportParser';
import {validateGeometry} from './serviceGridService';

const sourceName = '宜昌网格20230512';
const datasets = {
  'community-grid': {name: 'skjc_xzq_wangge_new', digits: 14},
  community: {name: 'skjc_xzq_cun_new', digits: 12},
} as const;

export type CimBoundaryLevel = keyof typeof datasets;
export const CIM_VECTOR_ENDPOINT = 'https://drs.sc.yichang.gov.cn/api/restapi/prod/IC42050020230626000008/gtis/data/rest/9eadbf946f994536aa59078a630a0cc9';
export const CIM_SOURCE_EPSG = 4490;

const regionSchema = z.object({
  type: z.literal('REGION'),
  points: z.array(z.object({x:z.number().finite().min(110.2).max(112.15),y:z.number().finite().min(29.9).max(31.62)})).max(IMPORT_LIMITS.vertices),
  parts: z.array(z.number().int().min(4)).min(1),
  partTopo: z.array(z.union([z.literal(1),z.literal(-1)])).min(1),
  prjCoordSys: z.object({epsgCode:z.literal(CIM_SOURCE_EPSG)}).nullish(),
});
const featureSchema = z.object({
  ID:z.number().int().positive(),
  fieldNames:z.array(z.string().min(1)),
  fieldValues:z.array(z.unknown()),
  geometry:z.unknown(),
});

/** iServer REGION: `parts` partitions the points, and `partTopo` distinguishes islands from holes. */
export function convertCimRegion(value: unknown): BoundaryGeometry {
  const region=regionSchema.parse(value);
  if (region.parts.length!==region.partTopo.length || region.parts.reduce((sum,length)=>sum+length,0)!==region.points.length) {
    throw new Error('CIM 几何的环及节点数不一致');
  }
  const polygons:number[][][][]=[];
  const holes:number[][][]=[];
  let offset=0;
  for(const [index,length] of region.parts.entries()) {
    const ring=region.points.slice(offset,offset+length).map(({x,y})=>[x,y]);
    offset+=length;
    if(region.partTopo[index]===1) polygons.push([ring]);
    else holes.push(ring);
  }
  for(const hole of holes) {
    const containers=polygons.filter(([outer])=>pointInRing([hole[0][0],hole[0][1]],outer));
    if(containers.length!==1) throw new Error('CIM 孔洞不能唯一归入外环');
    containers[0].push(hole);
  }
  // Geometry validation checks topology and longitude/latitude ranges without changing coordinates.
  return validateGeometry(polygons.length===1 ? {type:'Polygon',coordinates:polygons[0]} : {type:'MultiPolygon',coordinates:polygons})!;
}

export function prepareCimPreview(level: CimBoundaryLevel, features: readonly unknown[]) {
  if(!features.length) throw new Error('未指定 CIM 要素');
  const codes=new Set<string>();
  const rows=features.map((raw)=>{
    const row=featureSchema.parse(raw);
    if(row.fieldNames.length!==row.fieldValues.length) throw new Error('CIM 要素字段和值数量不一致');
    const fields=new Map(row.fieldNames.map((name,index)=>[name.toUpperCase(),row.fieldValues[index]]));
    if(fields.size!==row.fieldNames.length) throw new Error('CIM 要素字段重复');
    const field=(key:string)=>String(fields.get(key)??'').trim();
    const code=field('BM');
    if(!/^\d+$/.test(code)||code.length!==datasets[level].digits) throw new Error(`本图层的 BM 必须为 ${datasets[level].digits} 位数字`);
    if(codes.has(code)) throw new Error('CIM 批次出现重复 BM');
    codes.add(code);
    const name=field('NAME');
    if(!name||name.length>128) throw new Error('CIM 要素名称为空或超限');
    return {
      type:'Feature' as const,
      properties:{code,name,level,id:row.ID,districtName:field('SSXZQH'),townName:field('SSJB'),communityName:field('SSSQ')},
      geometry:convertCimRegion(row.geometry),
    };
  }).sort((left,right)=>left.properties.code.localeCompare(right.properties.code));
  return {type:'FeatureCollection' as const, metadata:{provider:'yichang-cim',sourceName,dataset:datasets[level].name,level,srid:CIM_SOURCE_EPSG},features:rows};
}

type CimPreview=ReturnType<typeof prepareCimPreview>;
export function cimPreviewDigest(preview: CimPreview) {
  return createHash('sha256').update(JSON.stringify(preview)).digest('hex');
}

/** Grid IDs remain at their original level. The existing admin importer checks the independently verified district code. */
export async function prepareCimCatalogImport(preview: CimPreview,districtCode: string) {
  if(!/^\d{6}$/.test(districtCode)||preview.features.some(({properties})=>!properties.code.startsWith(districtCode))) {
    throw new Error('经审核的区县编码须与本批全部 BM 的区县前缀一致');
  }
  const rows=preview.features.map(({properties:{code,name}})=>[TEMPLATE_VERSION,code,name,districtCode].map(safeCsvCell).join(','));
  const bytes=Buffer.from(['templateVersion,code,name,districtCode',...rows,''].join('\n'),'utf8');
  await parseImportFile({name:'admin_grid.csv',bytes},'admin_grid');
  return bytes;
}

const projectionSchema=z.object({
  type:z.literal('FeatureCollection'),
  metadata:z.object({srid:z.literal(4326),sourceSha256:z.string(),operation:z.string().trim().min(1).max(120),accuracyMeters:z.number().finite().nonnegative()}),
  features:z.array(z.object({type:z.literal('Feature'),properties:z.object({code:z.string()}),geometry:z.unknown()})),
});

/** Create the existing B4 import format only for an independently approved, traceable datum transformation. */
export async function prepareCimBoundaryImport(preview:CimPreview,converted:unknown,approval:string) {
  const parsed=projectionSchema.safeParse(converted);
  if(!parsed.success) throw new Error('转换文件须声明 EPSG:4326、源预览校验值、转换操作和已知精度');
  const {metadata,features}=parsed.data;
  if(!approval.trim()||approval.length>180||/^ballpark\b/i.test(metadata.operation)) throw new Error('须有授权的转换依据和已知精度');
  const digest=cimPreviewDigest(preview);
  if(metadata.sourceSha256!==digest) throw new Error('转换文件和源预览的校验值不一致');
  const byCode=new Map(features.map(feature=>[feature.properties.code,feature.geometry]));
  if(features.length!==preview.features.length||byCode.size!==features.length) throw new Error('转换文件与源预览的网格清单不一致');
  const rows=preview.features.map(({properties,geometry:original})=>{
    const geometry=validateGeometry(byCode.get(properties.code));
    if(!geometry||geometry.type!==original.type) throw new Error('转换文件缺失源网格或改变了几何类型');
    const shapes=(input:BoundaryGeometry)=>input.type==='Polygon'?[input.coordinates.map(ring=>ring.length)]:input.coordinates.map(poly=>poly.map(ring=>ring.length));
    if(JSON.stringify(shapes(geometry))!==JSON.stringify(shapes(original))) throw new Error('转换文件改变了源几何的环或节点数');
    const geometrySource=`宜昌 CIM ${sourceName}/${preview.metadata.dataset} SmID=${properties.id}，EPSG:4490→4326 ${metadata.operation}，精度 ${metadata.accuracyMeters} 米，授权依据 ${approval.trim()}，源预览 SHA-256 ${digest}`;
    return {type:'Feature',properties:{code:properties.code,coordinateSystem:'WGS84',geometrySource,conversion:'none'},geometry};
  });
  const bytes=Buffer.from(JSON.stringify({type:'FeatureCollection',templateVersion:TEMPLATE_VERSION,features:rows}),'utf8');
  await parseImportFile({name:'grid_boundary.geojson',bytes},'grid_boundary');
  return bytes;
}

async function getJson(url:URL,headers:Record<string,string>={}) {
  const response=await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(10_000)});
  if(!response.ok) throw new Error(`CIM HTTP ${response.status}`);
  if(!response.headers.get('content-type')?.includes('json')||!response.body) throw new Error('CIM 未返回 JSON 数据');
  const reader=response.body.getReader();
  const chunks:Uint8Array[]=[];
  let size=0;
  for(;;) {
    const {done,value}=await reader.read();
    if(done) break;
    size+=value.byteLength;
    if(size>IMPORT_LIMITS.bytes) { await reader.cancel(); throw new Error('CIM 单个响应超过 10 MiB'); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function readCimPreview(level:CimBoundaryLevel, ids:readonly number[], configuredEndpoint=CIM_VECTOR_ENDPOINT,accessToken?:string) {
  const cleanIds=[...new Set(ids)].sort((a,b)=>a-b);
  if(!cleanIds.length||cleanIds.length>100||cleanIds.some(id=>!Number.isSafeInteger(id)||id<1)) throw new Error('请输入 1 至 100 个有效 SmID');
  const endpoint=URL.parse(configuredEndpoint);
  const allowedHost='drs.sc.yichang.gov.cn';
  if(!endpoint||endpoint.protocol!=='https:'||endpoint.host!==allowedHost||endpoint.username||endpoint.password||endpoint.hash||endpoint.search||!/^\/api\/restapi\/prod\/IC\d+\/gtis\/data\/rest\/[a-f\d]+\/?$/.test(endpoint.pathname)) {
    throw new Error('CIM 数据入口须为政务数据中台对应用途授权的 HTTPS 正式数据路由');
  }
  const token=accessToken?.trim()||z.object({data:z.string().min(1)}).parse(await getJson(new URL('/onemap/getToken?apiCode=1',endpoint))).data;
  const headers={'X-ACCESS-TOKEN':token,Referer:endpoint.origin+'/','Accept':'application/json'};
  const path=`${endpoint.pathname.replace(/\/$/,'')}/datasources/${encodeURIComponent(sourceName)}/datasets/${datasets[level].name}`;
  const datasetSchema=z.object({datasetInfo:z.object({type:z.literal('REGION'),prjCoordSys:z.object({epsgCode:z.literal(CIM_SOURCE_EPSG)})})});
  datasetSchema.parse(await getJson(new URL(path+'.json',endpoint),headers));
  const rows=[];
  for(const id of cleanIds) {
    const row=featureSchema.parse(await getJson(new URL(path+`/features/${id}.json`,endpoint),headers));
    if(row.ID!==id) throw new Error('CIM 返回的 SmID 与请求不一致');
    rows.push(row);
  }
  return prepareCimPreview(level,rows);
}
