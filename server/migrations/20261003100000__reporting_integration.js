exports.up=async function(knex) {
 await knex.schema.alterTable('dispatch_order',t=>{t.bigInteger('last_event_sequence').notNullable().defaultTo(0);t.string('reporting_item_id',128).nullable();t.dateTime('last_reconciled_at').nullable();});
 await knex.schema.createTable('dispatch_push_snapshot',t=>{t.string('assignment_id',128).primary();t.string('request_id',128).notNullable();t.text('body','longtext').notNullable();t.string('sha256',64).notNullable();t.dateTime('created_at').notNullable();});
};
exports.down=async function(knex) {await knex.schema.dropTable('dispatch_push_snapshot');await knex.schema.alterTable('dispatch_order',t=>{t.dropColumn('last_event_sequence');t.dropColumn('reporting_item_id');t.dropColumn('last_reconciled_at');});};
