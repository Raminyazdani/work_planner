import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import {exportWorkbook} from '../export.mjs';

const entry = (id, jobId, date, start, end, options = {}) => ({
  id, jobId, date, start, end, endNextDay: false, tasks: 'Synthetic test note', ...options,
});
const state = entries => ({version: 1, entries});
const close = (actual, expected) => {
  // ExcelJS reads cells formatted [h]:mm back as Date objects, including formula results.
  const number = actual instanceof Date ? actual.getTime() / 86400000 + 25569 : actual;
  assert.ok(Math.abs(number - expected) < 1e-9, `${number} differs from ${expected}`);
};
async function readExport(entries, jobId = 'jena', month = '2027-03') {
  const output = await exportWorkbook(state(entries), jobId, month);
  assert.ok(Buffer.isBuffer(output.bytes));
  assert.equal(output.path, undefined);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(output.bytes);
  return {...output, book, detail: book.getWorksheet('Time entries'), daily: book.getWorksheet('Daily totals')};
}

test('exports one workplace only, with numeric cached totals and editable formulas', async () => {
  const rows = [
    entry('a', 'jena', '2027-03-02', '09:00', '11:00', {tasks: 'Analysis'}),
    entry('b', 'jena', '2027-03-02', '12:00', '13:30', {tasks: 'Documentation'}),
    entry('c', 'seewiesen', '2027-03-03', '10:00', '12:30', {tasks: 'Other workplace'}),
  ];
  const original = structuredClone(rows);
  const {filename, totalMinutes, book, detail, daily} = await readExport(rows);
  assert.equal(filename, 'Jena_2027-03.xlsx');
  assert.equal(totalMinutes, 210);
  assert.deepEqual(book.worksheets.map(sheet => sheet.name), ['Time entries', 'Daily totals']);
  assert.equal(detail.rowCount, 8);
  assert.equal(detail.getCell('A7').value, 'Jena');
  assert.equal(detail.getCell('B7').value.toISOString(), '2027-03-02T00:00:00.000Z');
  assert.equal(detail.getCell('F7').formula, 'E7+D7-B7-C7');
  close(detail.getCell('F7').result, 120 / 1440);
  assert.equal(detail.getCell('F4').formula, 'SUM(F7:F8)');
  close(detail.getCell('F4').result, 210 / 1440);
  assert.equal(detail.getCell('F4').numFmt, '[h]:mm');
  assert.equal(daily.getCell('B7').formula, "SUMIF('Time entries'!$B$7:$B$8,A7,'Time entries'!$F$7:$F$8)");
  assert.equal(daily.getCell('C7').result, 210);
  assert.equal(daily.getCell('D7').value, 'Analysis | Documentation');
  assert.equal(detail.views[0].ySplit, 6);
  assert.equal(detail.getCell('G7').alignment.wrapText, true);
  assert.deepEqual(rows, original, 'export must not mutate saved state');
  const other = await readExport(rows, 'seewiesen');
  assert.equal(other.totalMinutes, 150);
  assert.equal(other.filename, 'Seewiesen_2027-03.xlsx');
  assert.equal(other.detail.getCell('A7').value, 'Seewiesen');
});

test('splits midnight and clips both ends of the selected month', async () => {
  const rows = [
    entry('previous-month', 'jena', '2027-02-28', '23:30', '00:30', {endNextDay: true}),
    entry('overnight', 'jena', '2027-03-03', '23:15', '00:45', {endNextDay: true}),
    entry('next-month', 'jena', '2027-03-31', '23:30', '00:30', {endNextDay: true}),
  ];
  const {detail, daily, totalMinutes} = await readExport(rows);
  assert.equal(totalMinutes, 150);
  assert.equal(detail.rowCount, 10);
  assert.equal(detail.getCell('B7').value.toISOString().slice(0, 10), '2027-03-01');
  assert.equal(detail.getCell('E8').value.toISOString().slice(0, 10), '2027-03-04');
  close(detail.getCell('F8').result, 45 / 1440);
  close(detail.getCell('F9').result, 45 / 1440);
  assert.equal(detail.getCell('E10').value.toISOString().slice(0, 10), '2027-04-01');
  assert.equal(daily.getCell('C7').result, 30);
  assert.equal(daily.getCell('C10').result, 30);
});

test('flags cross-workplace overlap and keeps formula-looking notes as literal text', async () => {
  const notes = ['=HYPERLINK("https://example.invalid","click")', '+1+1', '-2+3', '@SUM(A1:A2)', '\n=1+1'];
  const rows = notes.map((tasks, index) => entry(`literal-${index}`, 'jena', `2027-03-${String(index + 1).padStart(2, '0')}`, '09:00', '10:00', {tasks}));
  rows.push(entry('overlap', 'seewiesen', '2027-03-01', '09:30', '10:30'));
  const {detail, daily} = await readExport(rows);
  for (const [index, text] of notes.entries()) {
    const cell = detail.getCell(index + 7, 7);
    assert.equal(cell.type, ExcelJS.ValueType.String);
    assert.equal(cell.formula, undefined);
    assert.equal(cell.hyperlink, undefined);
    assert.equal(cell.value, text);
    assert.equal(daily.getCell(index + 7, 4).value, text);
  }
  assert.equal(detail.getCell('H7').value, 'OVERLAP');
  assert.equal(detail.getCell('H7').fill.fgColor.argb, 'FFFFE2E7');
  assert.equal(detail.getCell('H8').value, '');
});

test('rejects invalid export requests without producing files', async () => {
  const valid = entry('a', 'jena', '2027-03-01', '09:00', '10:00');
  await assert.rejects(exportWorkbook(state([valid]), 'unknown', '2027-03'), /Unknown workplace/);
  await assert.rejects(exportWorkbook(state([valid]), 'jena', '../03'), /Invalid month/);
  await assert.rejects(exportWorkbook(state([]), 'jena', '2027-03'));
  await assert.rejects(exportWorkbook(state([{...valid, end: ''}]), 'jena', '2027-03'));
  await assert.rejects(exportWorkbook(state([valid, valid]), 'jena', '2027-03'), /Invalid entry/);
});
