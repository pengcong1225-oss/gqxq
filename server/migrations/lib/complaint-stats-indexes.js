const ALTER_COMPLAINT = 'alter table complaint ';
const COVER_COLUMNS = [
  'source_reported_at', 'business_type', 'minor_category_code', 'major_category_code', 'admin_grid_code',
];
const DISTRICT_COLUMNS = ['source_reported_at', 'business_type', 'district_code'];
const FILTER_COLUMNS = ['deleted', 'source_system'];

function matchesIndex(rows, columns) {
  return rows.length === columns.length && rows.every((row, position) =>
    row.columnName === columns[position] && row.indexType === 'BTREE' &&
    Number(row.nonUnique) === 1 && row.visible === 'YES' &&
    row.direction === 'A' && row.prefixLength === null
  );
}

async function updateComplaintStatsIndexes(db, indexes) {
  const [rows] = await db.raw(`
    select index_name as name, column_name as columnName, index_type as indexType,
           non_unique as nonUnique, is_visible as visible, collation as direction, sub_part as prefixLength
    from information_schema.statistics
    where table_schema = database() and table_name = 'complaint'
    order by seq_in_index
  `);
  const changes = [];
  const bindings = [];

  for (const { name, before, after, replacement } of indexes) {
    const current = rows.filter(row => row.name === name);
    if (matchesIndex(current, after)) continue;
    if (current.length === 0) {
      // The historical migration could fail after removing the old index.
      changes.push('add index ?? (??)');
      bindings.push(name, after);
    } else {
      if (!matchesIndex(current, before)) {
        throw new Error(`Incompatible complaint index definition: ${name}`);
      }
      changes.push(replacement.slice(ALTER_COMPLAINT.length));
    }
  }

  // Both replacements in the first migration share one atomic InnoDB DDL statement.
  if (changes.length > 0) {
    await db.raw(ALTER_COMPLAINT + changes.join(', ') + ', algorithm=inplace, lock=none', bindings);
  }
}

module.exports = { COVER_COLUMNS, DISTRICT_COLUMNS, FILTER_COLUMNS, updateComplaintStatsIndexes };
