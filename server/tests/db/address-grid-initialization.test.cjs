const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const knex = require('knex');
const request = require('supertest');

const district = '420503';
const street = '伍家岗街道';
const community = '江湾澄月水岸小区';
const road = '云汀澄湾路18号';
const grid = { code: 'SYN-GRID', name: '合成细网格甲', district_code: district, version: 1 };
const polygon = (w, s, e, n) => ({ type: 'Polygon', coordinates: [[[w,s],[e,s],[e,n],[w,n],[w,s]]] });
// The converted WGS84 point is inside. The raw high-GCJ offset is deliberately outside.
const geometry = polygon(111.295, 30.704, 111.297, 30.706);
const json = value => typeof value === 'string' ? JSON.parse(value) : value;

test('ordinary intake extracts new addresses and fills only fields supported by map and formal grid evidence',
  { skip: process.env.GQXQ_ISOLATED_MIGRATION_TEST !== '1' }, async t => {
    const connection = { host: '127.0.0.1', port: 13317, user: 'root', password: '' };
    const admin = knex({ client: 'mysql2', connection, pool: { min: 0, max: 1 } });
    const database = `gqxq_address_grid_${process.pid}_test`;
    let db, closePool, mockMap;
    try {
      const [[server]] = await admin.raw('select @@port port, @@datadir datadir');
      assert.equal(Number(server.port), 13317);
      assert.match(String(server.datadir).replaceAll('\\', '/'), /gqxq-merge-mysql-20261111\/data\/$/);
      await admin.raw('create database ?? character set utf8mb4 collate utf8mb4_0900_ai_ci', [database]);
      db = knex({ client: 'mysql2', connection: { ...connection, database, multipleStatements: true },
        migrations: { directory: path.join(__dirname, '../../migrations'), disableTransactions: true } });
      await db.raw(readFileSync(path.join(__dirname, '../fixtures/external-baseline-ddl.sql'), 'utf8'));
      await db.migrate.latest();

      let forwardLevel = '住宅区', forwardCount = 1, reverseDistrict = district, mapAvailable = true;
      let beforeForward = async () => {};
      const queries = [];
      mockMap = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        res.setHeader('Content-Type', 'application/json');
        if (url.pathname === '/v3/geocode/geo') {
          if (!mapAvailable) { res.writeHead(503).end(); return; }
          const address = url.searchParams.get('address');
          queries.push(address);
          await beforeForward();
          const place = address.includes(road) ? road : community;
          const hit = { location: '111.302,30.702', adcode: district, district: '伍家岗区',
            level: forwardLevel, formatted_address: `湖北省宜昌市伍家岗区${street}${place}` };
          res.end(JSON.stringify({ status: '1', geocodes: Array.from({ length: forwardCount }, () => hit) }));
        } else if (url.pathname === '/v3/geocode/regeo') {
          res.end(JSON.stringify({ status: '1', regeocode: { addressComponent: {
            adcode: reverseDistrict, city: '宜昌市', district: reverseDistrict === district ? '伍家岗区' : '西陵区', township: street,
          } } }));
        } else res.writeHead(404).end();
      });
      await new Promise(resolve => mockMap.listen(0, '127.0.0.1', resolve));
      for (const key of Object.keys(process.env)) if (/^(GQXQ_|DOTENV_CONFIG_)/.test(key)) delete process.env[key];
      Object.assign(process.env, {
        NODE_ENV: 'test', DOTENV_CONFIG_PATH: path.join(__dirname, '__absent_env__'),
        GQXQ_DB_HOST: '127.0.0.1', GQXQ_DB_PORT: '13317', GQXQ_DB_USER: 'root', GQXQ_DB_PASSWORD: '',
        GQXQ_DB_NAME: database, GQXQ_JWT_SECRET: 'synthetic-address-test-key-1234567890123456',
        GQXQ_AMAP_KEY: 'synthetic-local-map-key', GQXQ_AMAP_BASE_URL: `http://127.0.0.1:${mockMap.address().port}`,
        GQXQ_PU_DELIVERY_WORKER_ENABLED: 'false', GQXQ_PU_UTILITY_SYNC_ENABLED: 'false',
      });
      closePool = require('../../src/db/pool').closePool;
      const app = require('../../src/app').createApp();
      const intake = async (sourceId, content, fields = {}) => {
        const response = await request(app).post('/api/v1/external/yijiejieban/appeal')
          .send({ sourceId, title: '居民反映燃气供气问题', content, ...fields });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const complaint = await db('complaint').where({ source_id: sourceId }).first();
        assert.ok(complaint);
        for (let attempt = 0; attempt < 160; attempt++) {
          const job = await db('complaint_location_initialization').where({ complaint_id: complaint.complaint_id }).first();
          if (job) return { job, row: await db('complaint').where({ complaint_id: complaint.complaint_id }).first() };
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        assert.fail('The ordinary intake did not complete the location job');
      };
      const addBoundary = (data, polygon, source = '合成验收提供的授权正式网格边界', coordinateSystem = 'WGS84') => db('admin_grid').insert({
        ...data, geometry: polygon ? JSON.stringify(polygon) : null, coordinate_system: coordinateSystem, geometry_source: source,
      });

      await t.test('unknown community name is extracted from prose and mapped without inventing a master-data code', async () => {
        const result = await intake('addr-no-grid', `您好，事发地在${community}，近几天一直没有燃气。`);
        assert.deepEqual(queries, [`湖北省宜昌市${community}`]);
        const candidate = await db('complaint_address_candidate').where({ complaint_id: result.row.complaint_id }).first();
        assert.equal(candidate.candidate_text, community);
        assert.equal(result.row.address, community);
        assert.equal(result.row.community_name, community);
        assert.equal(result.row.community_code, null);
        assert.equal(result.row.street_name, street);
        assert.equal(result.row.district_code, district);
        assert.equal(result.row.district_name, '伍家岗区');
        assert.equal(result.row.admin_grid_code, null);
        assert.equal(result.job.state, 'review');
        assert.match(result.job.reason, /网格.*待核/);
        assert.equal(json(result.row.source_fields).address, null);
      });
      await t.test('road and door number link to a unique formal grid in WGS84', async () => {
        await addBoundary(grid, geometry);
        forwardLevel = '门牌号';
        const { row, job } = await intake('addr-road', `来电反映燃气中断，地址是${road}，请尽快恢复。`);
        assert.equal(row.address, road);
        assert.equal(row.admin_grid_code, grid.code);
        assert.equal(row.grid_name, grid.name);
        assert.equal(row.street_name, street);
        assert.equal(row.location_coordinate_system, 'WGS84');
        assert.ok(Math.abs(Number(row.location_lng) - 111.296316) < .000002);
        assert.equal(job.state, 'matched');
      });
      await t.test('a stored verified community point remains usable during a map outage without assigning a grid', async () => {
        await db('community').insert({ code: 'SYN-COMMUNITY', name: community, district_code: district,
          admin_grid_code: grid.code, version: 1, location_lng: 111.296316, location_lat: 30.704419,
          location_coordinate_system: 'WGS84', location_state: 'located' });
        mapAvailable = false;
        const { row, job } = await intake('addr-stored-point', `事发地在${community}。`);
        mapAvailable = true;
        assert.ok(Math.abs(Number(row.location_lng) - 111.296316) < .000002);
        assert.match(row.location_coordinate_source, /小区主数据匹配/);
        assert.equal(row.admin_grid_code, null);
        assert.equal(row.community_code, null);
        assert.equal(job.state, 'retry');
        await db('community').where({ code: 'SYN-COMMUNITY' }).del();
      });
      await t.test('overlap and unrecognized coordinate systems cannot assign a grid', async () => {
        await addBoundary({ ...grid, code: 'SYN-OVERLAP' }, geometry);
        let result = await intake('addr-overlap', `家住${road}。`);
        assert.equal(result.row.admin_grid_code, null);
        assert.equal(result.job.state, 'review');
        await db('admin_grid').where({ district_code: district }).whereIn('code', [grid.code, 'SYN-OVERLAP']).del();
        await addBoundary(grid, geometry, '合成验收提供的授权正式网格边界', 'GCJ02');
        result = await intake('addr-coordinates', `家住${road}。`);
        assert.equal(result.row.admin_grid_code, null);
        assert.equal(result.job.state, 'review');
        await addBoundary({ ...grid, code: '420503004' }, geometry);
        result = await intake('addr-township', `家住${road}。`);
        assert.equal(result.row.admin_grid_code, null);
        assert.equal(result.job.state, 'review');
      });
      await t.test('ambiguous geocode and inconsistent districts leave the address for review', async () => {
        forwardCount = 2;
        let result = await intake('addr-map-conflict', `家住${road}。`);
        assert.equal(result.row.address, null);
        assert.equal(result.row.admin_grid_code, null);
        assert.equal(result.job.state, 'review');
        forwardCount = 1;
        reverseDistrict = '420502';
        result = await intake('addr-district-conflict', `家住${road}。`);
        assert.equal(result.row.district_code, null);
        assert.equal(result.row.admin_grid_code, null);
        assert.equal(result.job.state, 'review');
        reverseDistrict = district;
      });
      await t.test('a human field decision made during a map request survives initialization', async () => {
        await db('admin_grid').where({ code: grid.code }).update({ coordinate_system: 'WGS84' });
        beforeForward = async () => {
          beforeForward = async () => {};
          const row = await db('complaint').where({ source_id: 'addr-human' }).first();
          const state = json(row.effective_field_state);
          state.admin_grid_code = { resolution: 'confirmed', value: null, version: 2, reason: '人工确认暂不归格' };
          await db('complaint').where({ complaint_id: row.complaint_id }).update({ effective_field_state: JSON.stringify(state), edit_version: 2 });
        };
        const response = await request(app).post('/api/v1/external/yijiejieban/appeal')
          .send({ sourceId: 'addr-human', title: '燃气问题', content: `家住${road}。` });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const row = await db('complaint').where({ source_id: 'addr-human' }).first();
        const { initializeLocations } = require('../../src/services/locationInitializationService');
        await initializeLocations(1, row.complaint_id);
        await initializeLocations(1, row.complaint_id);
        const after = await db('complaint').where({ complaint_id: row.complaint_id }).first();
        assert.equal(after.admin_grid_code, null);
        assert.equal(json(after.effective_field_state).admin_grid_code.resolution, 'confirmed');
      });
    } finally {
      if (closePool) await closePool();
      if (mockMap) await new Promise(resolve => mockMap.close(resolve));
      if (db) { await db.destroy(); await admin.raw('drop database ??', [database]); }
      await admin.destroy();
    }
  });
