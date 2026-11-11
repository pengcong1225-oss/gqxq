// This is a declared compatibility contract, NOT verified canonical legacy DDL.
// Assert ALL referenced legacy structures before any DDL/data mutation. Never
// reconstruct service_grid/grid_enterprise or infer coverage from district text.
exports.up = async (db) => {
    const contracts = { service_grid: ['grid_code', 'grid_name', 'business_type', 'district_code'], grid_enterprise: ['grid_code', 'enterprise_code'], enterprise: ['enterprise_code', 'business_type', 'status', 'version'] };
    const specs = { admin_grid: { code: 'varchar(64)', name: 'varchar(128)', district_code: 'varchar(64)', version: 'bigint unsigned', geometry: 'json', coordinate_system: 'varchar(16)', geometry_source: 'varchar(500)' }, community: { code: 'varchar(64)', name: 'varchar(128)', admin_grid_code: 'varchar(64)', version: 'bigint unsigned' }, service_grid_revision: { grid_code: 'varchar(64)', version: 'bigint unsigned', valid_from: 'date', valid_to: 'date', snapshot: 'json', operator_id: 'varchar(64)', created_at: 'datetime' }, service_grid_admin: { grid_code: 'varchar(64)', version: 'bigint unsigned', admin_grid_code: 'varchar(64)' }, service_grid_community: { grid_code: 'varchar(64)', version: 'bigint unsigned', community_code: 'varchar(64)' } };
    // One declared nullability contract for both existing-table preflight and
    // creation. Every other declared extension column is required NOT NULL.
    const nullableColumns = new Set(['geometry', 'coordinate_system', 'geometry_source', 'valid_to']);
    const columns = async (table) => { const [r] = await db.raw('select column_name,data_type,character_maximum_length,is_nullable,column_default,extra,character_set_name,collation_name from information_schema.columns where table_schema=database() and table_name=?', [table]); return r; };
    for (const table of [...Object.keys(contracts), ...Object.keys(specs)])
        if (await db.schema.hasTable(table)) {
            const [r] = await db.raw('select engine from information_schema.tables where table_schema=database() and table_name=?', [table]);
            if (r[0]?.ENGINE !== 'InnoDB')
                throw Error('B3 requires transactional InnoDB table ' + table);
        }
    for (const [table, names] of Object.entries(contracts)) {
        if (!await db.schema.hasTable(table))
            throw Error('B3 requires declared legacy table ' + table);
        const cols = await columns(table);
        for (const name of names) {
            const c = cols.find(c => c.COLUMN_NAME === name);
            if (!c || !(name === 'version' ? ['bigint', 'int'].includes(c.DATA_TYPE) : ['varchar', 'char'].includes(c.DATA_TYPE)) || (name.endsWith('code') || name === 'business_type') && Number(c.CHARACTER_MAXIMUM_LENGTH) < 64 || name === 'grid_name' && Number(c.CHARACTER_MAXIMUM_LENGTH) < 64)
                throw Error('B3 incompatible declared ' + table + '.' + name);
        }
        if (table !== 'enterprise')
            for (const c of cols)
                if (!names.includes(c.COLUMN_NAME) && c.COLUMN_NAME !== 'version' && c.IS_NULLABLE === 'NO' && c.COLUMN_DEFAULT === null && !String(c.EXTRA).includes('auto_increment'))
                    throw Error('B3 unsupported mandatory legacy column ' + table + '.' + c.COLUMN_NAME);
    }
    if ((await columns('service_grid')).find(c => c.COLUMN_NAME === 'district_code')?.IS_NULLABLE !== 'YES')
        throw Error('B3 district_code must allow unknown coverage');
    const gridKey = (await columns('service_grid')).find(c => c.COLUMN_NAME === 'grid_code');
    const enterpriseKey = (await columns('enterprise')).find(c => c.COLUMN_NAME === 'enterprise_code');
    const relationCols = await columns('grid_enterprise');
    for (const [name, target] of [['grid_code', gridKey], ['enterprise_code', enterpriseKey]]) {
        const actual = relationCols.find(c => c.COLUMN_NAME === name);
        if (actual.COLLATION_NAME !== target.COLLATION_NAME || actual.CHARACTER_SET_NAME !== target.CHARACTER_SET_NAME)
            throw Error('B3 incompatible relationship collation grid_enterprise.' + name);
    }
    if (gridKey.CHARACTER_SET_NAME !== enterpriseKey.CHARACTER_SET_NAME || gridKey.COLLATION_NAME !== enterpriseKey.COLLATION_NAME || gridKey.CHARACTER_SET_NAME !== 'utf8mb4' || !/^utf8mb4_[a-z0-9_]+$/.test(gridKey.COLLATION_NAME))
        throw Error('B3 requires matching declared utf8mb4 stable-key collations');
    const unique = async (table, expected) => {
        const [rows] = await db.raw('show index from ??', [table]);
        const columns = expected.split(',');
        return [...new Set(rows.map(r => r.Key_name))].some(name => {
            const parts = rows.filter(r => r.Key_name === name).sort((a, b) => a.Seq_in_index - b.Seq_in_index);
            return parts.length === columns.length && parts.every((r, i) => Number(r.Non_unique) === 0 && r.Column_name === columns[i] && r.Sub_part == null && r.Expression == null);
        });
    };
    if (!await unique('service_grid', 'grid_code'))
        throw Error('B3 requires unique service_grid.grid_code');
    if (!await unique('grid_enterprise', 'grid_code,enterprise_code'))
        throw Error('B3 requires unique grid_enterprise(grid_code,enterprise_code)');
    const [bad] = await db.raw('select ge.grid_code from grid_enterprise ge left join service_grid g on g.grid_code=ge.grid_code left join enterprise e on e.enterprise_code=ge.enterprise_code where g.grid_code is null or e.enterprise_code is null or not (g.business_type <=> e.business_type) union select grid_code from grid_enterprise group by grid_code having count(*)>1');
    if (bad.length)
        throw Error('B3 legacy relationship ownership/type requires explicit reconciliation');
    for (const [table, spec] of Object.entries(specs))
        if (await db.schema.hasTable(table)) {
            const cols = await columns(table);
            for (const [name, type] of Object.entries(spec)) {
                const c = cols.find(c => c.COLUMN_NAME === name);
                const length = type.match(/varchar\((\d+)\)/)?.[1];
                if (!c || c.DATA_TYPE !== type.split(/[ (]/)[0] || c.IS_NULLABLE !== (nullableColumns.has(name) ? 'YES' : 'NO') || length && Number(c.CHARACTER_MAXIMUM_LENGTH) < Number(length) || length && c.COLLATION_NAME !== gridKey.COLLATION_NAME)
                    throw Error('B3 incompatible extension ' + table + '.' + name);
            }
            for (const c of cols)
                if (!Object.hasOwn(spec, c.COLUMN_NAME) && c.IS_NULLABLE === 'NO' && c.COLUMN_DEFAULT === null && !String(c.EXTRA).includes('auto_increment'))
                    throw Error('B3 unsupported mandatory extension column ' + table + '.' + c.COLUMN_NAME);
            const pk = table === 'service_grid_revision' ? 'grid_code,version' : table === 'service_grid_admin' ? 'grid_code,version,admin_grid_code' : table === 'service_grid_community' ? 'grid_code,version,community_code' : 'code';
            if (!await unique(table, pk))
                throw Error('B3 incompatible stable extension key ' + table);
        }
    if (await db.schema.hasColumn('service_grid', 'version')) {
        const c = (await columns('service_grid')).find(c => c.COLUMN_NAME === 'version');
        if (!['bigint', 'int'].includes(c.DATA_TYPE) || c.IS_NULLABLE !== 'NO')
            throw Error('B3 incompatible service_grid.version');
    }
    else
        await db.raw('alter table service_grid add column version bigint unsigned not null default 0');
    for (const [table, spec] of Object.entries(specs))
        if (!await db.schema.hasTable(table)) {
            const defs = Object.entries(spec).map(([name, type]) => name + ' ' + type + (nullableColumns.has(name) ? ' null' : ' not null'));
            const pk = table === 'service_grid_revision' ? 'grid_code,version' : table === 'service_grid_admin' ? 'grid_code,version,admin_grid_code' : table === 'service_grid_community' ? 'grid_code,version,community_code' : 'code';
            await db.raw('create table ' + table + '(' + defs.join(',') + ',primary key(' + pk + ')) engine=InnoDB default charset=utf8mb4 collate=' + gridKey.COLLATION_NAME);
        }
};
exports.down = async () => { throw Error('B3 coverage history requires evidence-preserving restoration'); };
