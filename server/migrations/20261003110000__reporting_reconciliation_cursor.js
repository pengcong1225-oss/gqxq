exports.up=async function(knex){await knex.schema.alterTable('dispatch_order',t=>t.string('last_reconciled_event_id',20).notNullable().defaultTo('0'));};
exports.down=async function(knex){await knex.schema.alterTable('dispatch_order',t=>t.dropColumn('last_reconciled_event_id'));};
