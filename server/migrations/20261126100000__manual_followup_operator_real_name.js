const table = 'manual_followup_revision';
const column = 'operator_real_name';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn(table, column))) {
    await knex.schema.alterTable(table, (revision) => {
      revision.string(column, 64).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex(table).whereNotNull(column).first('followup_id')) {
    throw new Error('Cannot drop stored follow-up operator name snapshots');
  }
  await knex.schema.alterTable(table, (revision) => revision.dropColumn(column));
};
