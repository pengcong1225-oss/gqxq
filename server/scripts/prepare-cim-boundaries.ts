import {randomUUID} from 'node:crypto';
import {link,mkdir,readFile,realpath,unlink,writeFile} from 'node:fs/promises';
import {isAbsolute,join,relative,resolve,sep} from 'node:path';
import {parseArgs} from 'node:util';
import {cimPreviewDigest,prepareCimBoundaryImport,prepareCimCatalogImport,readCimPreview} from '../src/services/cimBoundaryImportService';

/** Publish a complete local file once, and accept a rerun only when the bytes are identical. */
async function writeOnce(path:string,bytes:Buffer) {
  const temp=`${path}.${randomUUID()}.tmp`;
  await writeFile(temp,bytes,{flag:'wx'});
  try {
    await link(temp,path);
  } catch (error) {
    if((error as NodeJS.ErrnoException).code!=='EEXIST') throw error;
    if(!(await readFile(path)).equals(bytes)) throw new Error('输出目录已存在其他批次，请使用新目录');
  } finally {
    await unlink(temp);
  }
}

async function main() {
  const {values}=parseArgs({options:{
    level:{type:'string'},ids:{type:'string'},out:{type:'string'},district:{type:'string'},
    converted:{type:'string'},approval:{type:'string'},
  }});
  const {level,ids,out,district,converted,approval}=values;
  if((level!=='community-grid'&&level!=='community')||!ids||!/^\d+(,\d+)*$/.test(ids)||!out||!isAbsolute(out)) {
    throw new Error('用法：--level community-grid|community --ids 1,2 --out <仓库外绝对路径>');
  }
  if(Boolean(converted)!==Boolean(approval)) throw new Error('边界须同时提供 --converted 和 --approval');
  const repository=await realpath(resolve(__dirname,'../..'));
  const checkOutside=(candidate:string)=>{
    const difference=relative(repository,candidate);
    if(!difference||(!isAbsolute(difference)&&difference!=='..'&&!difference.startsWith('..'+sep))) {
      throw new Error('CIM 原始几何和准备导入的文件须保存在 Git 仓库外');
    }
  };
  checkOutside(resolve(out));
  await mkdir(out,{recursive:true});
  const destination=await realpath(out);
  checkOutside(destination);
  const preview=await readCimPreview(level,ids.split(',').map(Number),process.env.GQXQ_CIM_VECTOR_ENDPOINT,process.env.GQXQ_CIM_VECTOR_TOKEN);
  const output=[{name:'cim-preview.json',bytes:Buffer.from(JSON.stringify(preview),'utf8')}];
  if(district) output.push({name:'admin_grid.csv',bytes:await prepareCimCatalogImport(preview,district)});
  if(converted&&approval) {
    const projected=JSON.parse(await readFile(converted,'utf8')) as unknown;
    output.push({name:'grid_boundary.geojson',bytes:await prepareCimBoundaryImport(preview,projected,approval)});
  }
  for(const item of output) await writeOnce(join(destination,item.name),item.bytes);
  console.log(JSON.stringify({level,count:preview.features.length,sourceSrid:preview.metadata.srid,sourceSha256:cimPreviewDigest(preview),files:output.map(item=>item.name)}));
}

void main().catch((error:unknown)=>{
  console.error(error instanceof Error?error.message:'CIM 批次准备失败');
  process.exitCode=1;
});
