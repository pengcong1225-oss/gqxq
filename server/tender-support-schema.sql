CREATE TABLE IF NOT EXISTS gqxq_tender_support_store (
  store_key VARCHAR(40) NOT NULL PRIMARY KEY,
  revision BIGINT NOT NULL,
  content JSON NOT NULL,
  updated_by VARCHAR(64) NOT NULL,
  updated_at DATETIME NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS gqxq_tender_support_history (
  store_key VARCHAR(40) NOT NULL,
  revision BIGINT NOT NULL,
  content JSON NOT NULL,
  updated_by VARCHAR(64) NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (store_key, revision)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
