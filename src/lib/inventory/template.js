// Inventory import templates (.xlsx): a "Data" sheet with the tab's current fields as
// headers (current order) and one example row, an "Instructions" sheet describing every
// column, and a hidden "Lists" sheet feeding the Excel dropdowns (dropdown fields, access
// toggles, Status, stock Category).
const ExcelJS = require('exceljs');
const { FIELD_TYPES, STOCK_STATUSES, isSecret, listFields } = require('./fields');
const { listCategories } = require('./stock');
const { getPrefix, formatId } = require('./userids');
const { normHeader } = require('./import-files');

const ROWS = 1000; // rows that get the dropdown validation

const EXAMPLES = {
  text: 'Example', longtext: 'Longer text', email: 'jane.smith@example.com', phone: '07700 900123', number: '1',
  date: new Date(Date.UTC(2026, 0, 15)), link: 'https://example.com', password: 'type-the-password', pin: '1234', access: 'Yes',
};

const ALLOWED = {
  text: 'Any text', longtext: 'Any text (can be long)', email: 'An email address', phone: 'A phone number',
  number: 'A number', date: 'A date (e.g. 15/01/2026 or 2026-01-15)', link: 'A web address',
  password: 'Encrypted when imported; never shown in plain text afterwards', pin: 'Encrypted when imported',
  access: 'Yes / No (also Granted, Done, Y, 1, True = Granted; empty, No, 0, False = Not granted)',
};

const colLetter = (n) => {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
};

// columns: [{ header, type, example, allowed, required, list: [...] | null, width }]
async function buildWorkbook(title, columns) {
  const book = new ExcelJS.Workbook();
  book.creator = 'Cleartwo IT Support';
  const data = book.addWorksheet('Data', { views: [{ state: 'frozen', ySplit: 1 }] });
  const help = book.addWorksheet('Instructions');
  const lists = book.addWorksheet('Lists', { state: 'veryHidden' });

  data.addRow(columns.map((c) => c.header));
  data.addRow(columns.map((c) => c.example ?? ''));
  data.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  data.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF200D6C' } };
  data.getRow(2).font = { italic: true, color: { argb: 'FF6E6E73' } };
  columns.forEach((c, i) => {
    const col = data.getColumn(i + 1);
    col.width = c.width || Math.min(40, Math.max(12, c.header.length + 4));
    if (c.type === 'date') col.numFmt = 'dd/mm/yyyy';
    if (c.list && c.list.length) {
      lists.getColumn(i + 1).values = [c.header, ...c.list];
      const ref = `Lists!$${colLetter(i + 1)}$2:$${colLetter(i + 1)}$${c.list.length + 1}`;
      for (let r = 2; r <= ROWS; r += 1) {
        data.getCell(r, i + 1).dataValidation = {
          type: 'list', allowBlank: true, formulae: [ref], showErrorMessage: true,
          errorTitle: c.header, error: `Choose one of: ${c.list.slice(0, 12).join(', ')}${c.list.length > 12 ? '…' : ''}`,
        };
      }
    }
  });

  help.addRow([`${title}: how to fill in this template`]);
  help.getRow(1).font = { bold: true, size: 14, color: { argb: 'FF200D6C' } };
  help.addRow(['Fill in the Data sheet, one row per record. Replace or delete the example row (row 2). Columns can be left out or reordered; you match them up when importing.']);
  help.addRow([]);
  help.addRow(['Column', 'Type', 'Allowed values', 'Required']);
  help.getRow(4).font = { bold: true };
  for (const c of columns) help.addRow([c.header, c.typeLabel || FIELD_TYPES[c.type] || c.type, c.allowed || ALLOWED[c.type] || '', c.required ? 'Yes' : '']);
  help.getColumn(1).width = 28;
  help.getColumn(2).width = 26;
  help.getColumn(3).width = 90;
  help.getColumn(4).width = 10;
  return book;
}

