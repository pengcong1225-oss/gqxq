-- Restore backend manual followup to the protected built-in administrator only.
START TRANSACTION;
SELECT version FROM platform_authorization_state WHERE id=1 FOR UPDATE;
INSERT IGNORE INTO platform_role_permission(role_code,permission_code) SELECT role_code,'followup.create' FROM platform_role WHERE role_code='admin' AND built_in=1;
INSERT IGNORE INTO platform_role_permission(role_code,permission_code) SELECT role_code,'followup.conclude' FROM platform_role WHERE role_code='admin' AND built_in=1;
UPDATE platform_authorization_state SET version=version+1 WHERE id=1;
COMMIT;
