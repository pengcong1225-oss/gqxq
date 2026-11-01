import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import knexFactory from 'knex';

const require = createRequire(import.meta.url);
const database = process.env.GQXQ_ANALYSIS_WORKFLOW_DB ?? 'gqxq_analysis_workflow_test';

// Synthetic component schema only. Never run against the application database.
test('final reporting result -> correction -> analysis and report todo', {
  skip: process.env.GQXQ_ANALYSIS_WORKFLOW_DB !== database,
}, async t => {
  assert.equal(process.env.GQXQ_DB_HOST, '127.0.0.1');
  assert.equal(process.env.GQXQ_DB_PORT, '3306');
  assert.equal(process.env.GQXQ_DB_NAME, database);
  assert.match(database, /^gqxq_analysis_workflow(?:_[0-9_]+)?_test$/);
  const db = knexFactory({client:'mysql2', connection:{host:'127.0.0.1', port:3306,
    user:process.env.GQXQ_DB_USER, password:process.env.GQXQ_DB_PASSWORD, database}});
  let close: (() => Promise<void>) | undefined;
  try {
    const [identity] = await db.raw('select database() as name');
    assert.equal(identity[0].name, database);
    for (const table of ['report_todo','analysis_record','correction_item','approval_trace',
      'business_event','dispatch_request_log','dispatch_push_snapshot','dispatch_order',
      'operation_audit_log','complaint_field_version','complaint']) await db.schema.dropTableIfExists(table);
    await db.raw(`create table complaint (
      id bigint auto_increment primary key, complaint_id varchar(64) unique, complaint_no varchar(64),
      deleted tinyint default 0, title varchar(255), content text, enterprise_code varchar(64),
      source_status varchar(64) default 'source_completed', closed_in_system tinyint default 0,
      source_id varchar(64), source_system varchar(64), source_event_status varchar(64) default 'completed', source_synced_at datetime,
      closed_at datetime, closed_by varchar(64), closed_by_name varchar(64), closed_basis varchar(500),
      enterprise_name varchar(128), district_code varchar(64), district_name varchar(128), address text,
      business_type varchar(32), complaint_type varchar(32), location_lng decimal(12,6), location_lat decimal(12,6),
      reporting_status varchar(32), supervision_status varchar(32), analysis_included tinyint default 0, correction_status varchar(32) default 'pending',
      major_category_code varchar(64), minor_category_code varchar(64), category_dictionary_version varchar(64),
      edit_version bigint default 1, effective_field_state json, urgency_level varchar(32), is_sensitive tinyint,
      sensitive_keywords text, rule_confidence decimal(8,2), rule_version varchar(64),
      source_reported_at datetime, received_at datetime, updated_at datetime,
      admin_grid_code varchar(64), community_code varchar(64), location_coordinate_system varchar(32),
      location_coordinate_source varchar(255)) engine=InnoDB default charset=utf8mb4`);
    await db.raw(`create table dispatch_order (id bigint auto_increment primary key,
      assignment_id varchar(64) unique, complaint_id varchar(64), status varchar(32),
      reporting_task_id varchar(128), target_enterprise_code varchar(64), request_id varchar(128),
      last_event_sequence bigint default 0, reporting_item_id varchar(64), updated_at datetime) engine=InnoDB`);
    await db.raw('create table dispatch_push_snapshot (assignment_id varchar(128) primary key, request_id varchar(128) not null, body longtext) engine=InnoDB default charset=utf8mb4 collate=utf8mb4_unicode_ci');
    await t.test('snapshot key migration fixes mixed-collation joins without rewriting signed payload bytes', async () => {
      const body=' { "signed": "原始字节" }\n';
      await db('dispatch_push_snapshot').insert({assignment_id:'COLLATION-PROBE',request_id:'REQUEST-PROBE',body});
      const migration=require('../migrations/20261018090000__dispatch_snapshot_key_collation.js');
      await migration.up(db); await migration.up(db);
      await db.raw('select d.assignment_id from dispatch_order d left join dispatch_push_snapshot s on s.assignment_id=d.assignment_id');
      assert.equal((await db('dispatch_push_snapshot').where({assignment_id:'COLLATION-PROBE'}).first()).body,body);
    });
    await db.raw('create table complaint_field_version (id bigint auto_increment primary key, complaint_id varchar(64), field_name varchar(64), new_value text, change_source varchar(32)) engine=InnoDB');
    await db.raw(`create table operation_audit_log (id bigint auto_increment primary key,
      audit_id varchar(64), user_id varchar(64), app_code varchar(64), resource_code varchar(128),
      action varchar(64), biz_type varchar(64), biz_id varchar(128), result varchar(32),
      client_ip varchar(64), detail json, created_at datetime) engine=InnoDB default charset=utf8mb4`);
    await require('../migrations/20260917100700__m7_g3_g4_integration.js').up(db);
    await require('../migrations/20260917100800__m8_g5_correction_analysis_report.js').up(db);
    await db.schema.alterTable('analysis_record', table => {
      table.integer('statistics_snapshot_version').nullable(); table.json('statistics_snapshot').nullable();
    });
    const {pool} = await import('../src/db/pool'); close = () => pool.end();
    const {withTransaction} = await import('../src/db/tx');
    const {runAsTrustedSystem} = await import('../src/auth/accessScope');
    const service = await import('../src/services/correctionService');
    const {CORRECTION_STATUS_SQL,ANALYSIS_INCLUDED_SQL} = await import('../src/repositories/complaintRepo');
    const {closeComplaint} = await import('../src/services/closureService');
    const {handleCallback} = await import('../src/services/callbackService');
    const {signCallback} = await import('../src/clients/callbackSignature');
    const {env} = await import('../src/config/env');
    Object.assign(env.callback, {keyId:'workflow-key', keyVersion:'v1', secret:'synthetic-workflow-secret', ackMode:'BODY', ackValue:'OK\n'});
    const actor = {userId:'reviewer', userName:'合成核验员', clientIp:null};
    const now = () => new Date();
    const seed = async (id: string, status = 'processing', withOrder = true) => {
      await db('complaint').insert({complaint_id:id, complaint_no:id, title:'合成诉求',
        enterprise_code:'E1', business_type:'water', complaint_type:'complaint',
        reporting_status:status === 'completed' ? 'approved':'processing', supervision_status:status,
        effective_field_state:'{}', received_at:now()});
      if (withOrder) await db('dispatch_order').insert({assignment_id:'A-'+id, complaint_id:id,
        status, reporting_task_id:'T-'+id, target_enterprise_code:'E1', request_id:'R-'+id});
      await db('correction_item').insert({correction_id:'C-'+id, complaint_id:id,
        assignment_id:withOrder?'A-'+id:null, field_name:'disposal_result', field_label:'企业处置结果',
        status:'confirmed', old_value:'原始结果', new_value:'人工核验结果', confirmed_at:now(), created_at:now()});
    };
    const event = (id:string, overrides:Record<string,unknown> = {}) => ({
      event_id:'EV-'+id, event_type:'task_approved', source_app_code:'gqxq', source_business_id:id,
      task_id:'T-'+id, subject_code:'E1', approval_conclusion:'agreed', processed_result:'applied',
      payload:JSON.stringify({enterpriseDisposalResult:'原始结果'}), received_at:now(), ...overrides,
    });
    const finalEvent = async (id:string, overrides:Record<string,unknown> = {}) => {
      const row = event(id, overrides);
      await db('business_event').insert(row);
      await db('approval_trace').insert({trace_id:'TRACE-'+row.event_id, complaint_id:id,
        assignment_id:'A-'+id, task_id:'T-'+id, event_id:row.event_id, event_type:'task_approved',
        approval_conclusion:'agreed', occurred_at:now(), created_at:now()});
    };
    const enter = (id:string) => runAsTrustedSystem(() => withTransaction(tx => service.maybeEnterAnalysis(tx,
      {complaintId:id, operatorId:actor.userId, operatorName:actor.userName, now:now()})));
    const noArtifacts = async (id:string) => {
      assert.equal((await db('analysis_record').where({complaint_id:id})).length, 0);
      assert.equal((await db('report_todo').where({complaint_id:id})).length, 0);
    };
    const closeCase = (id:string, basis = '人工核对完成') => runAsTrustedSystem(() => closeComplaint(id,{basis},actor));
    await t.test('manual closure requires approval, completed corrections and an explicit basis', async () => {
      await seed('CLOSE-EARLY');
      await assert.rejects(closeCase('CLOSE-EARLY'), /审批/);
      await seed('CLOSE-PENDING','completed'); await finalEvent('CLOSE-PENDING');
      await db('correction_item').where({complaint_id:'CLOSE-PENDING'}).update({status:'pending'});
      await assert.rejects(closeCase('CLOSE-PENDING'), /纠偏/);
      await assert.rejects(closeCase('CLOSE-PENDING','  '), /必填/);
      assert.equal((await db('operation_audit_log').where({action:'COMPLAINT_CLOSE'})).length,0);
    });
    await t.test('old approval cannot permit manual closure of a new pending dispatch round', async () => {
      await seed('CLOSE-ROUND','completed'); await finalEvent('CLOSE-ROUND');
      await db('dispatch_order').insert({assignment_id:'NEW-CLOSE-ROUND',complaint_id:'CLOSE-ROUND',
        status:'pending',target_enterprise_code:'E1',request_id:'NEW-CLOSE-REQUEST'});
      await assert.rejects(closeCase('CLOSE-ROUND'), /最新交办|本轮|审批/);
      assert.equal((await db('complaint').where({complaint_id:'CLOSE-ROUND'}).first()).closed_in_system,0);
    });
    await t.test('manual closure rejects missing final evidence and stale result review', async () => {
      await seed('CLOSE-NO-EVENT','completed');
      await assert.rejects(closeCase('CLOSE-NO-EVENT'), /最终审批|最新交办/);
      await seed('CLOSE-STALE','completed'); await finalEvent('CLOSE-STALE');
      await db('correction_item').where({complaint_id:'CLOSE-STALE'}).update({assignment_id:null});
      await assert.rejects(closeCase('CLOSE-STALE'), /本轮|纠偏/);
    });
    await t.test('concurrent manual closure writes one audit and preserves source state and analysis', async () => {
      await seed('CLOSE-VALID','completed'); await finalEvent('CLOSE-VALID');
      assert.equal((await enter('CLOSE-VALID')).entered,true);
      assert.equal((await db('complaint').where({complaint_id:'CLOSE-VALID'}).first()).closed_in_system,0);
      const outcomes=await Promise.allSettled([closeCase('CLOSE-VALID'),closeCase('CLOSE-VALID')]);
      assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
      assert.equal(outcomes.filter(x=>x.status==='rejected').length,1);
      const row=await db('complaint').where({complaint_id:'CLOSE-VALID'}).first();
      assert.equal(row.closed_in_system,1); assert.equal(row.closed_by,actor.userId);
      assert.equal(row.closed_by_name,actor.userName); assert.equal(row.closed_basis,'人工核对完成');
      assert.ok(row.closed_at); assert.equal(row.source_status,'source_completed');
      assert.equal(row.source_event_status,'completed');
      assert.equal(row.reporting_status,'approved'); assert.equal(row.supervision_status,'completed');
      assert.equal((await db('operation_audit_log').where({action:'COMPLAINT_CLOSE',biz_id:'CLOSE-VALID'})).length,1);
      assert.equal((await db('analysis_record').where({complaint_id:'CLOSE-VALID'})).length,1);
      assert.equal((await db('report_todo').where({complaint_id:'CLOSE-VALID'})).length,1);
    });
    await t.test('no-dispatch complaints stay out of the analysis dataset', async () => {
      await seed('NO', 'processing', false);
      assert.equal((await enter('NO')).entered, false); await noArtifacts('NO');
    });
    await t.test('finishing corrections before the final callback cannot admit a complaint', async () => {
      await seed('EARLY');
      assert.equal((await enter('EARLY')).entered, false); await noArtifacts('EARLY');
    });
    await t.test('completed status alone is not proof of an applied final result', async () => {
      await seed('STATUS', 'completed');
      assert.equal((await enter('STATUS')).entered, false); await noArtifacts('STATUS');
    });
    await t.test('ignored, foreign-task and foreign-enterprise events cannot provide final evidence', async () => {
      for (const [suffix, overrides] of [
        ['IGNORED',{processed_result:'ignored'}], ['TASK',{task_id:'OTHER'}],
        ['ENTERPRISE',{subject_code:'OTHER'}], ['CASE',{source_business_id:'OTHER'}],
      ] as const) {
        await seed(suffix, 'completed'); await finalEvent(suffix, overrides);
        assert.equal((await enter(suffix)).entered, false, suffix); await noArtifacts(suffix);
      }
    });
    await t.test('an older approved round cannot release a newer pending round', async () => {
      await seed('ROUND', 'completed'); await finalEvent('ROUND');
      await db('dispatch_order').insert({assignment_id:'NEW-ROUND', complaint_id:'ROUND', status:'pushed',
        reporting_task_id:'NEW-TASK', target_enterprise_code:'E1', request_id:'NEW-REQUEST'});
      assert.equal((await enter('ROUND')).entered, false); await noArtifacts('ROUND');
    });
    await t.test('analysis stores the human-reviewed result, not a later ignored or old-round payload', async () => {
      await seed('VALID', 'completed'); await finalEvent('VALID');
      await db('business_event').insert(event('VALID', {event_id:'LATE-VALID', task_id:'OLD-TASK',
        processed_result:'ignored', payload:JSON.stringify({enterpriseDisposalResult:'错误旧轮次结果'})}));
      assert.equal((await enter('VALID')).entered, true);
      const row = await db('analysis_record').where({complaint_id:'VALID'}).first();
      assert.equal(row.disposal_result, '人工核验结果');
      assert.equal(row.assignment_id, 'A-VALID');
      assert.equal((await enter('VALID')).entered, false);
      assert.equal((await db('report_todo').where({complaint_id:'VALID'})).length, 1);
    });
    await t.test('legacy final results can reopen only stale result review through regeneration', async () => {
      await seed('LEGACY', 'completed'); await finalEvent('LEGACY');
      await db('correction_item').where({complaint_id:'LEGACY'}).update({assignment_id:null,old_value:null});
      await db('correction_item').insert({correction_id:'KEEP-LEGACY',complaint_id:'LEGACY',
        field_name:'address',field_label:'地址',status:'confirmed',new_value:'已核验地址',created_at:now()});
      assert.equal((await enter('LEGACY')).entered,false);
      await runAsTrustedSystem(() => service.generateCorrections('LEGACY',actor));
      const result = await db('correction_item').where({correction_id:'C-LEGACY'}).first();
      assert.equal(result.status,'pending'); assert.equal(result.assignment_id,'A-LEGACY');
      assert.equal(result.old_value,'原始结果'); assert.equal(result.new_value,null);
      const kept = await db('correction_item').where({correction_id:'KEEP-LEGACY'}).first();
      assert.equal(kept.status,'confirmed'); assert.equal(kept.new_value,'已核验地址');
      const version = Number((await db('complaint').where({complaint_id:'LEGACY'}).first()).edit_version);
      assert.ok(version>1); await noArtifacts('LEGACY');
      const reviewed = await runAsTrustedSystem(() => service.rejectCorrection('C-LEGACY',
        {expectedVersion:version,basis:'回传准确，无需纠偏'},actor));
      assert.equal(reviewed.analysisEntered,true);
      assert.equal((await db('analysis_record').where({complaint_id:'LEGACY'}).first()).disposal_result,'原始结果');
      await runAsTrustedSystem(() => service.generateCorrections('LEGACY',actor));
      assert.equal((await db('correction_item').where({correction_id:'C-LEGACY'}).first()).status,'rejected');
    });
    await t.test('final evidence reading does not scan a concurrently ingested late callback', async () => {
      await seed('CONCURRENT','completed'); await finalEvent('CONCURRENT');
      const late = await pool.getConnection(); const review = await pool.getConnection();
      try {
        await late.beginTransaction();
        await late.query('insert into business_event set ?',[event('CONCURRENT',
          {event_id:'LATE-CONCURRENT',processed_result:'pending'})]);
        await review.query('set session innodb_lock_wait_timeout = 1');
        await review.beginTransaction();
        const outcome = await runAsTrustedSystem(() => service.maybeEnterAnalysis(review,
          {complaintId:'CONCURRENT',operatorId:actor.userId,operatorName:actor.userName,now:now()}));
        assert.equal(outcome.entered,true);
        await review.commit();
      } finally {
        await late.rollback(); await review.rollback();
        await review.query('set session innodb_lock_wait_timeout = 50');
        late.release(); review.release();
      }
    });
    await t.test('v2 final evidence binds assignment and request identity', async () => {
      for (const suffix of ['V2-VALID','V2-ASSIGNMENT','V2-REQUEST']) {
        await seed(suffix,'completed');
        await finalEvent(suffix,{payload:JSON.stringify({contractVersion:2,
          assignmentId:suffix==='V2-ASSIGNMENT'?'OTHER':'A-'+suffix,
          requestId:suffix==='V2-REQUEST'?'OTHER':'R-'+suffix,enterpriseDisposalResult:'原始结果'})});
        assert.equal((await enter(suffix)).entered,suffix==='V2-VALID');
        if(suffix!=='V2-VALID') await noArtifacts(suffix);
      }
    });
    await t.test('a final callback reopens result review, invalidates stale edits and creates no report yet', async () => {
      await seed('CALLBACK');
      await db('correction_item').insert({correction_id:'KEEP-CALLBACK',complaint_id:'CALLBACK',
        field_name:'summary',field_label:'诉求摘要',status:'confirmed',new_value:'已核验摘要',created_at:now()});
      const payload = {eventId:'EV-CALLBACK', eventType:'TASK_APPROVED', sourceAppCode:'gqxq',
        sourceBusinessId:'CALLBACK', taskId:'T-CALLBACK', sceneCode:'GQXQ_SENSITIVE_DISPATCH',
        enterpriseSubject:{subjectCode:'E1',subjectName:'合成企业'}, approvalConclusion:'AGREED',
        enterpriseDisposalResult:{result:'最终回传内容'}, attachments:[], occurredAt:now().toISOString(), templateVersion:1};
      const rawBody = Buffer.from(JSON.stringify(payload));
      const timestamp = String(Math.floor(Date.now()/1000));
      const request = {rawBody, keyId:'workflow-key',keyVersion:'v1',timestamp,headerEventId:payload.eventId,
        signature:signCallback(env.callback.secret,Number(timestamp),rawBody),remoteIp:null};
      assert.equal((await runAsTrustedSystem(() => handleCallback(request))).status, 200);
      const correction = await db('correction_item').where({correction_id:'C-CALLBACK'}).first();
      assert.equal(correction.status, 'pending');
      assert.deepEqual(JSON.parse(correction.old_value), {result:'最终回传内容'});
      assert.equal(correction.new_value, null);
      const preserved = await db('correction_item').where({correction_id:'KEEP-CALLBACK'}).first();
      assert.equal(preserved.status,'confirmed'); assert.equal(preserved.new_value,'已核验摘要');
      const complaint = await db('complaint').where({complaint_id:'CALLBACK'}).first();
      assert.ok(Number(complaint.edit_version)>1);
      await noArtifacts('CALLBACK');
      await assert.rejects(runAsTrustedSystem(() => service.confirmCorrection('C-CALLBACK',
        {expectedVersion:1,newValue:'旧窗口结果'},actor)), /修改|版本/);
      const decision = await runAsTrustedSystem(() => service.confirmCorrection('C-CALLBACK',
        {expectedVersion:Number(complaint.edit_version),newValue:'核验后的最终结果',basis:'已核对回传'},actor));
      assert.equal(decision.analysisEntered, true);
      assert.equal((await db('analysis_record').where({complaint_id:'CALLBACK'}).first()).disposal_result,'核验后的最终结果');
      assert.equal((await runAsTrustedSystem(() => handleCallback(request))).status, 200);
      assert.equal((await db('correction_item').where({correction_id:'C-CALLBACK'}).first()).status,'confirmed');
      assert.equal((await db('analysis_record').where({complaint_id:'CALLBACK'})).length,1);
      assert.equal((await db('report_todo').where({complaint_id:'CALLBACK'})).length,1);
      // Existing summary flags deliberately remain stale: reads must reflect the
      // actual workflow without asking the user to repeat completed operations.
      const [projection]=await db.raw('select '+CORRECTION_STATUS_SQL+' as correctionStatus,'+ANALYSIS_INCLUDED_SQL+' as analysisIncluded from complaint c where complaint_id=?',['CALLBACK']);
      assert.equal(projection[0].correctionStatus,'corrected');
      assert.equal(Number(projection[0].analysisIncluded),1);
      const [pendingProjection]=await db.raw('select '+CORRECTION_STATUS_SQL+' as correctionStatus,'+ANALYSIS_INCLUDED_SQL+' as analysisIncluded from complaint c where complaint_id=?',['EARLY']);
      assert.equal(pendingProjection[0].correctionStatus,'corrected');
      assert.equal(Number(pendingProjection[0].analysisIncluded),0);
    });
  } finally { if(close) await close(); await db.destroy(); }
});
