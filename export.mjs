import ExcelJS from 'exceljs';
import {JOBS, dayNumber, splitEntry, analyze, normalizeState} from './public/core.mjs';

const DATE_FORMAT = 'dd"."mm"."yyyy';
const TIME_FORMAT = 'hh:mm';
const DURATION_FORMAT = '[h]:mm';
const FIRST_ROW = 7;
const serial = date => dayNumber(date) + 25569;
const fill = argb => ({type: 'pattern', pattern: 'solid', fgColor: {argb}});

function textCell(cell, value) {
  // XLSX strings remain literal even when they start with =, +, - or @.
  // Never interpret user notes as formula objects or hyperlinks.
  cell.value = String(value ?? '');
  cell.numFmt = '@';
}

function setupSheet(sheet, title, color, widths, lastColumn) {
  sheet.views = [{state: 'frozen', ySplit: 6, showGridLines: false}];
  sheet.properties.tabColor = {argb: color};
  sheet.columns = widths.map(width => ({width}));
  sheet.mergeCells(1, 1, 1, lastColumn);
  sheet.getCell('A1').value = title;
  sheet.getCell('A1').font = {name: 'Arial', size: 18, bold: true, color: {argb: color}};
  sheet.getRow(1).height = 32;
  sheet.pageSetup = {orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0};
  sheet.pageSetup.printTitlesRow = '1:6';
}

function note(sheet, row, value, lastColumn) {
  sheet.mergeCells(row, 1, row, lastColumn);
  sheet.getCell(row, 1).value = value;
  sheet.getCell(row, 1).font = {name: 'Arial', size: 10, color: {argb: 'FF667387'}};
  sheet.getCell(row, 1).alignment = {vertical: 'middle', wrapText: true};
  sheet.getRow(row).height = 22;
}

function header(sheet, labels, color) {
  sheet.getRow(6).values = labels;
  sheet.getRow(6).height = 30;
  sheet.getRow(6).eachCell(cell => {
    cell.fill = fill(color);
    cell.font = {name: 'Arial', size: 11, bold: true, color: {argb: 'FFFFFFFF'}};
    cell.alignment = {vertical: 'middle', wrapText: true};
  });
}

function bodyRow(sheet, index, values, noteColumn) {
  const row = sheet.getRow(index);
  row.values = values;
  row.eachCell({includeEmpty: true}, cell => {
    cell.font = {name: 'Arial', size: 11, color: {argb: 'FF18283D'}};
    cell.alignment = {vertical: 'middle'};
    if ((index - FIRST_ROW) % 2) cell.fill = fill('FFF3F6FA');
  });
  const text = String(values[noteColumn - 1] ?? '');
  const width = sheet.getColumn(noteColumn).width;
  const lines = text.split(/\r?\n/).reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / (width - 2))), 0);
  row.height = Math.max(27, Math.min(409, lines * 15 + 10));
  row.getCell(noteColumn).alignment = {vertical: 'middle', wrapText: true};
  textCell(row.getCell(noteColumn), text);
}

function total(sheet, labelAddress, valueAddress, formula, minutes, color) {
  sheet.getCell(labelAddress).value = 'Total';
  sheet.getCell(valueAddress).value = {formula, result: minutes / 1440};
  sheet.getCell(valueAddress).numFmt = DURATION_FORMAT;
  for (const address of [labelAddress, valueAddress]) {
    sheet.getCell(address).font = {name: 'Arial', size: 13, bold: true, color: {argb: color}};
  }
  sheet.getRow(4).height = 25;
}

