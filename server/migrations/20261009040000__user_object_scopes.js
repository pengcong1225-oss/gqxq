// A5 checkpoint survives scope DDL; column existence is not completion evidence.
exports.up = async (db) => {
    for (const table of ['app_user', 'platform_authorization_state']) {
        const [rows] = await db.raw('select ENGINE from information_schema.tables where table_schema=database() and table_name=?', [table]);
        if (rows[0]?.ENGINE !== 'InnoDB')
            throw Error('A2 requires InnoDB dependency ' + table);
    }
    const [stateColumns] = await db.raw('show full columns from platform_authorization_state');
    const [userColumns] = await db.raw('show full columns from app_user');
    for (const [columns, field, types] of [[stateColumns, 'id', ['int']], [stateColumns, 'version', ['bigint']], [userColumns, 'id', ['bigint', 'int']], [userColumns, 'user_id', ['varchar']], [userColumns, 'status', ['tinyint', 'int']], [userColumns, 'session_version', ['bigint']]]) {
        const c = columns.find(c => c.Field === field);
        if (!c || !types.includes(c.Type.split(/[ (]/)[0]) || !['user_id', 'status'].includes(field) && c.Null !== 'NO' || /GENERATED/i.test(c.Extra))
            throw Error('A2 incompatible dependency ' + field);
    }
    const [keys] = await db.raw('show index from platform_authorization_state');
    const primary = keys.filter(r => r.Key_name === 'PRIMARY');
    if (primary.length !== 1 || primary[0].Column_name !== 'id' || Number(primary[0].Non_unique) !== 0 || primary[0].Sub_part != null || primary[0].Expression != null)
        throw Error('A2 requires complete A5 singleton key');
    const state = await db('platform_authorization_state').where('id', 1).first();
    if (!state)
        throw Error('A2 requires A5 authorization singleton');
    const present = ['scope_rules', 'scope_version', 'scope_provenance'].map(field => userColumns.some(c => c.Field === field));
    const marker = stateColumns.find(c => c.Field === 'scope_bootstrap_state'), inventory = stateColumns.find(c => c.Field === 'scope_bootstrap_users');
    if (Boolean(marker) !== Boolean(inventory) || marker && (marker.Type !== 'varchar(16)' || inventory.Type !== 'json' || marker.Null !== 'YES' || inventory.Null !== 'YES' || /GENERATED|auto_increment/i.test(marker.Extra + ' ' + inventory.Extra)))
        throw Error('A2 incompatible checkpoint; explicit recovery required');
    if (!marker && present.some(Boolean))
        throw Error('A2 ambiguous legacy scope columns; explicit recovery required: verify historical evidence and preserve grants before marking complete (scope-bootstrap-recovery.md)');
    if (present.some(Boolean) && !present.every(Boolean))
        throw Error('A2 incomplete scope columns; explicit recovery required');
    if (present.every(Boolean))
        for (const [field, type, nullable] of [['scope_rules', 'json', 'YES'], ['scope_version', 'bigint', 'NO'], ['scope_provenance', 'varchar(64)', 'NO']]) {
            const c = userColumns.find(c => c.Field === field);
            if (!(type === 'bigint' ? /^bigint(\(\d+\))? unsigned$/.test(c.Type) : c.Type === type) || c.Null !== nullable || /GENERATED/i.test(c.Extra))
                throw Error('A2 incompatible scope column ' + field);
        }
    const unstarted = marker && state.scope_bootstrap_state == null && !present.some(Boolean) && state.scope_bootstrap_users == null;
    if (marker && !unstarted && !['pending', 'complete'].includes(state.scope_bootstrap_state))
        throw Error('A2 ambiguous checkpoint; explicit recovery required');
    if (marker && state.scope_bootstrap_state === 'complete') {
        if (!present.every(Boolean))
            throw Error('A2 completed checkpoint lacks scope columns; explicit recovery required');
        return;
    }
    if (marker && state.scope_bootstrap_state === 'pending') {
        let record;
        try {
            record = typeof state.scope_bootstrap_users === 'string' ? JSON.parse(state.scope_bootstrap_users) : state.scope_bootstrap_users;
        }
        catch {
            throw Error('A2 ambiguous inventory; explicit recovery required');
        }
        if (!Array.isArray(record?.users) || !record.users.every(u => typeof u.id === 'string' && /^\d+$/.test(u.id) && typeof u.user_id === 'string' && Number(u.status) === 1 && typeof u.session_version === 'string' && /^\d+$/.test(u.session_version)))
            throw Error('A2 ambiguous inventory; explicit recovery required');
    }
    if (!marker || unstarted) {
        if (!marker)
            await db.raw('alter table platform_authorization_state add column scope_bootstrap_state varchar(16) null,add column scope_bootstrap_users json null');
        await db.transaction(async (tx) => {
            await tx.raw('select version from platform_authorization_state where id=1 for update');
            const [users] = await tx.raw('select cast(id as char) as id,user_id,status,cast(session_version as char) as session_version from app_user where status=1 and user_id is not null for update');
            await tx('platform_authorization_state').where('id', 1).update({ scope_bootstrap_state: 'pending', scope_bootstrap_users: JSON.stringify({ users, skipped: [] }) });
        });
    }
    if (!present.every(Boolean))
        await db.raw('alter table app_user add column scope_rules json null,add column scope_version bigint unsigned not null default 1,add column scope_provenance varchar(64) not null default ?', ['new-account-deny']);
    await db.transaction(async (tx) => {
        const checkpoint = await tx('platform_authorization_state').where('id', 1).forUpdate().first();
        if (checkpoint.scope_bootstrap_state === 'complete')
            return;
        const record = typeof checkpoint.scope_bootstrap_users === 'string' ? JSON.parse(checkpoint.scope_bootstrap_users) : checkpoint.scope_bootstrap_users;
        if (checkpoint.scope_bootstrap_state !== 'pending' || !Array.isArray(record?.users))
            throw Error('A2 ambiguous inventory; explicit recovery required');
        const skipped = [];
        for (const original of record.users) {
            // An administrator may deliberately restore null/deny text; advanced scope
            // version or a changed identity/session/status still forbids bootstrap.
            const count = await tx('app_user').where({ id: original.id, user_id: original.user_id, status: original.status, session_version: original.session_version, scope_version: 1, scope_provenance: 'new-account-deny' }).whereNull('scope_rules').update({ scope_rules: JSON.stringify([{ kind: 'all' }]), scope_provenance: 'legacy-all-bootstrap-20261009' });
            if (!count)
                skipped.push({ id: original.id, userId: original.user_id, reason: 'identity/status/session/scope changed' });
        }
        await tx('platform_authorization_state').where('id', 1).update({ scope_bootstrap_state: 'complete', scope_bootstrap_users: JSON.stringify({ users: record.users, skipped }) });
        await tx('platform_authorization_state').where('id', 1).increment('version', 1);
    });
};
exports.down = async () => { throw new Error('Scope rollback requires evidence-preserving restoration'); };
