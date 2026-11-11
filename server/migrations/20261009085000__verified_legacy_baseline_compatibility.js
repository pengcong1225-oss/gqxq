// Verified against the deployed M13 baseline (2026-10-12). Preserve legacy keys,
// rows and unknown grid ownership; only add missing capacity needed by B3/D3.
exports.up = async db => {
  const plans = [];
  for (const table of ['service_grid', 'grid_enterprise', 'enterprise', 'report_record']) {
    const [engine] = await db.raw('select ENGINE from information_schema.tables where table_schema=database() and table_name=?', [table]);
    if (engine[0]?.ENGINE !== 'InnoDB') throw Error('Legacy compatibility requires InnoDB ' + table);
  }
  const columns = async table => (await db.raw('show full columns from ??', [table]))[0];
  const grid = await columns('service_grid');
  if (!grid.some(c => c.Field === 'business_type')) {
    const [relations] = await db.raw('select count(*) as n from grid_enterprise');
    if (Number(relations[0].n) !== 0) throw Error('Legacy grids without business type require explicit relationship reconciliation');
    plans.push('alter table service_grid add column business_type varchar(64) null');
  }
  const enterprise = (await columns('enterprise')).find(c => c.Field === 'business_type');
  if (enterprise?.Type === 'varchar(32)' && enterprise.Null === 'NO' && enterprise.Default == null && !enterprise.Extra) {
    plans.push('alter table enterprise modify column business_type varchar(64) not null');
  } else if (enterprise?.Type !== 'varchar(64)') {
    throw Error('Unsupported legacy enterprise.business_type');
  }
  const reports = await columns('report_record');
  const template = reports.find(c => c.Field === 'template_version');
  if (template?.Type === 'varchar(32)' && template.Null === 'YES' && template.Default === 'V1' && !template.Extra) {
    plans.push("alter table report_record modify column template_version varchar(64) null default 'V1'");
  } else if (template?.Type !== 'varchar(64)') {
    throw Error('Unsupported legacy report_record.template_version');
  }
  // Also supports an environment that already ran the old D3 migration against
  // its minimal declared schema: a new forward migration must add these fields.
  for (const [name, type] of [['report_id', 'varchar(64)'], ['report_type', 'varchar(32)']]) {
    const c = reports.find(c => c.Field === name);
    if (!c) plans.push('alter table report_record add column ' + name + ' ' + type + ' null');
    else if (c.Type !== type || /GENERATED|auto_increment/i.test(c.Extra)) throw Error('Unsupported legacy report_record.' + name);
  }
  for (const sql of plans) await db.raw(sql);
};
exports.down = async () => { throw Error('Legacy capacity changes require evidence-preserving restoration'); };
