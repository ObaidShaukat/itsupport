// Builds the data for views/inventory/_grid.ejs: columns (with each user's saved widths)
// and rows of cells. The browser adds search, sort, filter, CSV export, drag to reorder
// (field columns, saved for everyone) and drag to resize (saved per user); see the
// "Inventory grids" section of public/js/app.js.
const { displayText, isSecret } = require('./fields');

const SORT_TYPES = { number: 'number', date: 'date' };

// Columns for the visible fields of a tab / category. widths: { colKey: px } for this user.
function fieldColumns(fields, widths = {}) {
  return fields.filter((f) => f.visible).map((f) => {
    const key = `f${f.id}`;
    let filter = { type: 'text' };
    if (f.field_type === 'access') filter = { type: 'select', options: ['Granted', 'Not granted'] };
    else if (f.field_type === 'dropdown') filter = { type: 'select', options: f.optionList };
    else if (isSecret(f)) filter = { type: 'select', options: ['Set', 'Empty'] };
    return {
      key, label: f.label, width: widths[key] || f.width, fieldId: f.id, sort: SORT_TYPES[f.field_type] || 'text', filter,
      align: f.field_type === 'number' ? 'right' : '',
    };
  });
}

// A fixed (non-field) column, e.g. stock "Brand". key is saved as the width key.
const fixedColumn = (key, label, width, widths = {}, extra = {}) => ({
  key, label, width: widths[key] || width, sort: 'text', filter: { type: 'text' }, ...extra,
});

// Cells for one record's visible fields. Each cell: { kind, ... , sort, text }.
function fieldCells(fields, values, ownerId) {
  return fields.filter((f) => f.visible).map((f) => {
    const v = values.get(f.id);
    const text = displayText(f, v);
    const base = { field: f, value: v ? v.value : null, sort: text, text };
    if (isSecret(f)) return { ...base, kind: 'secret', recordId: ownerId, hasSecret: Boolean(v && v.hasSecret), sort: v && v.hasSecret ? 'Set' : 'Empty', filterText: v && v.hasSecret ? 'Set' : 'Empty', text: v && v.hasSecret ? '(hidden)' : '' };
    if (f.field_type === 'access') return { ...base, kind: 'access', granted: Boolean(v && v.value === 'granted') };
    return { ...base, kind: f.field_type };
  });
}

module.exports = { fieldColumns, fixedColumn, fieldCells };
