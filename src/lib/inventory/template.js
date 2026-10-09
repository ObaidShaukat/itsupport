// Inventory spreadsheets: column definitions for a records tab or Stock, and a builder that
// writes one or more data sheets plus an "Instructions" sheet and a hidden "Lists" sheet
// feeding the Excel dropdowns (dropdown fields, access toggles, Status, stock Category).
// Used by the single-tab templates (here) and the full workbook export (workbook.js).
const ExcelJS = require('exceljs');
const { FIELD_TYPES, STOCK_STATUSES, isSecret, listFields } = require('./fields');
const { listCategories } = require('./stock');
const { getPrefix, formatId } = require('./userids');
const { normHeader, EXAMPLE_MARK } = require('./import-files');

const ROWS = 1000; // rows that get the dropdown validation

const EXAMPLES = {
  text: 'Example', longtext: 'Longer text', email: 'jane.smith@example.com', phone: '07700 900123', number: '1',
  date: new Date(Date.UTC(2026, 0, 15)), link: 'https://example.com', password: 'type-the-password', pin: '1234', access: 'Yes',
};

const ALLOWED = {
  text: 'Any text', longtext: 'Any text (can be long)', email: 'An email address', phone: 'A phone number',
  number: 'A number', date: 'A date (e.g. 15/01/2026 or 2026-01-15)', link: 'A web address',
  password: 'Encrypted when imported; never shown in plain text afterwards', pin: 'Encrypted when imported',
  access: 'Yes / Done / Granted / Y / 1 / True = Granted; No / 0 / False = Not granted; empty = no change',
};

const RULES = [
  'One row per record. Columns can be left out or reordered: you match them up when importing.',
  'Rows marked "EXAMPLE (delete this row)" are examples: they are never imported. Replace them with real rows or leave them.',
  'Empty cells never change saved data (passwords and PINs included). To clear a value, type CLEAR.',
  'Records are matched (and updated, never duplicated) by: Employees User-ID (or Email), Writers Official-ID, Old Accounts Gmail-ID, Stock Serial / Asset number.',
];

