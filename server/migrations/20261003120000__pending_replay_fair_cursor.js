exports.up=async function(knex){await knex.schema.createTable('integration_replay_cursor',t=>{t.string('scope',64).primary();t.bigInteger('last_event_id').notNullable().defaultTo(0);});};
exports.down=async function(knex){await knex.schema.dropTable('integration_replay_cursor');};
