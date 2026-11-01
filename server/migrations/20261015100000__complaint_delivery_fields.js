exports.up=async function(knex){
 await knex.schema.alterTable('complaint',t=>{t.dateTime('source_deadline_at',3).nullable();t.dateTime('source_completed_at',3).nullable();t.dateTime('source_process_received_at',3).nullable();});
 await knex.schema.alterTable('source_process_stream',t=>{t.bigInteger('ingress_version').unsigned().nullable();t.string('ingress_hash',64).nullable();});
 await knex.schema.alterTable('source_process_revision',t=>{t.string('contact_phone',64).nullable();});
 await knex.schema.alterTable('source_business_head',t=>{t.json('followup_binding').nullable();});
 await knex.schema.alterTable('source_business_revision',t=>{t.json('followup_binding').nullable();});
 await knex.schema.alterTable('enterprise',t=>{t.boolean('dashboard_visible').notNullable().defaultTo(false);t.string('dashboard_name',128).nullable();});
 await knex.schema.alterTable('service_grid',t=>{t.string('manager_name',64).nullable();t.string('manager_phone',64).nullable();});
};
exports.down=async function(knex){
 await knex.schema.alterTable('service_grid',t=>{t.dropColumn('manager_name');t.dropColumn('manager_phone');});
 await knex.schema.alterTable('source_process_revision',t=>{t.dropColumn('contact_phone');});
 await knex.schema.alterTable('source_business_head',t=>{t.dropColumn('followup_binding');});
 await knex.schema.alterTable('source_business_revision',t=>{t.dropColumn('followup_binding');});
 await knex.schema.alterTable('enterprise',t=>{t.dropColumn('dashboard_visible');t.dropColumn('dashboard_name');});
 await knex.schema.alterTable('source_process_stream',t=>{t.dropColumn('ingress_version');t.dropColumn('ingress_hash');});
 await knex.schema.alterTable('complaint',t=>{t.dropColumn('source_deadline_at');t.dropColumn('source_completed_at');t.dropColumn('source_process_received_at');});
};
