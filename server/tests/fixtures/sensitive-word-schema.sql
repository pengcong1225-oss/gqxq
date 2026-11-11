-- Synthetic service-test schema only; migration-chain verification is a separate gate.
CREATE TABLE complaint (
 id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY, complaint_id varchar(64) NOT NULL UNIQUE,
 title varchar(500), content text, address varchar(500), enterprise_code varchar(64), district_code varchar(64),
 deleted tinyint NOT NULL DEFAULT 0, is_sensitive tinyint NOT NULL DEFAULT 0, sensitive_keywords varchar(500),
 rule_confidence decimal(5,2), rule_version varchar(64), edit_version int NOT NULL DEFAULT 0, updated_at datetime
) ENGINE=InnoDB;
CREATE TABLE dict_item (
 id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY, item_id varchar(64) NOT NULL UNIQUE,
 dict_type varchar(64) NOT NULL, item_value varchar(128) NOT NULL, item_label varchar(128) NOT NULL,
 status varchar(16) NOT NULL DEFAULT 'enabled'
) ENGINE=InnoDB;
CREATE TABLE sensitive_hit (
 id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY, complaint_id varchar(64) NOT NULL,
 keyword varchar(128), dict_item_id varchar(64), matched_field varchar(64), matched_text varchar(500),
 rule_version varchar(64), created_at datetime
) ENGINE=InnoDB;
CREATE TABLE operation_audit_log (
 id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY, audit_id varchar(64) NOT NULL UNIQUE,
 user_id varchar(64), app_code varchar(64), resource_code varchar(128), action varchar(64),
 biz_type varchar(64), biz_id varchar(128), result varchar(32), client_ip varchar(64), detail json, created_at datetime
) ENGINE=InnoDB;
CREATE TABLE complaint_field_version (
 id bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY, version_id varchar(64) NOT NULL UNIQUE,
 complaint_id varchar(64) NOT NULL, field_name varchar(64), old_value text, new_value text,
 change_source varchar(64), reason varchar(500), operator_id varchar(64), operator_name varchar(64), changed_at datetime
) ENGINE=InnoDB;
INSERT INTO complaint (complaint_id,title) VALUES ('SYNTHETIC-SENSITIVE-C1','合成普通诉求');
INSERT INTO dict_item (item_id,dict_type,item_value,item_label,status) VALUES ('SYNTHETIC-SW1','sensitive_word','爆管','爆管','enabled');
