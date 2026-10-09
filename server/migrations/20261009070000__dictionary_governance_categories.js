// Additive migration. No legacy complaint nature -> category mapping or correction generation.
exports.up = async (db) => {
    for (const [table, columns] of Object.entries({ dict_type: ['dict_type', 'dict_name', 'status'], dict_item: ['item_id', 'dict_type', 'item_value', 'item_label', 'status'] })) {
        for (const column of columns)
            if (!(await db.schema.hasColumn(table, column)))
                throw Error('B1 requires verified base column ' + table + '.' + column);
    }
    const stableKeys = [];
    for (const [table, name, expected] of [['dict_type', 'uk_b1_dictionary_type', ['dict_type']], ['dict_item', 'uk_b1_dictionary_item', ['dict_type', 'item_value']]]) {
        const [indexes] = await db.raw('show index from ??', [table]);
        const valid = parts => parts.length === expected.length && parts.sort((a, b) => a.Seq_in_index - b.Seq_in_index).every((r, i) => Number(r.Non_unique) === 0 && r.Column_name === expected[i] && r.Sub_part == null && r.Expression == null);
        const named = indexes.filter(r => r.Key_name === name);
        if (named.length && !valid(named))
            throw Error('B1 incompatible stable identity key ' + table + '.' + name);
        const exists = [...new Set(indexes.map(r => r.Key_name))].some(key => valid(indexes.filter(r => r.Key_name === key)));
        if (!exists)
            stableKeys.push({ table, name, columns: expected.join(',') });
    }
    const [duplicateTypes] = await db.raw('select dict_type from dict_type group by dict_type having count(*) > 1');
    const [duplicateItems] = await db.raw('select dict_type,item_value from dict_item group by dict_type,item_value having count(*) > 1');
    if (duplicateTypes.length || duplicateItems.length)
        throw Error('B1 duplicate dictionary stable keys require explicit reconciliation');
    for (const [table, columns] of Object.entries({ dict_type: [['version', 'bigint unsigned not null default 1'], ['published', 'tinyint not null default 1']], dict_item: [['version', 'bigint unsigned not null default 1'], ['published', 'tinyint not null default 1'], ['parent_code', 'varchar(64) null'], ['sort_order', 'int not null default 0']] }))
        for (const [name, definition] of columns)
            if (!(await db.schema.hasColumn(table, name)))
                await db.raw('alter table ?? add column ?? ' + definition, [table, name]);
    for (const { table, name, columns } of stableKeys)
        await db.raw('alter table ?? add unique index ?? (' + columns + ')', [table, name]);
    if (!(await db.schema.hasTable('dictionary_code_registry')))
        await db.raw('create table dictionary_code_registry (type_code varchar(64) not null,item_code varchar(64) not null,primary key(type_code,item_code)) engine=InnoDB default charset=utf8mb4');
    if (!(await db.schema.hasTable('dictionary_version')))
        await db.raw('create table dictionary_version (type_code varchar(64) not null,version bigint unsigned not null,snapshot json not null,created_at datetime not null,primary key(type_code,version)) engine=InnoDB default charset=utf8mb4');
    await db.raw("insert ignore into dictionary_code_registry select dict_type,'' from dict_type");
    await db.raw("insert ignore into dictionary_code_registry select dict_type,item_value from dict_item where dict_type <> 'sensitive_word'");
    await db.raw("insert ignore into dictionary_code_registry values ('complaint_category','')");
    await db.raw("insert into dict_type (dict_type,dict_name,status,version,published) select 'complaint_category','正式大小类','enabled',1,1 where not exists (select 1 from dict_type where dict_type='complaint_category')");
    const types = await db('dict_type').select('dict_type', 'dict_name', 'status', 'version', 'published').whereNot('dict_type', 'sensitive_word');
    for (const r of types) {
        const rows = await db('dict_item').select('item_id', 'item_value', 'item_label', 'parent_code', 'sort_order', 'status', 'version', 'published').where('dict_type', r.dict_type).orderBy('item_value');
        const type = { code: r.dict_type, name: r.dict_name, status: r.status, version: Number(r.version), published: Boolean(r.published), readOnly: ['status', 'correction_status', 'supervision_status', 'reporting_status', 'source_event_status', 'dispatch_type', 'trigger_type', 'intake_result'].includes(r.dict_type), fixedCodes: ['business_type', 'complaint_type', 'urgency_level'].includes(r.dict_type) };
        const items = rows.map(i => ({ itemId: i.item_id, typeCode: r.dict_type, code: i.item_value, label: i.item_label, parentCode: i.parent_code, sort: Number(i.sort_order), status: i.status, version: Number(i.version), published: Boolean(i.published) }));
        await db.raw('insert ignore into dictionary_version (type_code,version,snapshot,created_at) values (?,?,?,?)', [type.code, type.version, JSON.stringify({ type, items }), new Date()]);
    }
    for (const column of ['source_major_category_code', 'source_minor_category_code', 'source_category_version', 'major_category_code', 'minor_category_code', 'category_dictionary_version'])
        if (!(await db.schema.hasColumn('complaint', column)))
            await db.raw('alter table complaint add column ?? varchar(64) null', [column]);
    if (!(await db.schema.hasTable('complaint_category_revision')))
        await db.raw('create table complaint_category_revision (id bigint unsigned auto_increment primary key,revision_id varchar(64) not null unique,complaint_id varchar(64) not null,old_major_code varchar(64),old_minor_code varchar(64),old_dictionary_version varchar(64),major_code varchar(64) not null,minor_code varchar(64),dictionary_version varchar(64) not null,edit_version bigint unsigned not null,operator_id varchar(64),basis varchar(500),created_at datetime not null,index idx_category_revision_complaint (complaint_id,id)) engine=InnoDB default charset=utf8mb4');
    for (const [table, name, columns] of [['complaint', 'idx_b1_current_category', 'major_category_code,minor_category_code'], ['dict_item', 'idx_b1_parent', 'dict_type,parent_code']]) {
        const [indexes] = await db.raw('show index from ??', [table]);
        if (!indexes.some(r => r.Key_name === name))
            await db.raw('alter table ?? add index ?? (' + columns + ')', [table, name]);
    }
};
exports.down = async () => { throw Error('B1 category/history rollback requires evidence-preserving restoration'); };