const colLetter = (n) => {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

// Excel sheet names: max 31 characters, none of []:*?/\ , unique.
function sheetName(name, used) {
  const base = String(name || 'Sheet').replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Sheet';
  let out = base;
  for (let i = 2; used.has(out.toLowerCase()) || ['instructions', 'lists'].includes(out.toLowerCase()); i += 1) out = `${base.slice(0, 28)} ${i}`;
  used.add(out.toLowerCase());
  return out;
}

// sheets: [{ name, title, columns: [{ header, type, typeLabel, example, allowed, required, list }], rows: [[cell...]] }]
// A sheet with no rows gets one example row (in grey).
function buildBook(sheets) {
  const book = new ExcelJS.Workbook();
  book.creator = 'Cleartwo IT Support';
  const used = new Set();
  const named = sheets.map((s) => ({ ...s, sheet: book.addWorksheet(sheetName(s.name, used), { views: [{ state: 'frozen', ySplit: 1 }] }) }));
  const help = book.addWorksheet('Instructions');
  const lists = book.addWorksheet('Lists', { state: 'veryHidden' });
  let listCol = 0;

  for (const s of named) {
    const { sheet, columns } = s;
    sheet.addRow(columns.map((c) => c.header));
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF200D6C' } };
    if (s.rows && s.rows.length) {
      for (const r of s.rows) sheet.addRow(r);
    } else {
      sheet.addRow(columns.map((c) => c.example ?? ''));
      sheet.getRow(2).font = { italic: true, color: { argb: 'FF6E6E73' } };
    }
    const lastRow = Math.max(ROWS, sheet.rowCount + 200);
    columns.forEach((c, i) => {
      const col = sheet.getColumn(i + 1);
      col.width = c.width || Math.min(40, Math.max(12, c.header.length + 4));
      if (c.type === 'date') col.numFmt = 'dd/mm/yyyy';
      if (c.list && c.list.length) {
        listCol += 1;
        lists.getColumn(listCol).values = [c.header, ...c.list];
        const ref = `Lists!$${colLetter(listCol)}$2:$${colLetter(listCol)}$${c.list.length + 1}`;
        for (let r = 2; r <= lastRow; r += 1) {
          sheet.getCell(r, i + 1).dataValidation = {
            type: 'list', allowBlank: true, formulae: [ref], showErrorMessage: true,
            errorTitle: c.header, error: `Choose one of: ${c.list.slice(0, 12).join(', ')}${c.list.length > 12 ? '…' : ''}`,
          };
        }
      }
    });
  }

  help.addRow(['How to fill in this workbook']);
  help.getRow(1).font = { bold: true, size: 14, color: { argb: 'FF200D6C' } };
  for (const rule of RULES) help.addRow([rule]);
  for (const s of named) {
    help.addRow([]);
    const head = help.addRow([`Sheet "${s.sheet.name}"${s.title && s.title !== s.sheet.name ? ` (${s.title})` : ''}`]);
    head.font = { bold: true, size: 12, color: { argb: 'FF6741C3' } };
    const cols = help.addRow(['Column', 'Type', 'Allowed values', 'Required']);
    cols.font = { bold: true };
    for (const c of s.columns) help.addRow([c.header, c.typeLabel || FIELD_TYPES[c.type] || c.type, c.allowed || ALLOWED[c.type] || '', c.required ? 'Yes' : '']);
  }
  help.getColumn(1).width = 30;
  help.getColumn(2).width = 26;
  help.getColumn(3).width = 95;
  help.getColumn(4).width = 10;
  return book;
}

// Columns for a records tab. all: every field (workbook) or only visible ones (template).
// Each column keeps its field (or role 'status' / 'leaving') for filling in data.
async function recordsColumns(db, tab, { all = false } = {}) {
  const fields = (await listFields(db, { tabId: tab.id })).filter((f) => all || f.visible);
  const prefix = tab.kind === 'employees' ? await getPrefix(db) : null;
  const columns = fields.map((f) => {
    let example = EXAMPLES[f.field_type] ?? '';
    if (f.field_type === 'dropdown') example = f.optionList[0] || '';
    if (f.role === 'title') example = EXAMPLE_MARK;
    if (f.role === 'user_id') example = formatId(prefix, 1);
    const allowed = f.role === 'user_id'
      ? `${formatId(prefix, 1)} style (just the number works too). Leave empty to give the lowest free number. Used to match existing employees.`
      : f.field_type === 'dropdown' ? `One of: ${f.optionList.join(', ')}`
        : isSecret(f) ? `${ALLOWED[f.field_type]}. Exported blank unless "Include passwords" was ticked; blank never erases the saved one.` : undefined;
    return {
      field: f, header: f.label, type: f.field_type, example, allowed, required: f.required,
      list: f.field_type === 'dropdown' ? f.optionList : f.field_type === 'access' ? ['Yes', 'No'] : null,
    };
  });
  if (columns.length && !fields.some((f) => f.role === 'title')) columns[0].example = EXAMPLE_MARK;
  if (tab.kind === 'employees') {
    columns.push({ role: 'status', header: 'Status', type: 'dropdown', typeLabel: 'Status', example: 'Active', list: ['Active', 'Inactive'], allowed: 'Active or Inactive (Inactive = ex employee). Empty = Active for new employees (Inactive on the Ex Employees sheet), no change for existing ones.' });
    columns.push({ role: 'leaving', header: 'Leaving date', type: 'date', typeLabel: 'Date', example: '', allowed: 'For Inactive employees: the date they left.' });
  }
  return columns;
}

// Stock columns: core ones, then each category field label once (e.g. Device name for
// Laptop, Desktop and Mac). Each keeps its key ('category', ...) or the field label norm.
async function stockColumns(db, { all = false } = {}) {
  const cats = await listCategories(db, { withFields: true });
  const columns = [
    { key: 'category', header: 'Category', type: 'dropdown', typeLabel: 'Category', example: cats[0] ? cats[0].name : 'Laptop', list: cats.map((c) => c.name), required: true, allowed: `One of the categories (${cats.map((c) => c.name).join(', ')}). A new name creates a new category.` },
    { key: 'brand', header: 'Brand', type: 'text', example: 'Dell', allowed: 'Any text. New brands are added automatically.' },
    { key: 'model', header: 'Model', type: 'text', example: 'Latitude 5420', allowed: 'Any text. New models are added automatically.' },
    { key: 'serial', header: 'Serial / Asset number', type: 'text', example: EXAMPLE_MARK, allowed: 'Used to match items already in stock (updated, not duplicated). Must be unique in the file.' },
    { key: 'status', header: 'Status', type: 'dropdown', typeLabel: 'Status', example: 'Available', list: Object.values(STOCK_STATUSES), allowed: `One of: ${Object.values(STOCK_STATUSES).join(', ')}. Set automatically to Assigned when Assigned to names an active employee.` },
    { key: 'assigned', header: 'Assigned to', type: 'text', example: '', allowed: 'The employee\'s User-ID (matched first) or exact full name. Active: assigned to them. Ex employee: stays Available and goes on their Equipment held. No match: the row is skipped. CLEAR returns it to stock.' },
    { key: 'notes', header: 'Notes', type: 'longtext', example: '', allowed: 'Any text.' },
  ];
  const extras = new Map();
  for (const c of cats) {
    for (const f of c.fields.filter((x) => all || x.visible)) {
      const norm = normHeader(f.label);
      if (!extras.has(norm)) extras.set(norm, { field: f, cats: [] });
      extras.get(norm).cats.push(c.name);
    }
  }
  for (const [norm, { field, cats: names }] of extras) {
    columns.push({
      extraNorm: norm, header: field.label, type: field.field_type, example: '',
      list: field.field_type === 'dropdown' ? field.optionList : null,
      allowed: `${field.field_type === 'dropdown' ? `One of: ${field.optionList.join(', ')}. ` : `${ALLOWED[field.field_type] || ''}. `}Only for: ${names.join(', ')}.`,
    });
  }
  return columns;
}

// Single-tab templates (visible columns, one example row).
async function recordsTemplate(db, tab) {
  return buildBook([{ name: tab.name, title: tab.name, columns: await recordsColumns(db, tab) }]);
}
async function stockTemplate(db) {
  return buildBook([{ name: 'Stock', title: 'Stock', columns: await stockColumns(db) }]);
}

module.exports = { buildBook, recordsColumns, stockColumns, recordsTemplate, stockTemplate, sheetName };
