import ExcelJS from 'exceljs';
import {JOBS, dayNumber, splitEntry, analyze, normalizeState} from './public/core.mjs';

const DATE_FORMAT = 'dd"."mm"."yyyy';
const TIME_FORMAT = 'hh:mm';
const DURATION_FORMAT = '[h]:mm';
const FIRST_ROW = 7;
const DESCRIPTION_WIDTH = 60;
const MAX_VISIBLE_LINES = 24;
const serial = date => dayNumber(date) + 25569;
const fill = argb => ({type: 'pattern', pattern: 'solid', fgColor: {argb}});

function descriptionParts(text, width, limit = Infinity) {
  // Use a conservative width estimate for proportional fonts and retain all
  // content and line breaks when producing readable continuation rows.
  const capacity = Math.max(1, Math.floor((width - 3) * 0.8));
  const parts = [];
  let value = '', lines = 1, columns = 0;
  for (const [token] of text.matchAll(/\r\n|[\s\S]/gu)) {
    const newline = /^[\r\n]/.test(token);
    const size = token === '\t' ? 4 : 1;
    let nextLines = newline ? lines + 1 : lines + Math.floor((columns + size - 1) / capacity);
    let nextColumns = newline ? 0 : (columns + size - 1) % capacity + 1;
    if (nextLines > limit && value) {
      parts.push({text: value, lines});
      value = ''; lines = 1; columns = 0;
      nextLines = newline ? 2 : 1;
      nextColumns = newline ? 0 : size;
    }
    value += token; lines = nextLines; columns = nextColumns;
  }
  parts.push({text: value, lines});
  return parts;
}

const lineCount = (text, width) => descriptionParts(text, width)[0].lines;
const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

function textCell(cell, value) {
  // XLSX strings remain literal even when they start with =, +, - or @.
  // Never interpret user notes as formula objects or hyperlinks.
  // Excel uses LF inside a cell; normalize Windows line endings only in export.
  cell.value = String(value ?? '').replace(/\r\n?/g, '\n');
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
  const lines = lineCount(text, width);
  row.height = Math.max(27, Math.min(409, lines * 16 + 10));
  row.getCell(noteColumn).alignment = {vertical: 'top', wrapText: true};
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
  const dailyRows = dates.map(date => {
    const matches = rows.filter(row => row.date === date);
    const tasks = matches.filter(row => row.tasks).map(row => `${clock(row.start)}–${clock(row.end)}\n${row.tasks}`).join('\n\n');
    return {date, minutes: matches.reduce((sum, row) => sum + row.duration, 0), tasks};
  });
  const needsDetails = rows.some(row => lineCount(row.tasks, DESCRIPTION_WIDTH) > MAX_VISIBLE_LINES)
    || dailyRows.some(row => lineCount(row.tasks, 75) > MAX_VISIBLE_LINES);

  setupSheet(sheet, `${job.name} · ${month}`, color, [18, 16, 12, 12, 16, 14, DESCRIPTION_WIDTH, 23, 40], 9);
  note(sheet, 2, 'Work duration uses the entered local clock times. Overnight entries are split at midnight.', 9);
  note(sheet, 3, 'Overlap status is a snapshot at export time; review highlighted entries before submitting.', 9);
  total(sheet, 'E4', 'F4', `SUM(F${FIRST_ROW}:F${last})`, totalMinutes, color);
  header(sheet, ['Workplace', 'Date', 'Start', 'End', 'End date', 'Duration', 'Description / activity', 'Overlap at export', 'Entry ID'], color);
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
    if (lineCount(row.tasks, DESCRIPTION_WIDTH) > MAX_VISIBLE_LINES) {
      sheet.getCell(number, 7).note = 'The complete text is stored in this cell. See Description details for readable continuation rows.';
    }
    if (review.byId.has(row.id)) sheet.getCell(number, 8).fill = fill('FFFFE2E7');
  }
  sheet.autoFilter = {from: {row: 6, column: 1}, to: {row: last, column: 9}};

  setupSheet(daily, `${job.name} · Daily totals · ${month}`, color, [18, 16, 16, 75], 4);
  note(daily, 2, 'Daily durations link to Time entries. Each description is paired with its work interval.', 4);
  if (needsDetails) note(daily, 3, 'Long descriptions are also shown in full across readable rows in Description details.', 4);
  total(daily, 'A4', 'B4', `SUM(B${FIRST_ROW}:B${6 + dates.length})`, totalMinutes, color);
  header(daily, ['Date', 'Duration', 'Minutes', 'Descriptions / activities'], color);
  for (const [index, {date, minutes, tasks: allTasks}] of dailyRows.entries()) {
    const number = FIRST_ROW + index;
    // Excel limits one cell to 32,767 characters; full notes remain in the detail sheet.
    const tasks = allTasks.length > 32000 ? `${allTasks.slice(0, 32000)} … (full descriptions in Description details and Time entries)` : allTasks;
    bodyRow(daily, number, [serial(date),
      {formula: `SUMIF('Time entries'!$B$7:$B$${last},A${number},'Time entries'!$F$7:$F$${last})`, result: minutes / 1440},
      {formula: `ROUND(B${number}*1440,0)`, result: minutes}, tasks], 4);
    daily.getCell(number, 1).numFmt = DATE_FORMAT;
    daily.getCell(number, 2).numFmt = DURATION_FORMAT;
    daily.getCell(number, 3).numFmt = '0';
  }
  daily.autoFilter = {from: {row: 6, column: 1}, to: {row: 6 + dates.length, column: 4}};

  if (needsDetails) {
    const descriptions = workbook.addWorksheet('Description details');
    setupSheet(descriptions, `${job.name} · Descriptions · ${month}`, color, [16, 12, 12, 75, 40, 14], 6);
    note(descriptions, 2, 'Long text continues across rows. Entry ID and part numbers link each part to its work interval.', 6);
    note(descriptions, 3, 'Complete original descriptions are retained in Time entries. No work duration is added by these rows.', 6);
    header(descriptions, ['Date', 'Start', 'End', 'Description / activity', 'Entry ID', 'Part'], color);
    let number = FIRST_ROW;
    for (const row of rows) {
      const parts = descriptionParts(row.tasks, 75, MAX_VISIBLE_LINES);
      for (const [index, part] of parts.entries()) {
        bodyRow(descriptions, number, [serial(row.date), row.start / 1440, row.end / 1440, part.text, row.id, `${index + 1} / ${parts.length}`], 4);
        descriptions.getCell(number, 1).numFmt = DATE_FORMAT;
        for (const column of [2, 3]) descriptions.getCell(number, column).numFmt = '[h]:mm';
        textCell(descriptions.getCell(number, 5), row.id);
        textCell(descriptions.getCell(number, 6), `${index + 1} / ${parts.length}`);
        number++;
      }
    }
    descriptions.autoFilter = {from: {row: 6, column: 1}, to: {row: number - 1, column: 6}};
  }

  return {bytes: Buffer.from(await workbook.xlsx.writeBuffer()), filename: `${job.name}_${month}.xlsx`, totalMinutes};
}
