// Default inventory tabs, fields and stock categories. Installed once by scripts/migrate.js
// (one-time step "inventory_v2_defaults"), so tabs or fields deleted later are not
// brought back. Works with any mysql2 connection (migrate uses its own).

// [label, type, { role, width, options, required }]
const EMPLOYEE_FIELDS = [
  ['User-ID', 'text', { role: 'user_id', width: 100 }],
  ['Name', 'text', { role: 'title', width: 170, required: true }],
  ['Email', 'email', { role: 'email', width: 210 }],
  ['Password', 'password', { width: 130 }],
  ['PIN', 'pin', { width: 100 }],
  ['Gmail-ID', 'email', { width: 200 }],
  ['Gmail Password', 'password', { width: 130 }],
  ['Mac Local User', 'text', { width: 130 }],
  ['Mac User Pass', 'password', { width: 130 }],
  ['Apple Cloud ID', 'email', { width: 200 }],
  ['Apple Cloud Password', 'password', { width: 140 }],
  ['1Password', 'access', { width: 110 }],
  ['Claude', 'access', { width: 100 }],
  ['Cleartwo@gmail.com', 'access', { width: 150 }],
  ['ChatGPT', 'access', { width: 100 }],
  ['Canva', 'access', { width: 100 }],
];
const WRITER_FIELDS = [
  ['User', 'text', { role: 'title', width: 170, required: true }],
  ['Official-ID', 'text', { width: 140 }],
  ['Password', 'password', { width: 130 }],
  ['Contact', 'phone', { width: 150 }],
  ['Gmail-ID', 'email', { width: 210 }],
  ['Gmail Password', 'password', { width: 130 }],
];
const OLD_ACCOUNT_FIELDS = [
  ['User', 'text', { role: 'title', width: 170, required: true }],
  ['Gmail-ID', 'email', { width: 220 }],
  ['Password', 'password', { width: 130 }],
  ['Status', 'dropdown', { width: 120, options: 'Active\nDeleted\nVerify' }],
];

// [name, kind, fields]
const TABS = [
  ['Employees', 'employees', EMPLOYEE_FIELDS],
  ['Stock', 'stock', null],
  ['Writers', 'records', WRITER_FIELDS],
  ['Ex Employees', 'ex_employees', null],
  ['Old Accounts', 'records', OLD_ACCOUNT_FIELDS],
];

const COMPUTER_FIELDS = [
  ['Device name', 'text', { width: 140 }],
  ['Wi-Fi MAC', 'text', { width: 150 }],
  ['Ethernet MAC', 'text', { width: 150 }],
  ['Specifications', 'longtext', { width: 220 }],
];
// [name, group_by, fields, group field label]
const CATEGORIES = [
  ['Laptop', 'platform', COMPUTER_FIELDS],
  ['Desktop', 'platform', COMPUTER_FIELDS],
  ['Mac', 'platform', COMPUTER_FIELDS],
  ['Monitor/LCD', 'none', []],
  ['Headphone', 'none', []],
  ['Keyboard', 'none', []],
  ['Mouse', 'field', [['Connection type', 'dropdown', { width: 130, options: 'Wired\nWireless' }]], 'Connection type'],
  ['Docking Station', 'none', []],
  ['USB Hub', 'none', []],
  ['Cables', 'none', []],
  ['Phone/VoIP', 'none', []],
  ['Tablet', 'none', []],
  ['Printer', 'none', []],
  ['Barcode Scanner', 'none', []],
  ['Networking', 'none', []],
  ['Other', 'none', []],
];

async function insertFields(conn, owner, fields) {
  const ids = {};
  for (const [i, [label, type, opts]] of fields.entries()) {
    const [r] = await conn.query(
      `INSERT INTO inventory_fields (tab_id, category_id, label, field_type, options, role, sort_order, required, width)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [owner.tabId || null, owner.categoryId || null, label, type, opts.options || null, opts.role || null, i,
        opts.required ? 1 : 0, opts.width || 160]
    );
    ids[label] = r.insertId;
  }
  return ids;
}

// Installs the defaults when there are no tabs / categories yet.
async function installDefaults(conn) {
  const [[{ tabs }]] = await conn.query('SELECT COUNT(*) AS tabs FROM inventory_tabs');
  if (!Number(tabs)) {
    for (const [i, [name, kind, fields]] of TABS.entries()) {
      const [r] = await conn.query('INSERT INTO inventory_tabs (kind, name, sort_order) VALUES (?, ?, ?)', [kind, name, i]);
      if (fields) await insertFields(conn, { tabId: r.insertId }, fields);
    }
  }
  const [[{ cats }]] = await conn.query('SELECT COUNT(*) AS cats FROM stock_categories');
  if (!Number(cats)) {
    for (const [i, [name, groupBy, fields, groupLabel]] of CATEGORIES.entries()) {
      const [r] = await conn.query('INSERT INTO stock_categories (name, group_by, sort_order) VALUES (?, ?, ?)', [name, groupBy, i]);
      const ids = await insertFields(conn, { categoryId: r.insertId }, fields);
      if (groupLabel) await conn.query('UPDATE stock_categories SET group_field_id = ? WHERE id = ?', [ids[groupLabel], r.insertId]);
    }
  }
}

module.exports = { installDefaults };
