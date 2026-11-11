exports.up=async function(knex){await knex.raw(`CREATE TABLE IF NOT EXISTS complaint_location_initialization (
 complaint_id varchar(64) NOT NULL PRIMARY KEY,
 input_hash char(64) NOT NULL,
 state varchar(24) NOT NULL,
 reason varchar(500) NOT NULL,
 attempts int NOT NULL DEFAULT 0,
 next_attempt_at datetime NULL,
 updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
 KEY idx_location_init_retry(state,next_attempt_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);};
exports.down=async function(){throw new Error('Location initialization history is retained on rollback');};
