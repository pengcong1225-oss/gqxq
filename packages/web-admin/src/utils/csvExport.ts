/** Excel-compatible CSV; neutralize formula prefixes in user-controlled cells. */
export function encodeCsv(rows: unknown[][]): string {
  return '\uFEFF' + rows.map(row => row.map(value => {
    let text = value == null ? '' : String(value);
    if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }).join(',')).join('\r\n');
}
export function downloadCsv(rows: unknown[][], filename: string) {
  const url = URL.createObjectURL(new Blob([encodeCsv(rows)], {type: 'text/csv;charset=utf-8'}));
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
