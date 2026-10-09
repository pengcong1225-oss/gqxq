import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import type {Knex} from 'knex';
const require=createRequire(import.meta.url);
/** Empty synthetic masters for older audit-query fixtures. Uses the real B3
 * migration against the same declared legacy contract, never M0/canonical DDL. */
export async function prepareGridAuditFixture(db:Knex){
 const [rows]=await db.raw('select database() as db');const name=String(rows[0].db);
 assert.ok(['gqxq_b1_contract_test','gqxq_b2_contract_test','gqxq_a6_contract_test'].includes(name));
 assert.equal(process.env.GQXQ_DB_NAME,name);assert.equal(process.env.GQXQ_DB_HOST,'127.0.0.1');assert.equal(process.env.GQXQ_DB_PORT,'3306');
 for(const table of ['service_grid_community','service_grid_admin','service_grid_revision','community','admin_grid','grid_enterprise','service_grid'])await db.schema.dropTableIfExists(table);
 // B1/A6 do not exercise enterprise masters; B2 owns its full enterprise fixture.
 if(!await db.schema.hasTable('enterprise'))await db.raw('create table enterprise(enterprise_code varchar(64) primary key,enterprise_name varchar(128),business_type varchar(64),status varchar(16),version bigint not null default 1,district_code varchar(64)) engine=InnoDB default charset=utf8mb4');
 await db.raw('create table service_grid(id bigint auto_increment primary key,grid_code varchar(64) not null unique,grid_name varchar(128) not null,business_type varchar(64),district_code varchar(64) null) engine=InnoDB default charset=utf8mb4');
 await db.raw('create table grid_enterprise(id bigint auto_increment primary key,grid_code varchar(64) not null,enterprise_code varchar(64) not null,unique key uk_pair(grid_code,enterprise_code)) engine=InnoDB default charset=utf8mb4');
 await require('../../migrations/20261009090000__service_grid_coverage.js').up(db);
}