/** Build a portable workbook in memory; callers decide where to download or save it. */
export async function exportWorkbook(state, jobId, month) {
  const job = JOBS.find(item => item.id === jobId);
  if (!job) throw new Error('Unknown workplace');
  const entries = normalizeState(state).entries;
  const review = analyze(entries, month);
  if (review.invalid.some(row => row.jobId === jobId)) {
    throw new Error('بازه‌های ناقص این محل کار را کامل کن.');
  }
  const rows = entries.filter(row => row.jobId === jobId)
    .flatMap(row => splitEntry(row, month))
    .sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start || a.id.localeCompare(b.id));
  if (!rows.length) throw new Error('برای این ماه بازه‌ای ثبت نشده است.');

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Work Planner';
  workbook.calcProperties.fullCalcOnLoad = true;
  const sheet = workbook.addWorksheet('Time entries');
  const daily = workbook.addWorksheet('Daily totals');
  const color = `FF${job.color.replace('#', '').toUpperCase()}`;
  const last = FIRST_ROW + rows.length - 1;
  const dates = [...new Set(rows.map(row => row.date))];
  const totalMinutes = rows.reduce((sum, row) => sum + row.duration, 0);

  setupSheet(sheet, `${job.name} · ${month}`, color, [18, 16, 12, 12, 16, 14, 54, 23, 40], 9);
  note(sheet, 2, 'Work duration uses the entered local clock times. Overnight entries are split at midnight.', 9);
  note(sheet, 3, 'Overlap status is a snapshot at export time; review highlighted entries before submitting.', 9);
  total(sheet, 'E4', 'F4', `SUM(F${FIRST_ROW}:F${last})`, totalMinutes, color);
  header(sheet, ['Workplace', 'Date', 'Start', 'End', 'End date', 'Duration', 'Tasks / notes', 'Overlap at export', 'Entry ID'], color);
  for (const [index, row] of rows.entries()) {
    const number = FIRST_ROW + index;
    bodyRow(sheet, number, [job.name, serial(row.date), row.start / 1440,
      row.end === 1440 ? 0 : row.end / 1440, serial(row.date) + (row.end === 1440 ? 1 : 0),
      {formula: `E${number}+D${number}-B${number}-C${number}`, result: row.duration / 1440},
      row.tasks, review.byId.has(row.id) ? 'OVERLAP' : '', row.id], 7);
    for (const column of [2, 5]) sheet.getCell(number, column).numFmt = DATE_FORMAT;
    for (const column of [3, 4]) sheet.getCell(number, column).numFmt = TIME_FORMAT;
    sheet.getCell(number, 6).numFmt = DURATION_FORMAT;
    textCell(sheet.getCell(number, 9), row.id);
    if (review.byId.has(row.id)) sheet.getCell(number, 8).fill = fill('FFFFE2E7');
  }
  sheet.autoFilter = {from: {row: 6, column: 1}, to: {row: last, column: 9}};

  setupSheet(daily, `${job.name} · Daily totals · ${month}`, color, [18, 16, 16, 75], 4);
  note(daily, 2, 'Daily durations link to Time entries. Tasks list the notes entered for that day.', 4);
  total(daily, 'A4', 'B4', `SUM(B${FIRST_ROW}:B${6 + dates.length})`, totalMinutes, color);
  header(daily, ['Date', 'Duration', 'Minutes', 'Tasks / notes'], color);
  for (const [index, date] of dates.entries()) {
    const number = FIRST_ROW + index;
    const matches = rows.filter(row => row.date === date);
    const minutes = matches.reduce((sum, row) => sum + row.duration, 0);
    const allTasks = [...new Set(matches.map(row => row.tasks).filter(Boolean))].join(' | ');
    // Excel limits one cell to 32,767 characters; full notes remain in the detail sheet.
    const tasks = allTasks.length > 32000 ? `${allTasks.slice(0, 32000)} … (full notes in Time entries)` : allTasks;
    bodyRow(daily, number, [serial(date),
      {formula: `SUMIF('Time entries'!$B$7:$B$${last},A${number},'Time entries'!$F$7:$F$${last})`, result: minutes / 1440},
      {formula: `ROUND(B${number}*1440,0)`, result: minutes}, tasks], 4);
    daily.getCell(number, 1).numFmt = DATE_FORMAT;
    daily.getCell(number, 2).numFmt = DURATION_FORMAT;
    daily.getCell(number, 3).numFmt = '0';
  }
  daily.autoFilter = {from: {row: 6, column: 1}, to: {row: 6 + dates.length, column: 4}};

  return {bytes: Buffer.from(await workbook.xlsx.writeBuffer()), filename: `${job.name}_${month}.xlsx`, totalMinutes};
}
