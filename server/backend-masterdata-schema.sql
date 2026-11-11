-- Backend enterprise/grid metadata upgrade. Apply to the selected gqxq schema before updated server starts.
-- Additive and repeatable. Existing unknown values remain NULL; no business data is generated.
-- grid_name already exists; grid history snapshots retain the metadata recorded at save time.
SET @backend_masterdata_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='enterprise' AND column_name='display_on_screen'), 'SELECT 1', 'ALTER TABLE `enterprise` ADD COLUMN `display_on_screen` TINYINT(1) NULL DEFAULT NULL');
PREPARE backend_masterdata_stmt FROM @backend_masterdata_ddl;
EXECUTE backend_masterdata_stmt;
DEALLOCATE PREPARE backend_masterdata_stmt;

SET @backend_masterdata_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='enterprise' AND column_name='screen_name'), 'SELECT 1', 'ALTER TABLE `enterprise` ADD COLUMN `screen_name` VARCHAR(128) NULL DEFAULT NULL');
PREPARE backend_masterdata_stmt FROM @backend_masterdata_ddl;
EXECUTE backend_masterdata_stmt;
DEALLOCATE PREPARE backend_masterdata_stmt;

SET @backend_masterdata_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='service_grid' AND column_name='manager_name'), 'SELECT 1', 'ALTER TABLE `service_grid` ADD COLUMN `manager_name` VARCHAR(64) NULL DEFAULT NULL');
PREPARE backend_masterdata_stmt FROM @backend_masterdata_ddl;
EXECUTE backend_masterdata_stmt;
DEALLOCATE PREPARE backend_masterdata_stmt;

SET @backend_masterdata_ddl = IF(EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='service_grid' AND column_name='manager_phone'), 'SELECT 1', 'ALTER TABLE `service_grid` ADD COLUMN `manager_phone` VARCHAR(64) NULL DEFAULT NULL');
PREPARE backend_masterdata_stmt FROM @backend_masterdata_ddl;
EXECUTE backend_masterdata_stmt;
DEALLOCATE PREPARE backend_masterdata_stmt;
