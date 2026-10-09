import assert from 'node:assert/strict';
import test from 'node:test';
import {existsSync,readFileSync} from 'node:fs';
process.env.DOTENV_CONFIG_PATH='missing-synthetic-b4.env';process.env.GQXQ_DB_HOST='127.0.0.1';process.env.GQXQ_DB_PORT='1';process.env.GQXQ_DB_USER='synthetic';process.env.GQXQ_DB_NAME='synthetic';process.env.GQXQ_JWT_SECRET='synthetic-b4-pure';
test('B4 GeoJSON binds declared existing admin keys and rejects invalid source geometry',async()=>{
 assert.ok(existsSync(new URL('../src/services/masterDataImportParser.ts',import.meta.url)),'B4 GeoJSON parser is implemented');
 const {parseImportFile}=await import('../src/services/masterDataImportParser');
 const bytes=readFileSync(new URL('../templates/imports/grid_boundary.geojson',import.meta.url));
 const parsed=await parseImportFile({name:'boundary.geojson',bytes},'grid_boundary');assert.equal(parsed.rows[0].values.code,'001');
 const source=JSON.parse(bytes.toString());source.features[0].properties.coordinateSystem='GCJ02';
 await assert.rejects(()=>parseImportFile({name:'bad.geojson',bytes:Buffer.from(JSON.stringify(source))},'grid_boundary'),/WGS84/);
 source.features[0].properties.coordinateSystem='WGS84';source.features[0].geometry.coordinates=[[[0,0],[1,1],[1,0],[0,1],[0,0]]];
 await assert.rejects(()=>parseImportFile({name:'bad.geojson',bytes:Buffer.from(JSON.stringify(source))},'grid_boundary'),/相交/);
});
