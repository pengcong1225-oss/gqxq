const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createServer } = require('node:http');
const { hashSync } = require('bcryptjs');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const knex = require('knex');
const request = require('supertest');

const district = '420503';
const street = '伍家岗街道';
const community = '江湾澄月水岸小区';
const road = '云汀澄湾路18号';
const namedGrid = { code: 'SYN-AREA', name: '荷汀东07网格', district_code: district, version: 1 };
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
      let mapNamesGrid = false;
      let beforeForward = async () => {};
      let beforeJitterResult = async () => {};
      const jitterJobs = [];
      const queries = [];
      mockMap = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        res.setHeader('Content-Type', 'application/json');
        if (url.pathname === '/v3/geocode/geo') {
          if (!mapAvailable) { res.writeHead(503).end(); return; }
          const address = url.searchParams.get('address');
          queries.push(address);
          await beforeForward();
          const place = address.includes(namedGrid.name) ? (mapNamesGrid ? namedGrid.name : road) : address.includes(road) ? road : community;
          const hit = { location: '111.302,30.702', adcode: district, district: '伍家岗区',
            level: forwardLevel, formatted_address: `湖北省宜昌市伍家岗区${street}${place}` };
          res.end(JSON.stringify({ status: '1', geocodes: Array.from({ length: forwardCount }, () => hit) }));
        } else if (url.pathname === '/v3/geocode/regeo') {
          res.end(JSON.stringify({ status: '1', regeocode: { addressComponent: {
            adcode: reverseDistrict, city: '宜昌市', district: reverseDistrict === district ? '伍家岗区' : '西陵区', township: street,
          } } }));
        } else if (url.pathname === '/api/v1/jitter/jobs' && req.method === 'POST') {
          const parts = [];
          for await (const chunk of req) parts.push(chunk);
          const input = JSON.parse(Buffer.concat(parts).toString());
          if (req.headers['x-app-id'] !== 'test-location-jitter' || req.headers['x-api-key'] !== 'synthetic-jitter-key' ||
            !req.headers['idempotency-key'] || input.crs !== 'EPSG:4326') { res.writeHead(400).end(); return; }
          jitterJobs.push(input.items);
          res.writeHead(202).end(JSON.stringify({ job_id: `job-${jitterJobs.length}`, status: 'queued', crs: input.crs, simulated: false }));
        } else if (/^\/api\/v1\/jitter\/jobs\/job-\d+$/.test(url.pathname)) {
          res.end(JSON.stringify({ job_id: url.pathname.split('/').at(-1), status: 'succeeded', crs: 'EPSG:4326', simulated: false }));
        } else if (/^\/api\/v1\/jitter\/jobs\/job-\d+\/results$/.test(url.pathname)) {
          const items = jitterJobs[Number(url.pathname.match(/job-(\d+)/)[1])-1];
          await beforeJitterResult();
          res.end(JSON.stringify({ job_id: url.pathname.split('/').at(-2), total: items.length, simulated: false,
            items: items.map(item => ({ business_id: item.business_id, simulated: false,
              status: 'success', input: item, output: { longitude: item.longitude + .00015, latitude: item.latitude + .0001 }, error: null })) }));
        } else res.writeHead(404).end();
      });
      await new Promise(resolve => mockMap.listen(0, '127.0.0.1', resolve));
      for (const key of Object.keys(process.env)) if (/^(GQXQ_|DOTENV_CONFIG_)/.test(key)) delete process.env[key];
      Object.assign(process.env, {
        NODE_ENV: 'test', DOTENV_CONFIG_PATH: path.join(__dirname, '__absent_env__'),
        GQXQ_DB_HOST: '127.0.0.1', GQXQ_DB_PORT: '13317', GQXQ_DB_USER: 'root', GQXQ_DB_PASSWORD: '',
        GQXQ_DB_NAME: database, GQXQ_JWT_SECRET: 'synthetic-address-test-key-1234567890123456',
        GQXQ_AMAP_KEY: 'synthetic-local-map-key', GQXQ_AMAP_BASE_URL: `http://127.0.0.1:${mockMap.address().port}`,
        GQXQ_JITTER_BASE_URL: `http://127.0.0.1:${mockMap.address().port}`, GQXQ_JITTER_APP_ID: 'test-location-jitter',
        GQXQ_JITTER_API_KEY: 'synthetic-jitter-key', GQXQ_JITTER_POLL_MS: '1', GQXQ_SCREEN_COORD_SOURCE: 'original',
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

      await t.test('ordinary address intake and manual revision publish only their latest jittered coordinates', async () => {
        const password = 'synthetic-address-password-123';
        await db('app_user').insert({ user_id: 'jitter-test-admin', username: 'jitter-test-admin', real_name: '坐标测试', password_hash: hashSync(password, 4),
          roles: JSON.stringify(['admin']), permissions: '[]', status: 1, scope_rules: JSON.stringify([{ kind: 'all' }]), must_change_password: 0 });
        const login = await request(app).post('/api/v1/auth/login').send({ username: 'jitter-test-admin', password });
        assert.equal(login.status, 200, JSON.stringify(login.body));
        const auth = `Bearer ${login.body.data.token}`;
        const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
        forwardLevel = '门牌号';
        const { row } = await intake('addr-jitter', `家住${road}。`).finally(() => { forwardLevel = '住宅区'; queries.length = 0; });
        const id = row.complaint_id;
        const path = `/api/v1/complaints/${id}`;
        const detail = async () => (await request(app).get(path).set('Authorization', auth).expect(200)).body.data;
        const point = async () => {
          const r = await request(app).get('/api/v1/heatmap/administrative-data').set('Authorization', auth)
            .query({ dataset: 'ledger', projection: 'current', periodKind: 'custom', from: today, to: today,
              comparisonPolicyId: 'candidate-calendar-v1' }).expect(200);
          return r.body.data.points.find(p => p.complaintId === id);
        };
        assert.equal((await detail()).displayLocation, null);
        assert.equal(await point(), undefined);
        const { processComplaintLocationJitter } = require('../../src/services/complaintLocationJitterService');
        await processComplaintLocationJitter();
        const original = (await detail()).displayLocation;
        assert.equal(original.coordinateSource, 'jitter');
        assert.ok(Math.abs(original.longitude - Number(row.location_lng) - .00015) < 1e-8);
        assert.equal((await point()).longitude, original.longitude);
        assert.equal((await detail()).locationLng, Number(row.location_lng));

        const revise = async (longitude, latitude, revision = true, address) => {
          const current = await detail();
          const response = await request(app).post(`${path}/location-corrections`).set('Authorization', auth).send({
            revision, expectedVersion: current.editVersion, districtCode: current.districtCode, address: address ?? current.address,
            longitude, latitude, adminGridCode: null, communityCode: null,
            coordinateSystem: longitude === null ? null : 'WGS84', coordinateSource: longitude === null ? null : '人工核验测试点', basis: '人工作业核验位置',
          });
          assert.equal(response.status, 200, JSON.stringify(response.body));
        };
        await revise(111.297, 30.705, false);
        assert.equal((await detail()).displayLocation, null);
        assert.equal(await point(), undefined);

        let release, seen;
        const inFlight = new Promise(resolve => { seen = resolve; });
        beforeJitterResult = () => new Promise(resolve => { release = resolve; seen(); });
        const staleJob = processComplaintLocationJitter();
        try {
          await Promise.race([inFlight, staleJob.then(() => assert.fail('gateway did not receive the revised point'))]);
          await revise(111.298, 30.706);
        } finally {
          beforeJitterResult = async () => {};
          release?.();
          await staleJob;
        }
        assert.equal((await detail()).displayLocation, null);
        assert.equal(await point(), undefined);
        await processComplaintLocationJitter();
        assert.equal((await detail()).displayLocation.longitude, 111.29815);
        assert.equal((await point()).longitude, 111.29815);
        assert.equal((await detail()).locationLng, 111.298);
        const jobsBeforeAddressChange = jitterJobs.length;
        await revise(111.298, 30.706, true, '云汀澄湾路19号');
        assert.equal((await detail()).displayLocation, null);
        assert.equal(await point(), undefined);
        await processComplaintLocationJitter();
        assert.equal(jitterJobs.length, jobsBeforeAddressChange + 1);
        assert.equal((await point()).longitude, 111.29815);
        await revise(null, null);
        assert.equal((await detail()).displayLocation, null);
        assert.equal(await point(), undefined);
      });

      await t.test('screen community points and street anchors reuse successful jitter without exposing missing or failed points', async () => {
        const login = await request(app).post('/api/v1/auth/login')
          .send({ username: 'jitter-test-admin', password: 'synthetic-address-password-123' }).expect(200);
        const auth = `Bearer ${login.body.data.token}`;
        const streetCodes = ['420503098', '420503099', '420503097'];
        const sample = streetCodes.map((code, i) => ({ code: 'TEST-COMMUNITY-' + i, name: '合成地图小区' + i,
          admin_grid_code: code, district_code: district, version: 1, location_lng: 111.25 + i / 100,
          location_lat: 30.705, location_coordinate_system: 'WGS84', location_state: 'located' }));
        Object.assign(sample[1], { jitter_state: 'failed', jitter_lng: 111.261, jitter_lat: 30.706 });
        Object.assign(sample[2], { jitter_state: 'succeeded', jitter_lng: 111.2702, jitter_lat: 30.7051 });
        await db('admin_grid').insert(streetCodes.map(code => ({ code, name: '合成边界' + code, district_code: district, version: 1 })));
        await db('community').insert(sample);
        try {
          const screen = await request(app).get('/api/v1/screen/bootstrap').set('Authorization', auth).expect(200);
          const focused = screen.body.data.spatial.data.communities.filter(c => c.id.startsWith('TEST-COMMUNITY-'));
          assert.deepEqual(focused.map(c => [c.id, c.longitude, c.coordinateSource]), [[sample[2].code, 111.2702, 'jitter']]);
          const boundaries = await request(app).get('/api/v1/assessment/admin-boundaries').set('Authorization', auth).expect(200);
          const streets = boundaries.body.data.boundaries.filter(b => streetCodes.includes(b.code));
          assert.deepEqual(streets.map(b => [b.code, b.source, b.anchor]), [[streetCodes[2], 'buffer', [111.2702, 30.7051]]]);
        } finally {
          await db('community').whereIn('code', sample.map(c => c.code)).del();
          await db('admin_grid').whereIn('code', streetCodes).del();
        }
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
      await t.test('grid-only prose queries Amap and corroborates a formal grid without inventing a detailed address or point', async () => {
        await addBoundary(namedGrid, geometry);
        const parentCode = '420503004101';
        await addBoundary({ ...namedGrid, code: parentCode, name: '荷汀行政社区' }, geometry,
          '宜昌 CIM 宜昌网格20230512/skjc_xzq_cun_new SmID=99');
        forwardLevel = '门牌号';
        const count = queries.length;
        const { row, job } = await intake('grid-by-name', `您好，事发地在${namedGrid.name}，周边持续没有燃气。`);
        const candidate = await db('complaint_address_candidate').where({ complaint_id: row.complaint_id }).first();
        assert.equal(candidate?.candidate_text, namedGrid.name);
        assert.deepEqual(queries.slice(count), [`湖北省宜昌市${namedGrid.name}`]);
        assert.equal(row.grid_name, namedGrid.name);
        assert.equal(row.admin_grid_code, namedGrid.code);
        assert.equal(row.district_code, district);
        for (const field of ['address', 'community_name', 'community_code', 'location_lng', 'location_lat']) {
          assert.equal(row[field], null, field);
        }
        assert.equal(job.state, 'review');
        assert.match(job.reason, /详细地址和坐标待核验/);
        await db('admin_grid').whereIn('code', [namedGrid.code, parentCode]).del();
      });
      await t.test('a grid name cannot bind to a different grid containing the map result', async () => {
        await addBoundary(namedGrid, polygon(111.31, 30.71, 111.32, 30.72));
        const other = { ...namedGrid, code: 'SYN-OTHER-AREA', name: '云汀西01网格' };
        await addBoundary(other, geometry);
        const { row, job } = await intake('grid-map-outside-name', `事发地在${namedGrid.name}。`);
        assert.equal(row.admin_grid_code, null);
        assert.equal(row.grid_name, null);
        assert.equal(row.district_code, null);
        assert.equal(row.location_lng, null);
        assert.equal(job.state, 'review');
        assert.match(job.reason, /名称对应的正式边界不一致/);
        await db('admin_grid').whereIn('code', [namedGrid.code, other.code]).del();
      });
      await t.test('an exact map grid name confirms an unambiguous registered code without an imported boundary', async () => {
        await addBoundary(namedGrid, null, null, null);
        const content = `事发地在伍家岗区${namedGrid.name}。`;
        let result = await intake('grid-directory-only-road', content);
        assert.equal(result.row.admin_grid_code, null);
        mapNamesGrid = true;
        try {
          const unresolved = await intake('grid-directory-only-unscoped', `事发地在${namedGrid.name}。`);
          assert.equal(unresolved.row.admin_grid_code, null);
          result = await intake('grid-directory-only-exact', content);
          assert.equal(result.row.admin_grid_code, namedGrid.code);
          assert.equal(result.row.grid_name, namedGrid.name);
          assert.equal(result.row.address, null);
          assert.equal(result.row.community_name, null);
          assert.equal(result.row.location_lng, null);
          assert.equal(result.job.state, 'review');
          assert.match(result.job.reason, /正式网格目录.*尚无正式边界/);
        } finally {
          mapNamesGrid = false;
          await db('admin_grid').where({ code: namedGrid.code }).del();
        }
      });
      await t.test('same-named grids are disambiguated only by independently supplied districts', async () => {
        await addBoundary(namedGrid, geometry);
        await addBoundary({ ...namedGrid, code: 'SYN-AREA-WEST', district_code: '420502' }, null);
        let result = await intake('grid-name-ambiguous', `我家在${namedGrid.name}，燃气供应异常。`);
        assert.equal(result.row.admin_grid_code, null);
        assert.equal(result.row.grid_name, null);
        assert.equal(result.row.location_lng, null);
        assert.equal(result.job.state, 'review');
        assert.match(result.job.reason, /同名/);
        result = await intake('grid-name-with-district', `事发地为伍家岗区${namedGrid.name}。`);
        assert.equal(result.row.admin_grid_code, namedGrid.code);
        assert.equal(result.row.address, null);
        assert.equal(result.row.community_name, null);
        assert.equal(result.row.location_lng, null);
        await addBoundary({ ...namedGrid, code: 'SYN-AREA-DUPLICATE' }, null);
        result = await intake('grid-name-district-ambiguous', `事发地为伍家岗区${namedGrid.name}。`);
        assert.equal(result.row.admin_grid_code, null);
        assert.match(result.job.reason, /同名/);
        await db('admin_grid').whereIn('code', [namedGrid.code, 'SYN-AREA-WEST', 'SYN-AREA-DUPLICATE']).del();
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

      await t.test('read-only detail keeps the jittered preview while original coordinates require location correction permission', async () => {
        const password = 'synthetic-coordinate-auth-123';
        const signIn = async role => {
          const username = 'coordinate-' + role;
          await db('app_user').insert({ user_id: username, username, real_name: '坐标权限测试', password_hash: hashSync(password, 4),
            roles: JSON.stringify([role]), permissions: '[]', status: 1, scope_rules: JSON.stringify([{ kind: 'all' }]), must_change_password: 0 });
          const login = await request(app).post('/api/v1/auth/login').send({ username, password }).expect(200);
          return `Bearer ${login.body.data.token}`;
        };
        const editor = await signIn('handler');
        const reader = await signIn('readonly');
        forwardLevel = '门牌号';
        const { row } = await intake('addr-coordinate-permission', `家住${road}。`);
        assert.equal(row.location_coordinate_system, 'WGS84');
        const { processComplaintLocationJitter } = require('../../src/services/complaintLocationJitterService');
        await processComplaintLocationJitter();
        const route = `/api/v1/complaints/${row.complaint_id}`;
        const read = async (token, suffix = '') => (await request(app).get(route + suffix).set('Authorization', token).expect(200)).body.data;
        const editorView = await read(editor);
        assert.equal(editorView.locationLng, Number(row.location_lng));
        assert.equal(editorView.locationLat, Number(row.location_lat));
        assert.equal(Number(editorView.effectiveFieldState.location_lng.value).toFixed(8), Number(row.location_lng).toFixed(8));

        const readerView = await read(reader);
        assert.equal(readerView.displayLocation?.coordinateSource, 'jitter');
        assert.deepEqual(readerView.displayLocation, editorView.displayLocation);
        assert.equal(readerView.locationLng, null);
        assert.equal(readerView.locationLat, null);
        assert.equal(readerView.effectiveFieldState.location_lng, undefined);
        assert.equal(readerView.effectiveFieldState.location_lat, undefined);
        assert.equal(readerView.effectiveAddress, editorView.effectiveAddress);

        const lngCorrection = responses => responses.find(item => item.fieldName === 'location_lng');
        assert.equal(Number(lngCorrection(await read(editor, '/corrections')).effectiveValue), Number(row.location_lng));
        const readerCorrection = lngCorrection(await read(reader, '/corrections'));
        assert.deepEqual([readerCorrection.effectiveValue, readerCorrection.oldValue, readerCorrection.newValue], [null, null, null]);
        const lngTimeline = response => response.content.find(item => item.detail?.field === 'location_lng');
        assert.equal(Number(lngTimeline(await read(editor, '/timeline')).detail.newValue).toFixed(8), Number(row.location_lng).toFixed(8));
        const readerChange = lngTimeline(await read(reader, '/timeline'));
        assert.equal(readerChange.detail.newValue, null);
        assert.equal(readerChange.summary, '经度已变更');
      });
    } finally {
      if (closePool) await closePool();
      if (mockMap) await new Promise(resolve => mockMap.close(resolve));
      if (db) { await db.destroy(); await admin.raw('drop database ??', [database]); }
      await admin.destroy();
    }
  });
