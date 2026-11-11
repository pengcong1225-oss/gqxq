import test from 'node:test';
import assert from 'node:assert/strict';
import {simulatedYichangMembers} from '../src/domain/simulatedYichangGrid';
const row={complaintId:'real1',longitude:111.30,latitude:30.70,coordinateSystem:'WGS84',coordinateSource:'待纠偏：区县代表点',adminGridCode:null,communityCode:null} as any;
test('simulation assigns a stable single cell without mutating pending or real memberships',()=>{
 const before=JSON.stringify(row),a=simulatedYichangMembers([row,row]),b=simulatedYichangMembers([{...row,complaintId:'real2'},row]);
 assert.equal(a.size,1);assert.equal([...a.values()][0].rows.size,1);assert.equal([...a.keys()][0],[...b.keys()][0]);assert.equal(JSON.stringify(row),before);
 assert.deepEqual([...a.values()][0].ring[0],[111.3,30.7]);
});
test('nearby cells differ and unsupported, missing, nonfinite or distant coordinates remain unassigned',()=>{
 const rows=[row,{...row,complaintId:'r2',longitude:111.32},{...row,complaintId:'none',latitude:null},{...row,complaintId:'crs',coordinateSystem:'CGCS2000'},{...row,complaintId:'far',longitude:120},{...row,complaintId:'bad',latitude:NaN}];
 const cells=simulatedYichangMembers(rows);assert.equal(cells.size,2);assert.equal([...cells.values()].reduce((n,c)=>n+c.rows.size,0),2);
});
