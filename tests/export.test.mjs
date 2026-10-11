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
  assert.equal(daily.getCell('D7').value, '09:00–11:00\nAnalysis\n\n12:00–13:30\nDocumentation');
  assert.equal(detail.getCell('G6').value, 'Description / activity');
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
    assert.equal(daily.getCell(index + 7, 4).value, `09:00–10:00\n${text}`);
    assert.equal(daily.getCell(index + 7, 4).type, ExcelJS.ValueType.String);
  }
  assert.equal(detail.getCell('H7').value, 'OVERLAP');
  assert.equal(detail.getCell('H7').fill.fgColor.argb, 'FFFFE2E7');
  assert.equal(detail.getCell('H8').value, '');
});

test('preserves multiline Persian and German descriptions, per-entry association and readable formatting', async () => {
  const description = 'تحلیل داده‌ها و آماده‌سازی گزارش\nAuswertung der Messdaten: Prüfung, Größe, Änderungen.\n=SUM(A1:A2)';
  const {book, detail, daily} = await readExport([
    entry('morning', 'jena', '2027-03-04', '09:00', '11:00', {tasks: description}),
    entry('afternoon', 'jena', '2027-03-04', '13:00', '15:00', {tasks: description}),
  ]);
  assert.equal(book.worksheets.length, 2);
  for (const number of [7, 8]) {
    assert.equal(detail.getCell(number, 7).value, description);
    assert.equal(detail.getCell(number, 7).alignment.wrapText, true);
    assert.equal(detail.getCell(number, 7).alignment.vertical, 'top');
    assert.ok(detail.getRow(number).height >= 58);
    assert.ok(detail.getRow(number).height <= 409);
  }
  assert.equal(daily.getCell('D7').value, `09:00–11:00\n${description}\n\n13:00–15:00\n${description}`);
  assert.equal(daily.getCell('D7').alignment.wrapText, true);
  assert.ok(daily.getRow(7).height > detail.getRow(7).height);
  assert.equal(detail.getCell('I7').value, 'morning');
  assert.equal(detail.getCell('I8').value, 'afternoon');
});

test('retains blank legacy descriptions and copies the full description to both overnight parts', async () => {
  const legacy = entry('legacy', 'jena', '2027-03-01', '09:00', '10:00');
  delete legacy.tasks;
  const description = 'Nächtliche Auswertung\nکنترل داده‌ها';
  const {detail, daily, totalMinutes} = await readExport([
    legacy,
    entry('empty', 'jena', '2027-03-02', '10:00', '11:00', {tasks: ''}),
    entry('night', 'jena', '2027-03-03', '23:30', '00:45', {endNextDay: true, tasks: description}),
  ]);
  assert.equal(totalMinutes, 195);
  assert.equal(detail.getCell('G7').value, '');
  assert.equal(detail.getCell('G8').value, '');
  assert.equal(daily.getCell('D7').value, '');
  assert.equal(detail.getCell('G9').value, description);
  assert.equal(detail.getCell('G10').value, description);
  assert.equal(detail.getCell('I9').value, 'night');
  assert.equal(detail.getCell('I10').value, 'night');
  assert.equal(daily.getCell('D9').value, `23:30–24:00\n${description}`);
  assert.equal(daily.getCell('D10').value, `00:00–00:45\n${description}`);
});

test('long descriptions remain exact and have readable continuation rows within Excel height limits', async () => {
  const descriptions = [
    'Änderung بررسی داده 🌱 '.repeat(95).slice(0, 1995),
    Array.from({length: 80}, (_, index) => `${index + 1}: داده / Prüfung`).join('\r\n'),
  ];
  const {book, detail, totalMinutes} = await readExport(descriptions.map((tasks, index) => entry(`long-${index}`, 'jena', `2027-03-0${index + 1}`, '09:00', '11:00', {tasks})));
  const continued = book.getWorksheet('Description details');
  assert.ok(continued);
  assert.equal(totalMinutes, 240);
  assert.equal(detail.getCell('F4').formula, 'SUM(F7:F8)');
  close(detail.getCell('F4').result, 240 / 1440);
  for (const [index, description] of descriptions.entries()) {
    const expected = description.replace(/\r\n?/g, '\n'); // Excel cell line-ending convention.
    assert.equal(detail.getCell(index + 7, 7).value, expected);
    assert.match(detail.getCell(index + 7, 7).note, /Description details/);
    const parts = [];
    for (let number = 7; number <= continued.rowCount; number++) {
      if (continued.getCell(number, 5).value === `long-${index}`) {
        parts.push(continued.getCell(number, 4).value);
        assert.equal(continued.getCell(number, 4).alignment.wrapText, true);
        assert.ok(continued.getRow(number).height <= 394);
      }
    }
    assert.ok(parts.length >= 2);
    assert.equal(parts.join(''), expected);
  }
});

test('large daily summaries provide a clear full-text reference without losing per-entry descriptions', async () => {
  const description = 'Auswertung und Kontrolle. '.repeat(75);
  const rows = Array.from({length: 20}, (_, index) => entry(`daily-${index}`, 'jena', '2027-03-01', `${String(index).padStart(2, '0')}:00`, `${String(index).padStart(2, '0')}:30`, {tasks: description}));
  const {book, daily, detail, totalMinutes} = await readExport(rows);
  assert.equal(totalMinutes, 600);
  assert.ok(book.getWorksheet('Description details'));
  assert.ok(daily.getCell('D7').value.length < 32767);
  assert.match(daily.getCell('D7').value, /full descriptions in Description details and Time entries/);
  for (let number = 7; number <= detail.rowCount; number++) assert.equal(detail.getCell(number, 7).value, description);
});

test('rejects invalid export requests without producing files', async () => {
  const valid = entry('a', 'jena', '2027-03-01', '09:00', '10:00');
  await assert.rejects(exportWorkbook(state([valid]), 'unknown', '2027-03'), /Unknown workplace/);
  await assert.rejects(exportWorkbook(state([valid]), 'jena', '../03'), /Invalid month/);
  await assert.rejects(exportWorkbook(state([]), 'jena', '2027-03'));
  await assert.rejects(exportWorkbook(state([{...valid, end: ''}]), 'jena', '2027-03'));
  await assert.rejects(exportWorkbook(state([valid, valid]), 'jena', '2027-03'), /Invalid entry/);
});
