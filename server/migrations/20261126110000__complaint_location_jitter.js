exports.up = knex => knex.schema.createTable('complaint_location_jitter', t => {
  t.string('complaint_id', 64).primary();
  t.string('generation', 36).notNullable();
  t.string('input_hash', 64).notNullable();
  t.string('state', 16).notNullable();
  t.dateTime('next_attempt_at').nullable();
  t.string('job_id', 64).nullable();
  t.decimal('longitude', 12, 8).nullable();
  t.decimal('latitude', 12, 8).nullable();
  t.index(['next_attempt_at', 'complaint_id']);
});

exports.down = knex => knex.schema.dropTable('complaint_location_jitter');
