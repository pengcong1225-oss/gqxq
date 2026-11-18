#!/usr/bin/env node
// Read-only verification of master data created by the import batches (never writes).
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const env = {};
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) env[m[1]] = m[2];
}
const conn = await mysql.createConnection({
  host: env.GQXQ_DB_HOST || '127.0.0.1', port: Number(env.GQXQ_DB_PORT || 3306),
  user: env.GQXQ_DB_USER || 'root', password: env.GQXQ_DB_PASSWORD || '',
  database: env.GQXQ_DB_NAME || 'gqxq_service', charset: 'utf8mb4',
});
const q = async (sql, params = []) => (await conn.query(sql, params))[0];
const out = {};
try {
  out.counts = await q(`select 'admin_grid' k, count(*) c from admin_grid
    union all select 'community', count(*) from community
    union all select 'enterprise', count(*) from enterprise
    union all select 'enterprise_department_mapping', count(*) from enterprise_department_mapping
    union all select 'dict_item_complaint_category', count(*) from dict_item where dict_type='complaint_category'
    union all select 'service_grid', count(*) from service_grid
    union all select 'service_grid_published', count(*) from service_grid where import_state='published'
    union all select 'service_grid_admin', count(*) from service_grid_admin
    union all select 'service_grid_community', count(*) from service_grid_community`);
  out.communityWithoutParent = await q(`select count(*) c from community c left join admin_grid a on a.code=c.admin_grid_code where a.code is null`);
  out.communityByDistrict = await q(`select a.district_code, count(*) c from community c join admin_grid a on a.code=c.admin_grid_code group by a.district_code order by a.district_code`);
  out.adminGridByLevel = await q(`select length(code) len, count(*) c from admin_grid group by length(code) order by len`);
  out.dictTree = await q(`select item_value,item_label,parent_code,sort_order,status,published from dict_item where dict_type='complaint_category' order by coalesce(parent_code,''),sort_order`);
  out.enterprises = await q(`select enterprise_code, enterprise_name, business_type, status, district_code from enterprise order by enterprise_code`);
  out.mappings = await q(`select source_system, source_department_code, source_department_name, enterprise_code, entity_type, aliases, verified from enterprise_department_mapping order by source_department_code`);
  out.grids = await q(`select g.grid_code, g.grid_name, g.business_type, g.import_state, g.version, e.enterprise_code, e.enterprise_name,
      (select count(*) from service_grid_admin a where a.grid_code=g.grid_code) admin_rels,
      (select min(valid_from) from service_grid_revision r where r.grid_code=g.grid_code) valid_from
    from service_grid g
    left join grid_enterprise ge on ge.grid_code=g.grid_code
    left join enterprise e on e.enterprise_code=ge.enterprise_code
    order by g.grid_code`);
  out.coverageSample = await q(`select grid_code, version, valid_from, valid_to, json_length(snapshot->'$.adminGridCodes') admin_grid_count from service_grid_revision order by grid_code limit 20`);
  out.sampleAdmin = await q(`select code,name,district_code from admin_grid order by code limit 8`);
  out.sampleCommunity = await q(`select code,name,admin_grid_code from community order by code limit 8`);
  out.dictItemTotal = await q(`select dict_type, count(*) c from dict_item group by dict_type order by dict_type`);
  console.log(JSON.stringify(out, null, 2));
} finally {
  await conn.end();
}