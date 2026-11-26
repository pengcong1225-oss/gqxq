import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cimPreviewDigest,convertCimRegion,prepareCimPreview,prepareCimBoundaryImport,prepareCimCatalogImport} from '../src/services/cimBoundaryImportService';
import {parseImportFile} from '../src/services/masterDataImportParser';

const outer = [[111.2,30.6],[111.3,30.6],[111.3,30.7],[111.2,30.7],[111.2,30.6]];
const hole = [[111.22,30.62],[111.24,30.62],[111.24,30.64],[111.22,30.64],[111.22,30.62]];
const island = [[111.4,30.6],[111.5,30.6],[111.5,30.7],[111.4,30.7],[111.4,30.6]];

function sourceFeature(id: number, code: string) {
  return {
    ID: id,
    fieldNames: ['NAME','BM','SSXZQH','SSJB','SSSQ'],
    fieldValues: ['模拟网格',code,'区县','街道','社区'],
    geometry: {
      type: 'REGION', prjCoordSys: null, parts: [5,5,5], partTopo: [1,1,-1],
      points: [...outer,...island,...hole].map(([x,y]) => ({x,y})),
    },
  };
}

test('SuperMap topology assigns a hole to its containing island even after another island', () => {
  const geometry=convertCimRegion(sourceFeature(1,'42050200110001').geometry);
  assert.deepEqual(geometry,{type:'MultiPolygon',coordinates:[[outer,hole],[island]]});
});

test('CIM preparation enforces the dataset code level and keeps the source CRS in preview', () => {
  assert.throws(() => prepareCimPreview('community-grid',[sourceFeature(1,'420502001')]), /14 位/);
  const preview=prepareCimPreview('community',[sourceFeature(1,'420502001001')]);
  assert.equal(preview.metadata.srid,4490);
  assert.equal(preview.features[0].properties.code,'420502001001');
  assert.equal(preview.features[0].properties.level,'community');
  assert.equal('templateVersion' in preview,false);
});

test('CIM batch is sorted by stable code and rejects a duplicate code', () => {
  const f1=sourceFeature(1,'42050200110001');
  const f2=sourceFeature(2,'42050200110002');
  assert.deepEqual(prepareCimPreview('community-grid',[f2,f1]),prepareCimPreview('community-grid',[f1,f2]));
  assert.throws(() => prepareCimPreview('community-grid',[f1,sourceFeature(2,'42050200110001')]),/重复/);
});

test('formal import refuses the unconverted preview and undeclared CRS accuracy', async () => {
  const preview=prepareCimPreview('community-grid',[sourceFeature(1,'42050200110001')]);
  await assert.rejects(prepareCimBoundaryImport(preview,preview,'local approval'),/4326/);
  const approximate={...preview,metadata:{...preview.metadata,srid:4326,accuracyMeters:-1,operation:'Ballpark geographic offset'}};
  await assert.rejects(prepareCimBoundaryImport(preview,approximate,'local approval'),/精度/);
});

test('approved projected fixtures produce B4 import files with the unchanged full code',async()=>{
  const code='42050200110001';
  const preview=prepareCimPreview('community-grid',[sourceFeature(1,code)]);
  const catalog=await prepareCimCatalogImport(preview,'420502');
  const register=await parseImportFile({name:'admin_grid.csv',bytes:catalog},'admin_grid');
  assert.equal(register.rows[0].values.code,code);
  await assert.rejects(prepareCimCatalogImport(preview,'420503'),/区县/);
  const projected={
    ...preview,
    metadata:{...preview.metadata,srid:4326,sourceSha256:cimPreviewDigest(preview),accuracyMeters:0.2,operation:'Test only calibration'},
  };
  const bytes=await prepareCimBoundaryImport(preview,projected,'测试审批编号');
  const imported=await parseImportFile({name:'grid_boundary.geojson',bytes},'grid_boundary');
  assert.equal(imported.rows[0].values.code,code);
  assert.equal(imported.rows[0].values.coordinateSystem,'WGS84');
  assert.match(String(imported.rows[0].values.geometrySource),/测试审批编号/);
  assert.equal(imported.rows[0].values.administrativeCommunityName,'社区');
});

test('only the CIM community-grid source carries its explicit parent name into a boundary import',async()=>{
  const feature=sourceFeature(2,'42050200100102');
  feature.fieldValues[4]='';
  const preview=prepareCimPreview('community-grid',[feature]);
  const projected={...preview,metadata:{...preview.metadata,srid:4326,sourceSha256:cimPreviewDigest(preview),accuracyMeters:0.2,operation:'Test only calibration'}};
  const file=await prepareCimBoundaryImport(preview,projected,'测试审批编号');
  const parsed=await parseImportFile({name:'grid_boundary.geojson',bytes:file},'grid_boundary');
  assert.equal(parsed.rows[0].values.administrativeCommunityName,null);
  const unexpected=JSON.parse(file.toString());
  Object.assign(unexpected.features[0].properties,{geometrySource:'其他边界来源',administrativeCommunityName:'越权填写的社区'});
  await assert.rejects(parseImportFile({name:'grid_boundary.geojson',bytes:Buffer.from(JSON.stringify(unexpected))},'grid_boundary'),/CIM/);
});
