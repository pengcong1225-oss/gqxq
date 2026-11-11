import test from 'node:test';
import assert from 'node:assert/strict';
import {locationCandidates} from '../src/domain/locationCandidates';
test('community without door number precedes road and township',()=>{
 const c=locationCandidates({content:'本人是西陵区西湖路北辰明珠小区业主，最近经常停水。'});
 assert.ok(c.some(x=>x.name==='北辰明珠小区'));assert.ok(c.some(x=>x.name==='西湖路'));
 assert.equal(c[0].level,'小区');
});
test('known township and rejected places handled locally',()=>{
 assert.ok(locationCandidates({content:'秭归县茅坪镇停水'}).some(x=>x.name==='茅坪镇'));
 assert.ok(!locationCandidates({content:'以前住在幸福小区，现在住在春天花园小区。'}).some(x=>x.name==='幸福小区'));
});
test('phone and narrative never become query',()=>{
 const c=locationCandidates({content:'请联系13812345678，投诉燃气公司，希望尽快解决'});assert.equal(c.length,0);
});
import {mayRefineLocation,cachedLocation} from '../src/domain/locationCandidates';
test('only unresolved automatic district points may be refined',()=>{
 const r={location_lng:111,location_lat:30,location_coordinate_source:'待纠偏：西陵区区县代表点',effective_field_state:{location_lng:{resolution:'unresolved'},location_lat:{resolution:'unresolved'},location_coordinate_system:{resolution:'unresolved'},location_coordinate_source:{resolution:'unresolved'}}};
 assert.equal(mayRefineLocation(r),true);
 assert.equal(mayRefineLocation({...r,location_coordinate_source:'人工选点'}),false);
 assert.equal(mayRefineLocation({...r,effective_field_state:{location_lng:{resolution:'confirmed'}}}),false);
 assert.equal(mayRefineLocation({...r,effective_field_state:null}),false);
});
test('conflicting candidates and district metadata never bypass protection',()=>{
 assert.equal(locationCandidates({candidate_text:'团结路',district_code:'420502',parent_match:'conflict'}).length,0);
 assert.equal(locationCandidates({content:'团结路',district_code:'420502',district_name:'伍家岗区'}).length,0);
 assert.equal(locationCandidates({candidate_text:'团结路',content:'团结路',address:null,effective_field_state:{address:{resolution:'confirmed'}}}).length,0);
});
test('door prefixes and generic prose are not extra communities',()=>{
 const c=locationCandidates({district_code:'420502',content:'西陵区南苑街道12号山庄花苑，目前我们小区停水，山庄花苑业主要求解决。'});
 assert.equal(c.filter(x=>x.level==='小区').length,1);assert.equal(c[0].name,'山庄花苑');
});
import {shouldImproveLocation} from '../src/domain/locationCandidates';
test('refinement cannot downgrade roads or rewrite the same point',()=>{
 const r={location_lng:111.3,location_lat:30.7,location_coordinate_source:'待纠偏：实际精度道路，分数100'};
 assert.equal(shouldImproveLocation(r,{longitude:111.4,latitude:30.8,level:'乡镇',score:100}),false);
 assert.equal(shouldImproveLocation(r,{longitude:111.3,latitude:30.7,level:'道路',score:100}),false);
 assert.equal(shouldImproveLocation(r,{longitude:111.31,latitude:30.71,level:'小区',score:95}),true);
});

test('provider precision aliases cannot downgrade existing points',()=>{
 const r={location_lng:111.3,location_lat:30.7,location_coordinate_source:'待纠偏：实际精度道路，分数100'};
 for(const level of ['乡镇街道','区县','未知'])assert.equal(shouldImproveLocation(r,{longitude:111.4,latitude:30.8,level,score:100}),false);
 assert.equal(shouldImproveLocation({...r,location_coordinate_source:'待纠偏：实际精度社区村落'}, {longitude:111.4,latitude:30.8,level:'兴趣点',score:100}),true);
});

test('cached community category respects actual provider precision',()=>{
 assert.equal(shouldImproveLocation({location_lng:111.3,location_lat:30.7,location_coordinate_source:'待纠偏：实际精度社区村落'},{longitude:111.3,latitude:30.7,level:'小区',providerLevel:'社区村落',score:100}),false);
});