// Records tab (Employees, Writers, Old Accounts, custom).
async function recordsTemplate(db, tab) {
  const fields = (await listFields(db, { tabId: tab.id })).filter((f) => f.visible);
  const prefix = tab.kind === 'employees' ? await getPrefix(db) : null;
  const columns = fields.map((f) => {
    let example = EXAMPLES[f.field_type] ?? '';
    if (f.field_type === 'dropdown') example = f.optionList[0] || '';
    if (f.role === 'title') example = tab.kind === 'employees' ? 'Jane Smith' : 'Example name';
    if (f.role === 'user_id') example = formatId(prefix, 1);
    const allowed = f.role === 'user_id'
      ? `${formatId(prefix, 1)} style (just the number works too). Leave empty to give the lowest free number. Used to match existing employees.`
      : f.field_type === 'dropdown' ? `One of: ${f.optionList.join(', ')}`
        : isSecret(f) ? ALLOWED[f.field_type] : undefined;
    return {
      header: f.label, type: f.field_type, example, allowed, required: f.required,
      list: f.field_type === 'dropdown' ? f.optionList : f.field_type === 'access' ? ['Yes', 'No'] : null,
    };
  });
  if (tab.kind === 'employees') {
    columns.push({ header: 'Status', type: 'dropdown', typeLabel: 'Status', example: 'Active', list: ['Active', 'Inactive'], allowed: 'Active or Inactive (Inactive = ex employee). Empty = Active for new employees.' });
    columns.push({ header: 'Leaving date', type: 'date', typeLabel: 'Date', example: '', allowed: 'For Inactive employees: the date they left.' });
  }
  return buildWorkbook(tab.name, columns);
}

async function stockTemplate(db) {
  const cats = await listCategories(db, { withFields: true });
  const columns = [
    { header: 'Category', type: 'dropdown', typeLabel: 'Category', example: cats[0] ? cats[0].name : 'Laptop', list: cats.map((c) => c.name), required: true, allowed: `One of the categories (${cats.map((c) => c.name).join(', ')}). A new name creates a new category.` },
    { header: 'Brand', type: 'text', example: 'Dell', allowed: 'Any text. New brands are added automatically.' },
    { header: 'Model', type: 'text', example: 'Latitude 5420', allowed: 'Any text. New models are added automatically.' },
    { header: 'Serial / Asset number', type: 'text', example: 'SN-12345', allowed: 'Used to match items already in stock (updated, not duplicated). Must be unique in the file.' },
    { header: 'Status', type: 'dropdown', typeLabel: 'Status', example: 'Available', list: Object.values(STOCK_STATUSES), allowed: `One of: ${Object.values(STOCK_STATUSES).join(', ')}. Set automatically to Assigned when Assigned to names an active employee.` },
    { header: 'Assigned to', type: 'text', example: '', allowed: 'The employee\'s User-ID (best) or full name. Active: the item is assigned to them. Ex employee: the item stays Available and goes on their Equipment held.' },
    { header: 'Notes', type: 'longtext', example: '', allowed: 'Any text.' },
  ];
  // Category extra fields, one column per label (e.g. Device name for Laptop, Desktop, Mac).
  const extras = new Map();
  for (const c of cats) {
    for (const f of c.fields.filter((x) => x.visible)) {
      const key = normHeader(f.label);
      if (!extras.has(key)) extras.set(key, { field: f, cats: [] });
      extras.get(key).cats.push(c.name);
    }
  }
  for (const { field, cats: names } of extras.values()) {
    columns.push({
      header: field.label, type: field.field_type,
      example: field.field_type === 'dropdown' ? '' : '',
      list: field.field_type === 'dropdown' ? field.optionList : null,
      allowed: `${field.field_type === 'dropdown' ? `One of: ${field.optionList.join(', ')}. ` : `${ALLOWED[field.field_type] || ''}. `}Only for: ${names.join(', ')}.`,
    });
  }
  return buildWorkbook('Stock', columns);
}

module.exports = { recordsTemplate, stockTemplate };
