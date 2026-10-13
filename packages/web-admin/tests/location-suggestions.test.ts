import assert from 'node:assert/strict';
import {test} from 'node:test';
import {suggestLocations,adoptLocation,safePlaceQuery,resolveAddressLocation} from '../src/utils/locationSuggestions';
const options={districts:[{code:'D1',name:'甲区'},{code:'D2',name:'乙区'}],adminGrids:[{code:'A1',name:'甲网格',districtCode:'D1'},{code:'A2',name:'乙网格',districtCode:'D2'}],communities:[{code:'C1',name:'春华小区',adminGridCode:'A1'},{code:'C2',name:'春华小区',adminGridCode:'A2'},{code:'C3',name:'秋实小区',adminGridCode:'A1'}]};
const detail=(content:string)=>({content,title:'供水问题',locationClues:[],addressCandidate:null,locationConflict:false} as any);
test('same-name ambiguity and unknown text never produce a confident suggestion',()=>{assert.equal(suggestLocations(detail('春华小区停水'),options).unique,null);assert.equal(suggestLocations(detail('请联系13812345678解决停水'),options).candidates.length,0);});
test('explicit district evidence disambiguates authorized communities',()=>{const s=suggestLocations(detail('甲区春华小区停水'),options);assert.equal(s.unique?.communityCode,'C1');});
test('contradictory district and structured candidate evidence require manual review',()=>{const d=detail('乙区秋实小区停水');d.addressCandidate={value:'秋实小区',districtCode:'D1',evidence:'秋实小区',sourceField:'content'};assert.equal(suggestLocations(d,options).unique,null);});
test('adopting a new location clears stale coordinates',()=>{const d=adoptLocation({lng:'111',lat:'30',coordinateSystem:'WGS84',coordinateSource:'old'}, {address:'秋实小区',communityCode:'C3',adminGridCode:'A1',districtCode:'D1'});assert.equal(d.lng,'');assert.equal(d.coordinateSystem,'unknown');});
test('external query never receives prose or telephone numbers',()=>{assert.equal(safePlaceQuery('请联系13812345678解决秋实小区停水'),null);assert.equal(safePlaceQuery('秋实小区停水请处理'),null);assert.equal(safePlaceQuery('甲区秋实小区'),'甲区秋实小区');});
test('residence community and independently evidenced road stay ambiguous',()=>{const d=detail('居住在秋实小区，反映甲区建设路停水');d.addressCandidate={value:'建设路',districtCode:'D1',evidence:'甲区建设路停水',sourceField:'content'};const result=suggestLocations(d,options);assert.equal(result.unique,null);assert.deepEqual(result.candidates.map((c:any)=>c.address),['秋实小区','建设路']);});
test('structured address containing the same community keeps precise address and relationships',()=>{const d=detail('甲区秋实小区3号停水');d.addressCandidate={value:'甲区秋实小区3号',districtCode:'D1',evidence:'甲区秋实小区3号停水',sourceField:'content'};const result=suggestLocations(d,options);assert.equal(result.candidates.length,1);assert.equal(result.unique?.address,'甲区秋实小区3号');assert.equal(result.unique?.communityCode,'C3');});

const addressOptions={...options,districts:[...options.districts,{code:'420504',name:'点军区'}]};
test('full map address resolves district without requiring a community match',()=>{
 const result=resolveAddressLocation('湖北省宜昌市点军区联棚乡卢家冲东南约62米',addressOptions);
 assert.equal(result.location.districtCode,'420504');assert.equal(result.location.communityCode,null);assert.equal(result.location.adminGridCode,null);assert.equal(result.township,'联棚乡');assert.match(result.message,/未匹配/);
});
test('address resolves authorized community parents and retains exact address',()=>{
 const result=resolveAddressLocation('甲区春华小区3号',options);
 assert.deepEqual(result.location,{address:'甲区春华小区3号',districtCode:'D1',adminGridCode:'A1',communityCode:'C1'});
});
test('ambiguous communities and contradictory districts never auto-select a child',()=>{
 assert.equal(resolveAddressLocation('春华小区',options).location.communityCode,null);
 const result=resolveAddressLocation('甲区乙区秋实小区',options);assert.equal(result.location.districtCode,null);assert.equal(result.location.communityCode,null);
 assert.equal(resolveAddressLocation('乙区秋实小区',options).location.communityCode,null);
});
test('exact registered grid resolves district without inventing community',()=>{
 const result=resolveAddressLocation('甲网格建设路',options);assert.equal(result.location.adminGridCode,'A1');assert.equal(result.location.districtCode,'D1');assert.equal(result.location.communityCode,null);
 assert.equal(resolveAddressLocation('未登记地点',options).location.districtCode,null);
});

test('explicit unauthorized county cannot be replaced by a scoped same-name community',()=>{
 const scoped={districts:[{code:'420504',name:'点军区'}],adminGrids:[{code:'A1',name:'甲网格',districtCode:'420504'}],communities:[{code:'C1',name:'秋实小区',adminGridCode:'A1'}]};
 for(const address of ['湖北省宜昌市西陵区秋实小区3号','西陵区秋实小区3号','湖北省宜昌市枝江市秋实小区3号']){
 const r=resolveAddressLocation(address,scoped);assert.equal(r.location.districtCode,null);assert.equal(r.location.communityCode,null);assert.match(r.message,/授权名录/);
 }
 assert.equal(resolveAddressLocation('秋实小区3号',scoped).location.communityCode,'C1');
});
