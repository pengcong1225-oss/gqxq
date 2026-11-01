// Knex-created snapshot keys can inherit a different collation from legacy
// dispatch_order keys. Align only their join keys, preserving payload bytes.
exports.up = async db => {
  const columns = async table => (await db.raw(
    'select column_name as name,column_type as type,is_nullable as nullable,' +
    'column_default as defaultValue,extra as extra,character_set_name as charset,collation_name as collation' +
    ' from information_schema.columns where table_schema=database() and table_name=?', [table]
  ))[0];
  const order = await columns('dispatch_order');
  const snapshot = await columns('dispatch_push_snapshot');
  for (const name of ['assignment_id', 'request_id']) {
    const target = order.find(c => c.name === name);
    const current = snapshot.find(c => c.name === name);
    if (!target || !current || target.charset !== 'utf8mb4' || current.charset !== 'utf8mb4' ||
        !/^utf8mb4_[a-z0-9_]+$/.test(target.collation) || !/^varchar\([0-9]+\)$/.test(current.type) ||
        current.extra || current.defaultValue != null) throw Error('Unsupported dispatch snapshot key metadata: ' + name);
    if (current.collation === target.collation) continue;
    await db.raw('alter table dispatch_push_snapshot modify column ?? ' + current.type +
      ' character set utf8mb4 collate ' + target.collation + (current.nullable === 'YES' ? ' null' : ' not null'), [name]);
  }
};
exports.down = async () => { throw Error('Restore key collation only from verified schema evidence'); };
