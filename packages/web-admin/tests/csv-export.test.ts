import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeCsv } from '../src/utils/csvExport';
test('CSV preserves Chinese, quotes and multiline values and neutralizes spreadsheet formulas', () => {
 assert.equal(encodeCsv([['诉求', 'a"b', '一\n二', null, '=SUM(A1)', '  +123', '@CMD', '-1']]), '\uFEFF"诉求","a""b","一\n二","","\'=SUM(A1)","\'  +123","\'@CMD","\'-1"');
});
