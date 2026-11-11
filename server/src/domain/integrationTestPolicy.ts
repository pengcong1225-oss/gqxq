/** One explicit fixture identity; never infer a test from a title or business name. */
export const INTEGRATION_TEST_ENTERPRISE = 'GQXQ-TEST-20261020';
export const INTEGRATION_TEST_SOURCE = 'DEMO-20261110';
export const INTEGRATION_TEST_ID_PREFIX = 'INTEGRATION-TEST-';
export function isIntegrationTestComplaint(row:Record<string,unknown>):boolean {
 return row.source_system===INTEGRATION_TEST_SOURCE && typeof row.source_id==='string' && row.source_id.startsWith(INTEGRATION_TEST_ID_PREFIX);
}
export function mayDispatchToDisabledTestEnterprise(code:string,row:Record<string,unknown>,roles:readonly string[]):boolean {
 return code===INTEGRATION_TEST_ENTERPRISE && isIntegrationTestComplaint(row) && roles.includes('admin');
}
/** Bounded aliases only; escaped LIKE marker is the same exact prefix as the predicate above. */
export function excludeIntegrationTestsSql(alias:'c'|'scope_c'):string {
 if(alias!=='c'&&alias!=='scope_c')throw new Error('invalid integration test SQL alias');
 return `(not (coalesce(${alias}.source_system,'')='${INTEGRATION_TEST_SOURCE}' and coalesce(${alias}.source_id,'') like '${INTEGRATION_TEST_ID_PREFIX}%'))`;
}
