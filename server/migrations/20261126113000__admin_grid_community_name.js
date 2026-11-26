exports.up = knex => knex.schema.alterTable('admin_grid', table => {
  table.string('administrative_community_name', 128).nullable();
});

exports.down = knex => knex.schema.alterTable('admin_grid', table => {
  table.dropColumn('administrative_community_name');
});
