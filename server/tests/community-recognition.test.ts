import test from 'node:test';import assert from 'node:assert/strict';
import {recognizedCommunity} from '../src/domain/communityRecognition';
const p={name:'幸福小区',districtCode:'420502',providerLevel:'兴趣点',score:100,longitude:111.3,latitude:30.7};
const row={district_code:'420502',district_name:'西陵区',location_lng:111.3,location_lat:30.7,content:'西陵区幸福小区停水',effective_field_state:{location_lng:{resolution:'unresolved'},location_lat:{resolution:'unresolved'},location_coordinate_system:{resolution:'unresolved'},location_coordinate_source:{resolution:'unresolved'}}};
test('clear residential point can be automatically accepted',()=>assert.equal(recognizedCommunity(row,[{name:'幸福小区',level:'小区',districtCode:'420502',districtName:'西陵区'}],p),true));
test('ambiguity, approximate score, district conflict and manual decisions remain protected',()=>{
 const c=[{name:'幸福小区',level:'小区' as const,districtCode:'420502',districtName:'西陵区'}];
 assert.equal(recognizedCommunity(row,[...c,{...c[0],name:'春天小区'}],p),false);
 assert.equal(recognizedCommunity(row,c,{...p,score:94}),false);
 assert.equal(recognizedCommunity({...row,district_code:'420503'},c,p),false);
 assert.equal(recognizedCommunity({...row,effective_field_state:{location_lng:{resolution:'confirmed'}}},c,p),false);
});
test('explicit map county may fill a missing county and 95 is sufficient',()=>{
 const c=[{name:'幸福小区',level:'小区' as const,districtCode:'420502',districtName:'西陵区'}];
 assert.equal(recognizedCommunity({...row,district_code:null},c,{...p,score:95}),true);
 assert.equal(recognizedCommunity({...row,address:'西陵区幸福路12号'},c,p),true);
 assert.equal(recognizedCommunity({...row,address:'春天小区'},c,p),false);
});
test('county name also protects missing-code records',()=>{
 assert.equal(recognizedCommunity({...row,district_code:null,district_name:'伍家岗区'},[{name:'幸福小区',level:'小区',districtCode:'420502',districtName:'西陵区'}],p),false);
});
