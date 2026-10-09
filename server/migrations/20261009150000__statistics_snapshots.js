// D1 additive entry facts. Old records deliberately remain without a snapshot.
exports.up=async db=>{
 for(const table of ['analysis_record','platform_permission','platform_role','platform_role_permission','platform_authorization_state']){
  const [r]=await db.raw('select ENGINE from information_schema.tables where table_schema=database() and table_name=?',[table]);if(r[0]?.ENGINE!=='InnoDB')throw Error('D1 requires existing InnoDB '+table);
 }
 for(const c of ['complaint_id','analysis_id','confirmed_at'])if(!await db.schema.hasColumn('analysis_record',c))throw Error('D1 requires analysis_record.'+c);
 // Preflight ALL owned additions before the first DDL, including rerun conflicts.
 const additions=[['analysis_record','statistics_snapshot_version','int unsigned null','int'],['analysis_record','statistics_snapshot','json null','json'],['platform_authorization_state','statistics_d1_seeded','tinyint not null default 0','tinyint']];
 for(const [table,column,,type] of additions){const [r]=await db.raw('select DATA_TYPE,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT from information_schema.columns where table_schema=database() and table_name=? and column_name=?',[table,column]);if(r.length&&(r[0].DATA_TYPE!==type||r[0].IS_NULLABLE!==(column==='statistics_d1_seeded'?'NO':'YES')||column==='statistics_snapshot_version'&&!r[0].COLUMN_TYPE.includes('unsigned')||column==='statistics_d1_seeded'&&String(r[0].COLUMN_DEFAULT)!=='0'))throw Error('D1 incompatible '+table+'.'+column);}
 const [indexes]=await db.raw('show index from analysis_record');const groups=new Map();for(const row of indexes){if(Number(row.Non_unique)===0){const g=groups.get(row.Key_name)||[];g.push(row);groups.set(row.Key_name,g);}}
 if(![...groups.values()].some(g=>g.length===1&&g[0].Column_name==='complaint_id'&&g[0].Sub_part===null))throw Error('D1 requires full unique analysis complaint identity');
 for(const [table,column,ddl] of additions)if(!await db.schema.hasColumn(table,column))await db.raw('alter table ?? add column ?? '+ddl,[table,column]);
 await db.transaction(async tx=>{
  const state=await tx('platform_authorization_state').where('id',1).forUpdate().first();if(!state)throw Error('D1 requires A5 authorization singleton');
  await tx('platform_permission').insert({permission_code:'statistics.read',name:'候选统计查询（另需数据集与明细权限）'}).onConflict('permission_code').ignore();
  if(Number(state.statistics_d1_seeded)!==0)return;
  const eligible=await tx('platform_role as r').join('platform_role_permission as p','p.role_code','r.role_code').where('r.built_in',1).whereIn('p.permission_code',['dashboard.read','analysis.read']).distinct('r.role_code');
  for(const r of eligible){await tx('platform_role_permission').insert({role_code:r.role_code,permission_code:'statistics.read'}).onConflict(['role_code','permission_code']).ignore();await tx('platform_role').where('role_code',r.role_code).increment('version',1);}
  await tx('platform_authorization_state').where('id',1).update({statistics_d1_seeded:1,version:Number(state.version)+1});
 });
};
exports.down=async()=>{throw Error('D1 historical statistics rollback requires evidence-preserving restoration');};
