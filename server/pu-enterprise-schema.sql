-- PU operating-company source bindings. Water-consuming customer organizations
-- and supervisory departments are never operating enterprises in this table.
SET @pu_enterprise_schema_ok = EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='enterprise' AND column_name='enterprise_code' AND column_type='varchar(64)' AND character_set_name='utf8mb4' AND collation_name='utf8mb4_0900_ai_ci');
SET @pu_enterprise_schema_guard = IF(@pu_enterprise_schema_ok,'DO 0','SELECT enterprise_code_type_or_collation_mismatch FROM enterprise');
PREPARE pu_enterprise_schema_check FROM @pu_enterprise_schema_guard;
EXECUTE pu_enterprise_schema_check;
DEALLOCATE PREPARE pu_enterprise_schema_check;
CREATE TABLE IF NOT EXISTS pu_enterprise_binding (
  source_system VARCHAR(32) NOT NULL,
  source_kind VARCHAR(16) NOT NULL,
  source_id VARCHAR(64) NOT NULL,
  business_type VARCHAR(16) NOT NULL,
  enterprise_code VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  source_enterprise_id VARCHAR(128) NOT NULL,
  source_subject_id VARCHAR(64) NULL,
  source_app_code VARCHAR(64) NULL,
  source_organization_code VARCHAR(128) NULL,
  gqxq_subject_code VARCHAR(64) NOT NULL,
  source_revision VARCHAR(128) NOT NULL,
  account_readiness JSON NOT NULL,
  source_payload JSON NOT NULL,
  updated_at DATETIME(6) NOT NULL,
  PRIMARY KEY(source_system,source_kind,source_id,business_type),
  UNIQUE KEY uq_pu_enterprise_binding_enterprise(enterprise_code),
  CONSTRAINT fk_pu_enterprise_binding_enterprise FOREIGN KEY(enterprise_code) REFERENCES enterprise(enterprise_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- IF NOT EXISTS is followed by a structural check, not treated as proof that
-- an independently created or partially upgraded table has the required shape.
SET @pu_enterprise_schema_ok =
 (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='pu_enterprise_binding')=14
 AND EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='pu_enterprise_binding' AND column_name='enterprise_code' AND column_type='varchar(64)' AND collation_name='utf8mb4_0900_ai_ci')
 AND (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='pu_enterprise_binding' AND column_name IN ('source_payload','account_readiness') AND data_type='json')=2
 AND (SELECT COUNT(*) FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name='pu_enterprise_binding' AND constraint_name='PRIMARY' AND column_name IN ('source_system','source_kind','source_id','business_type'))=4
 AND EXISTS(SELECT 1 FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name='pu_enterprise_binding' AND column_name='enterprise_code' AND referenced_table_name='enterprise' AND referenced_column_name='enterprise_code')
 AND EXISTS(SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='pu_enterprise_binding' AND index_name='uq_pu_enterprise_binding_enterprise' AND column_name='enterprise_code' AND non_unique=0);
SET @pu_enterprise_schema_guard = IF(@pu_enterprise_schema_ok,'DO 0','SELECT pu_enterprise_binding_schema_drift_detected FROM pu_enterprise_binding');
PREPARE pu_enterprise_schema_check FROM @pu_enterprise_schema_guard;
EXECUTE pu_enterprise_schema_check;
DEALLOCATE PREPARE pu_enterprise_schema_check;
