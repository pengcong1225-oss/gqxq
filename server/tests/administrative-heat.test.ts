import test from 'node:test';import assert from 'node:assert/strict';
import {administrativeMembers} from '../src/services/administrativeHeatService';
const shape={type:'Polygon',coordinates:[[[110,30],[112,30],[112,32],[110,32],[110,30]]]};
const coverage=(code:string)=>({coverage:{code,adminGridCodes:['A'],communityCodes:[],coordinateSystem:'WGS84',geometrySources:['test'],geometry:{type:'FeatureCollection',features:[{type:'Feature',properties:{adminGridCode:'A'},geometry:shape}]}},selectedBusinessDays:['2026-11-10']});
const row={complaintId:'C1',businessDay:'2026-11-10',grids:['G1','G2'],longitude:111,latitude:31,coordinateSystem:'WGS84',coordinateSource:'人工核验',adminGridCode:null};
const cap=(rows:any[],coverages:any[]=[coverage('G1'),coverage('G2')])=>({summary:{query:{from:'2026-11-01',to:'2026-11-10'}},rows,coverageEvidence:coverages} as any);
test('administrative counts deduplicate overlapping enterprise memberships',()=>{assert.equal(administrativeMembers(cap([row])).get('A')!.rows.size,1);});
test('pending approximate points cannot become precise admin membership',()=>{assert.equal(administrativeMembers(cap([{...row,coordinateSource:'待纠偏：区县代表点'}])).get('A')!.rows.size,0);assert.equal(administrativeMembers(cap([{...row,coordinateSystem:'CGCS2000'}])).get('A')!.rows.size,0);});
test('explicit admin membership remains usable and historical days are respected',()=>{assert.equal(administrativeMembers(cap([{...row,coordinateSystem:'CGCS2000',adminGridCode:'A'}])).get('A')!.rows.size,1);assert.equal(administrativeMembers(cap([{...row,businessDay:'2026-11-09'}])).get('A')!.rows.size,0);});
test('polygon holes and outside points are excluded',()=>{const c=coverage('G1');c.coverage.geometry.features[0].geometry={...shape,coordinates:[...shape.coordinates,[[110.5,30.5],[111.5,30.5],[111.5,31.5],[110.5,31.5],[110.5,30.5]]]};assert.equal(administrativeMembers(cap([row],[c])).get('A')!.rows.size,0);});
import {administrativeHeat} from '../src/services/administrativeHeatService';
test('administrative details require complaint permission before reading data',async()=>{
 const q={dataset:'ledger',projection:'current',periodKind:'custom',from:'2026-11-01',to:'2026-11-10',comparisonPolicyId:'candidate-calendar-v1',adminGridCode:'A'};
 const ctx={userId:'test',userName:'test',clientIp:null,permissionCodes:['heatmap.read','statistics.read','dashboard.read'],access:{userId:'test',roles:[],scopeVersion:1,rules:[{kind:'all'}],canReadSource:false}} as any;
 await assert.rejects(()=>administrativeHeat(q,ctx,true),(e:any)=>e.status===403);
});
