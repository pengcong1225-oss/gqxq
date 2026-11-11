import test from 'node:test';
import assert from 'node:assert/strict';
import {locationQuery,acceptGeocode,mayInitialize,initializationAddress} from '../src/domain/locationInitialization';
test('only short structured addresses leave the system',()=>{
 assert.equal(locationQuery({address:'西陵区',district_name:'西陵区'}),null);
 assert.equal(locationQuery({address:'请联系13812345678，反映停水',district_name:'西陵区'}),null);
 assert.equal(locationQuery({address:'夷陵广场',district_name:'西陵区'}),'湖北省宜昌市西陵区夷陵广场');
 assert.equal(locationQuery({address:null,district_name:'西陵区'}),null);
});
test('accept only high score detailed matches inside the intended district',()=>{
 const g={status:'0',location:{score:100,level:'兴趣点',lon:'111.289231',lat:'30.703744'}};
 const reverse={status:'0',result:{addressComponent:{city:'宜昌市',county:'西陵区',county_code:'156420502'}}};
 assert.ok(acceptGeocode(g,reverse,{district_code:'420502',district_name:'西陵区'}));
 assert.equal(acceptGeocode({...g,location:{...g.location,score:undefined}},reverse,{district_code:'420502'}),null);
 assert.equal(acceptGeocode({...g,location:{...g.location,score:60}},reverse,{district_code:'420502'}),null);
 assert.equal(acceptGeocode({...g,location:{...g.location,level:'区县'}},reverse,{district_code:'420502'}),null);
 assert.equal(acceptGeocode(g,reverse,{district_code:'420503'}),null);
 assert.equal(acceptGeocode({...g,location:{...g.location,lon:'0'}},reverse,{district_code:'420502'}),null);
 assert.equal(acceptGeocode(g,{status:'1'},{}),null);
});
test('manual coordinates and manual clear decisions are preserved',()=>{
 assert.equal(mayInitialize({location_lng:null,location_lat:null}),true);
 assert.equal(mayInitialize({location_lng:111,location_lat:30}),false);
 assert.equal(mayInitialize({location_lng:null,location_lat:null,effective_field_state:{location_lng:{resolution:'confirmed'}}}),false);
 assert.equal(mayInitialize({location_lng:null,location_lat:null,effective_field_state:JSON.stringify({location_lat:{resolution:'no_correction'}})}),false);
});

test('a manually cleared or rejected address cannot be resurrected from a candidate',()=>{
 for(const resolution of ['confirmed','no_correction','needs_verification']) assert.equal(initializationAddress({address:null,candidate_text:'夷陵广场',effective_field_state:{address:{resolution}}}),null);
 assert.equal(initializationAddress({address:null,candidate_text:'夷陵广场',parent_match:'conflict'}),null);
 assert.equal(initializationAddress({address:null,candidate_text:'夷陵广场'}),'夷陵广场');
});

import {fallbackLocation,acceptApproximateGeocode} from '../src/domain/locationFallback';
test('offline fallback needs an unambiguous county and is explicitly approximate',()=>{
 assert.equal(fallbackLocation({}),null);
 assert.equal(fallbackLocation({address:'未知小区'}),null);
 assert.equal(fallbackLocation({district_code:'420502',district_name:'伍家岗区'}),null);
 const p=fallbackLocation({district_code:'420502'});assert.ok(p);assert.equal(p.level,'区县代表点');assert.match(p.source,/待纠偏/);
 assert.ok(fallbackLocation({address:'西陵区某小区'}));
 assert.equal(fallbackLocation({address:'西陵区与伍家岗区交界'}),null);
});
test('approximate provider results must still validate geography',()=>{
 const f={status:'0',location:{lon:111.3,lat:30.7,score:60,level:'道路'}};
 const r={status:'0',result:{addressComponent:{city:'宜昌市',county_code:'156420502',county:'西陵区'}}};
 assert.ok(acceptApproximateGeocode(f,r,{district_code:'420502'}));
 assert.equal(acceptApproximateGeocode(f,r,{district_code:'420503'}),null);
 assert.equal(acceptApproximateGeocode({...f,location:{...f.location,lon:0}},r,{}),null);
});
test('local complaint clues can infer a county without sending personal content',()=>{
 assert.ok(fallbackLocation({title:'西陵区供水问题',content:'小区停水'}));
 assert.equal(fallbackLocation({content:'不是西陵区，地址未知'}),null);
 assert.equal(fallbackLocation({content:'西陵区与伍家岗区交界处'}),null);
});
import {confirmedCoordinateSource} from '../src/domain/locationFallback';
test('human confirmation clears the pending marker while retaining provenance',()=>{
 assert.equal(confirmedCoordinateSource(null),null);
 assert.equal(confirmedCoordinateSource('手工选点'),'手工选点');
 assert.equal(confirmedCoordinateSource('待纠偏：西陵区代表点'),'已人工核验（原近似来源）：西陵区代表点');
});
