// One-time import of the inventory spreadsheet (Inventory > Import).
//
// SECURITY: any column whose header contains "pass" or "pin" (any case) is skipped
// before a single value in it is read, so passwords and PINs are never saved, logged
// or shown. Columns whose header looks like data (e.g. an email address) and columns
// with no header are never read either. Only the columns named in this file are used;
// other labelled columns are offered for mapping to a custom field in the preview.
//
// parseWorkbook() builds a plan (people, assets, stock, access, warnings) without
// touching the database; executePlan() writes it after the user confirms.
const ExcelJS = require('exceljs');
const { transaction } = require('../db');
const inv = require('./inventory');

const SECRET = inv.CREDENTIAL_HEADER;

// ---------- cell helpers ----------

function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (value.richText) return value.richText.map((r) => r.text).join('');
    if (value.text !== undefined) return String(value.text);
    if (value.result !== undefined) return String(value.result);
    if (value.hyperlink) return String(value.hyperlink).replace(/^mailto:/i, '');
    return '';
  }
  return String(value);
}
const clean = (t) => String(t || '').replace(/[ \t ]+/g, ' ').trim();
const lines = (t) => String(t || '').split(/\r?\n/).map(clean).filter(Boolean);
const headerKey = (h) => clean(h).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const looksLikeData = (h) => /@|^\d+([.,]\d+)?$/.test(clean(h)) || clean(h).length > 60;
const isYes = (t) => /^(yes|y|done|✓|✔|x)\b/i.test(clean(t));

// Reads a sheet's columns by header. Returns { headerRow, columns: [{ index, header, key }] }
// with secret / data-looking / empty headers removed (and recorded in the plan).
function readHeaders(ws, plan, { headerRow = null, expect = [] } = {}) {
  let row = headerRow;
  if (!row) {
    for (let r = 1; r <= Math.min(8, ws.rowCount); r++) {
      const keys = [];
      ws.getRow(r).eachCell({ includeEmpty: false }, (cell) => keys.push(headerKey(cellText(cell.value))));
      if (expect.some((e) => keys.includes(e))) { row = r; break; }
    }
  }
  if (!row) return { headerRow: null, columns: [] };
  const columns = [];
  ws.getRow(row).eachCell({ includeEmpty: false }, (cell, index) => {
    const header = clean(cellText(cell.value));
    if (!header) return;
    if (SECRET.test(header)) {
      plan.skippedColumns.push({ sheet: ws.name, header: `${header.slice(0, 2)}${'*'.repeat(Math.max(0, header.length - 2))}`, reason: 'looks like a password / PIN column' });
      return;
    }
    if (looksLikeData(header)) {
      plan.skippedColumns.push({ sheet: ws.name, header: `column ${index}`, reason: 'the header looks like data, not a column name' });
      return;
    }
    columns.push({ index, header, key: headerKey(header) });
  });
  return { headerRow: row, columns };
}

const col = (columns, ...keys) => columns.find((c) => keys.includes(c.key));
const get = (ws, r, c) => (c ? clean(cellText(ws.getRow(r).getCell(c.index).value)) : '');
const getRaw = (ws, r, c) => (c ? String(cellText(ws.getRow(r).getCell(c.index).value)) : '');

// ---------- domain guesses ----------

const BRANDS = ['HP', 'Dell', 'Lenovo', 'Apple', 'Asus', 'Acer', 'Microsoft', 'Samsung', 'Logitech', 'A4Tech', 'Plantronics',
  'Jabra', 'TP-Link', 'Yealink', 'Epson', 'Sunmi', 'Xiaomi', 'Redmi', 'Ugreen', 'Anker', 'Philips', 'LG', 'BenQ', 'ViewSonic'];
const BRAND_ALIASES = { 'logi tech': 'Logitech', logi: 'Logitech', 'a4 tech': 'A4Tech', a4tech: 'A4Tech', plantronic: 'Plantronics',
  'tp link': 'TP-Link', 'tp-link': 'TP-Link', mi: 'Xiaomi' };

function canonicalBrand(brand) {
  const low = clean(brand).toLowerCase();
  if (!low) return '';
  if (BRAND_ALIASES[low]) return BRAND_ALIASES[low];
  const known = BRANDS.find((b) => b.toLowerCase() === low);
  return known || clean(brand);
}

function splitBrand(text) {
  const t = clean(text);
  const low = t.toLowerCase();
  for (const [alias, brand] of Object.entries(BRAND_ALIASES)) {
    if (low === alias || low.startsWith(`${alias} `) || low.startsWith(`${alias}-`)) return { brand, model: clean(t.slice(alias.length).replace(/^[-\s]+/, '')) || t };
  }
  for (const brand of BRANDS) {
    if (low === brand.toLowerCase() || low.startsWith(`${brand.toLowerCase()} `) || low.startsWith(`${brand.toLowerCase()}-`)) {
      return { brand, model: clean(t.slice(brand.length).replace(/^[-\s]+/, '')) || t };
    }
  }
  return { brand: '', model: t };
}

// "HP EliteBook 840 G5-16 GB RAM-250 GB SSD-Core i7 8th" -> brand HP, model "EliteBook 840 G5".
function parseLaptopSpec(spec) {
  const first = clean(String(spec || '').split(/\s-\s|-(?=\s*\d+\s*(gb|tb))/i)[0]);
  const { brand, model } = splitBrand(first);
  return { brand, model: model || first };
}

const CATEGORY_RULES = [
  [/workstation/i, 'Workstation'], [/laptop|notebook|elitebook|zbook|thinkpad|latitude|macbook/i, 'Laptop'],
  [/desktop|\bpc\b|tower/i, 'Desktop'], [/lcd|led|monitor|screen|display/i, 'Monitor'],
  [/combo/i, 'Keyboard & Mouse Combo'], [/keyboard/i, 'Keyboard'], [/mouse ?pad/i, 'Mouse Pad'], [/mouse/i, 'Mouse'],
  [/head ?(phone|set)/i, 'Headset'], [/dock/i, 'Docking Station'], [/hub/i, 'USB Hub'], [/cable|otg|adapter|charger/i, 'Cables'],
  [/printer/i, 'Printer'], [/scanner|barcode/i, 'Barcode Scanner'], [/voip|land ?line|yealink|desk ?phone/i, 'Phone / VoIP Phone'],
  [/iphone|mobile|smart ?phone/i, 'Mobile Device'], [/tablet|ipad|\bpad\b|tab\b/i, 'Tablet'], [/android ?(tv )?box/i, 'Android Box'],
  [/raspberry|rasberry/i, 'Raspberry Pi'], [/payment|card reader/i, 'Payment Device'], [/switch/i, 'Smart Switch'],
  [/router|access point|firewall|network/i, 'Networking Equipment'], [/batter|lithium|cell/i, 'Batteries'],
  [/pillow|back ?support/i, 'Back Support / Pillow'],
];
const guessCategory = (text) => (CATEGORY_RULES.find(([re]) => re.test(text)) || [null, null])[1];

// Pulls "SN: ..." and "MAC: ..." lines out of a multi-line cell.
function serialAndMac(text) {
  const out = { serial: '', mac: '', rest: [] };
  for (const l of lines(text)) {
    const sn = /^s\/?n\s*[:#-]?\s*(.+)$/i.exec(l);
    const mac = /^mac\s*[:#-]?\s*(.+)$/i.exec(l);
    if (sn && !out.serial) out.serial = clean(sn[1]);
    else if (mac && !out.mac) out.mac = clean(mac[1]);
    else out.rest.push(l);
  }
  return out;
}

const COMPANY_BY_DOMAIN = { 'cleartwo.co.uk': 'Cleartwo', 'mydigitalpeople.com': 'My Digital People' };
const companyFor = (email) => COMPANY_BY_DOMAIN[String(email || '').split('@')[1]?.toLowerCase()] || '';

// ---------- plan building ----------

function newPlan(fileName) {
  return {
    fileName, people: {}, assets: [], stock: {}, access: [], warnings: [], skippedColumns: [], unknownColumns: [],
  };
}

function warn(plan, text) {
  if (!plan.warnings.includes(text)) plan.warnings.push(text);
}

// Collects similar notes (e.g. first-name matches) to report as one warning.
function note(plan, topic, item) {
  plan.notes = plan.notes || {};
  (plan.notes[topic] = plan.notes[topic] || []);
  if (!plan.notes[topic].includes(item)) plan.notes[topic].push(item);
}

function flushNotes(plan) {
  for (const [topic, items] of Object.entries(plan.notes || {})) {
    plan.warnings.push(`${topic} (${items.length}): ${items.join('; ')}.`);
  }
  delete plan.notes;
}

function addPerson(plan, name, details, source) {
  const key = inv.norm(name);
  if (!key) return null;
  const p = plan.people[key] || (plan.people[key] = { key, name: clean(name), email: '', team: '', company: '', phone: '', status: 'active', sources: [], extra: {} });
  if (!p.sources.includes(source)) p.sources.push(source);
  for (const k of ['email', 'team', 'company', 'phone']) if (details[k] && !p[k]) p[k] = details[k];
  if (details.status === 'left') {
    if (p.sources.some((s) => s !== 'Left') && p.status === 'active') {
      warn(plan, `${p.name} is on the Left sheet and also on an active sheet. Kept as active; check and mark as left if needed.`);
    } else p.status = 'left';
  }
  return key;
}

// Full name first; then a unique first-name match (with a warning); otherwise null.
function findPerson(plan, name, context) {
  const key = inv.norm(name);
  if (!key) return null;
  if (plan.people[key]) return key;
  const matches = Object.values(plan.people).filter((p) => p.key.split(' ')[0] === key.split(' ')[0] && key.split(' ').length === 1);
  if (matches.length === 1) {
    note(plan, 'Matched by first name only, check these', `"${clean(name)}" → ${matches[0].name} (${context.replace(/ row \d+$/, '')})`);
    return matches[0].key;
  }
  if (matches.length > 1) note(plan, 'Names matching more than one person (not assigned)', `"${clean(name)}" → ${matches.map((m) => m.name).join(' / ')}`);
  return null;
}

function addAsset(plan, asset) {
  if (asset.serial) {
    const existing = plan.assets.find((a) => a.serial && a.serial.toLowerCase() === asset.serial.toLowerCase());
    if (existing) {
      for (const [k, v] of Object.entries(asset)) if (v && !existing[k]) existing[k] = v;
      return existing;
    }
  }
  plan.assets.push(asset);
  return asset;
}

function stockKey(category, brand, model) {
  const stripped = String(model || '').replace(/\b(headphones?|headsets?|mouse|keyboard|lcd|hub|cable)\b/gi, ' ');
  return `${category}|${inv.norm(`${brand} ${stripped}`).replace(/[^a-z0-9 ]/g, '')}`;
}
function stockItem(plan, category, text, extra = {}) {
  const split = extra.brand !== undefined ? { brand: canonicalBrand(extra.brand), model: clean(text) } : splitBrand(text);
  const brand = canonicalBrand(split.brand);
  const model = split.model;
  const connection = /wireless/i.test(text) ? 'wireless' : (/wired/i.test(text) ? 'wired' : 'na');
  const cleanModel = clean(model.replace(/[-–]\s*(wireless|wired)\b/i, '').replace(/\b(wireless|wired)\b/i, '')) || model;
  const key = stockKey(category, brand, cleanModel);
  const conn = extra.connection || connection;
  const item = plan.stock[key] || (plan.stock[key] = { key, category, brand, model: cleanModel, connection: conn, location: '', total: 0, damaged: 0, assignments: [] });
  if (item.connection === 'na' && conn !== 'na') item.connection = conn;
  return item;
}
function assignStock(item, personKey, qty, notes) {
  const existing = item.assignments.find((a) => a.personKey === personKey);
  if (existing) return;
  item.assignments.push({ personKey, qty, notes: notes || '' });
  const assigned = item.assignments.reduce((n, a) => n + a.qty, 0);
  item.total = Math.max(item.total, assigned + item.damaged);
}

function addAccess(plan, personKey, app, username, status = 'active', notes = '') {
  if (!personKey || !app) return;
  const u = clean(username);
  if (plan.access.some((a) => a.personKey === personKey && a.app === app && a.username.toLowerCase() === u.toLowerCase())) return;
  plan.access.push({ personKey, app, username: u, status, notes });
}

function recordUnknown(plan, sheet, column, rows) {
  const id = `${sheet}:${column.index}`;
  if (!plan.unknownColumns.some((u) => u.id === id)) {
    plan.unknownColumns.push({ id, sheet, header: column.header, filled: rows });
  }
  return id;
}

// ---------- sheets ----------

function peopleSheet(ws, plan, team, status) {
  const { headerRow, columns } = readHeaders(ws, plan, { expect: ['user', 'official id'] });
  if (!headerRow) return warn(plan, `${ws.name}: could not find the header row; sheet skipped.`);
  const c = {
    user: col(columns, 'user'), email: col(columns, 'official id'), gmail: col(columns, 'gmail id'), outlook: col(columns, 'outlook id'),
    contact: col(columns, 'contact', 'phone'), serial: col(columns, 'serial number', 'device serial number'), device: col(columns, 'device name'),
    wifi: col(columns, 'wi fi mac', 'wifi mac'), eth: col(columns, 'ethernet mac'), spec: col(columns, 'specifications', 'sepcifications'),
    claude: col(columns, 'claude'), chatgpt: col(columns, 'chat gpt', 'chatgpt'), canva: col(columns, 'canva'),
    mac: col(columns, 'mac local user'), apple: col(columns, 'apple cloud id', 'apple id'),
  };
  const known = new Set(Object.values(c).filter(Boolean).map((x) => x.index));
  const unknown = columns.filter((x) => !known.has(x.index));

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const name = get(ws, r, c.user);
    if (!name) {
      const outlook = get(ws, r, c.outlook);
      if (outlook) note(plan, `${ws.name}: rows with an Outlook ID but no user name were skipped`, `row ${r}`);
      continue;
    }
    const email = get(ws, r, c.email);
    const key = addPerson(plan, name, { email, team, company: companyFor(email), phone: get(ws, r, c.contact), status }, ws.name);

    // Laptops: two values on separate lines are two laptops.
    const serials = lines(getRaw(ws, r, c.serial));
    const specs = lines(getRaw(ws, r, c.spec));
    const devices = lines(getRaw(ws, r, c.device));
    const wifis = lines(getRaw(ws, r, c.wifi));
    const eths = lines(getRaw(ws, r, c.eth));
    for (let i = 0; i < serials.length; i++) {
      const spec = specs[i] || specs[0] || '';
      const { brand, model } = parseLaptopSpec(spec);
      addAsset(plan, {
        source: ws.name, category: /workstation/i.test(spec) ? 'Workstation' : 'Laptop', brand, model, serial: serials[i],
        device_name: devices[i] || '', wifi_mac: wifis[i] || '', ethernet_mac: eths[i] || '', specifications: spec,
        status: status === 'left' ? 'spare' : 'in_use', personKey: status === 'left' ? null : key,
        previousPersonKey: status === 'left' ? key : null, sold_to: '', location: '', notes: '',
      });
    }
    if (!serials.length && specs.length) {
      const { brand, model } = parseLaptopSpec(specs[0]);
      addAsset(plan, {
        source: ws.name, category: /workstation/i.test(specs[0]) ? 'Workstation' : 'Laptop', brand, model, serial: '',
        device_name: devices[0] || '', wifi_mac: wifis[0] || '', ethernet_mac: eths[0] || '', specifications: specs[0],
        status: status === 'left' ? 'spare' : 'in_use', personKey: status === 'left' ? null : key,
        previousPersonKey: status === 'left' ? key : null, sold_to: '', location: '', notes: 'No serial number in the spreadsheet.',
      });
      note(plan, 'Laptops created without a serial number, add it when known', `${name} (${ws.name})`);
    }

    if (status !== 'left') {
      const gmail = get(ws, r, c.gmail);
      if (gmail && gmail.includes('@') && gmail.toLowerCase() !== email.toLowerCase()) addAccess(plan, key, 'Gmail', gmail);
      const outlook = get(ws, r, c.outlook);
      if (outlook && outlook.includes('@')) addAccess(plan, key, 'Outlook', outlook);
      if (isYes(get(ws, r, c.claude))) addAccess(plan, key, 'Claude', email);
      if (isYes(get(ws, r, c.chatgpt))) addAccess(plan, key, 'ChatGPT', email);
      if (isYes(get(ws, r, c.canva))) addAccess(plan, key, 'Canva', email);
      const macUser = get(ws, r, c.mac);
      if (macUser) addAccess(plan, key, 'Mac local user', macUser);
      const apple = get(ws, r, c.apple);
      if (apple) addAccess(plan, key, 'Apple ID', apple);
    }

    for (const u of unknown) {
      const v = get(ws, r, u);
      if (!v) continue;
      const id = recordUnknown(plan, ws.name, u, 0);
      plan.people[key].extra[id] = v;
      plan.unknownColumns.find((x) => x.id === id).filled++;
    }
  }
}

function soldSheet(ws, plan) {
  // No header row: column 1 serial, 2 model, 3 sold to.
  const first = headerKey(cellText(ws.getRow(1).getCell(1).value));
  const start = /serial/.test(first) ? 2 : 1;
  for (let r = start; r <= ws.rowCount; r++) {
    const serial = clean(cellText(ws.getRow(r).getCell(1).value));
    const modelText = clean(cellText(ws.getRow(r).getCell(2).value));
    const soldTo = clean(cellText(ws.getRow(r).getCell(3).value));
    if (!serial && !modelText) continue;
    if (!serial) { warn(plan, `Sold row ${r}: no serial number; skipped.`); continue; }
    const existing = plan.assets.find((a) => a.serial && a.serial.toLowerCase() === serial.toLowerCase());
    if (existing) {
      if (existing.personKey) warn(plan, `Sold: ${serial} is also assigned to ${plan.people[existing.personKey].name} on another sheet. Marked as sold and unassigned.`);
      Object.assign(existing, { status: 'sold', sold_to: soldTo, personKey: null });
    } else {
      const { brand, model } = parseLaptopSpec(modelText);
      const category = guessCategory(modelText) || 'Laptop';
      if (!guessCategory(modelText)) warn(plan, `Sold: ${serial} (${modelText || 'no model'}) imported as a laptop. Check the category.`);
      addAsset(plan, { source: 'Sold', category, brand, model, serial, device_name: '', wifi_mac: '', ethernet_mac: '',
        specifications: modelText, status: 'sold', personKey: null, previousPersonKey: null, sold_to: soldTo, location: '', notes: '' });
    }
  }
}

function userInventorySheet(ws, plan) {
  const { headerRow, columns } = readHeaders(ws, plan, { expect: ['laptop', 'lcd', 'mouse'] });
  if (!headerRow) return warn(plan, 'User Inventory: could not find the header row; sheet skipped.');
  const nameCol = columns.find((x) => x.key.startsWith('name')) || columns[0];
  const handled = new Set([nameCol.index]);
  const byKey = (re) => { const c = columns.find((x) => re.test(x.key)); if (c) handled.add(c.index); return c; };
  const c = {
    laptop: byKey(/^laptop/), lcd: byKey(/^(lcd|monitor)/), head: byKey(/^head ?(phone|set)/), mouse: byKey(/^mouse$/),
    keyboard: byKey(/^keyboard/), special: byKey(/^special/), hubs: byKey(/^hub/), android: byKey(/^android/),
    pad: byKey(/^mouse ?pad/), phones: byKey(/^phones?/), scanner: byKey(/barcode|barocde|scanner/), smart: byKey(/^smart switch/),
    payment: byKey(/^payment/), cell: byKey(/lithium|battery|cell/), pi: byKey(/raspberry|rasberry/), pillow: byKey(/pillow|back ?support/),
  };
  const unknown = columns.filter((x) => !handled.has(x.index));

  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const name = get(ws, r, nameCol);
    if (!name) continue;
    let key = findPerson(plan, name, 'User Inventory');
    if (!key) {
      key = addPerson(plan, name, {}, 'User Inventory');
      warn(plan, `User Inventory: ${clean(name)} is not on PK Team, Writers or Left. Added as a new person; set their team.`);
    }
    const who = plan.people[key].name;
    const assetFrom = (category, text, note) => {
      const { serial, mac, rest } = serialAndMac(text);
      const label = rest[0] || text;
      const { brand, model } = splitBrand(label);
      addAsset(plan, { source: 'User Inventory', category, brand, model: model.slice(0, 255), serial, device_name: '', wifi_mac: '',
        ethernet_mac: mac, specifications: '', status: 'in_use', personKey: key, previousPersonKey: null, sold_to: '', location: '',
        notes: [note, rest.length > 1 ? rest.slice(1).join('; ') : ''].filter(Boolean).join(' ') });
    };

    // Laptops come from PK Team / Writers / Left; here we only check.
    const laptop = get(ws, r, c.laptop);
    if (laptop && !plan.assets.some((a) => a.personKey === key && ['Laptop', 'Workstation'].includes(a.category))) {
      const { brand, model } = parseLaptopSpec(lines(laptop)[0]);
      addAsset(plan, { source: 'User Inventory', category: /workstation/i.test(laptop) ? 'Workstation' : 'Laptop', brand, model,
        serial: '', device_name: '', wifi_mac: '', ethernet_mac: '', specifications: lines(laptop)[0], status: 'in_use', personKey: key,
        previousPersonKey: null, sold_to: '', location: '', notes: 'From User Inventory; no serial number.' });
      note(plan, 'Laptops created without a serial number, add it when known', `${who} (User Inventory)`);
    }
    for (const l of lines(getRaw(ws, r, c.lcd))) assetFrom('Monitor', l.replace(/^(lcd|led|monitor)\s*/i, ''));
    for (const l of lines(getRaw(ws, r, c.head))) assignStock(stockItem(plan, 'Headset', l.replace(/^head ?(phone|set)s?\s*/i, '')), key, 1);
    for (const l of lines(getRaw(ws, r, c.mouse))) assignStock(stockItem(plan, /combo/i.test(l) ? 'Keyboard & Mouse Combo' : 'Mouse', l), key, 1);
    for (const l of lines(getRaw(ws, r, c.keyboard))) assignStock(stockItem(plan, /combo/i.test(l) ? 'Keyboard & Mouse Combo' : 'Keyboard', l), key, 1);
    for (const l of lines(getRaw(ws, r, c.hubs))) assignStock(stockItem(plan, 'USB Hub', l), key, 1);
    for (const l of lines(getRaw(ws, r, c.special))) {
      const cat = guessCategory(l);
      if (cat === 'Tablet') assetFrom('Tablet', l);
      else if (cat === 'Cables' || /cable/i.test(l)) {
        const n = Number((/^(\d+)\s/.exec(l) || [])[1]) || 1;
        assignStock(stockItem(plan, 'Cables', l.replace(/^\d+\s+/, '')), key, n);
      } else {
        assignStock(stockItem(plan, 'Other', l), key, 1);
        warn(plan, `User Inventory: "${l.slice(0, 60)}" for ${who} imported as Other stock. Check the category.`);
      }
    }
    const android = getRaw(ws, r, c.android);
    if (clean(android)) {
      assetFrom('Android Box', android);
      warn(plan, `User Inventory: the Android Box entry for ${who} lists several devices in one cell. Imported as one asset; check it.`);
    }
    if (isYes(get(ws, r, c.pad))) assignStock(stockItem(plan, 'Mouse Pad', 'Mouse pad'), key, 1);
    for (const l of lines(getRaw(ws, r, c.phones))) {
      if (/&/.test(l)) warn(plan, `User Inventory: "${l.slice(0, 60)}" for ${who} may be more than one device. Imported as one; check it.`);
      assetFrom(/iphone|mobile|samsung/i.test(l) ? 'Mobile Device' : 'Phone / VoIP Phone', l);
    }
    for (const l of lines(getRaw(ws, r, c.scanner))) assetFrom(/printer/i.test(l) ? 'Printer' : 'Barcode Scanner', l);
    const smart = getRaw(ws, r, c.smart);
    if (clean(smart)) assetFrom('Smart Switch', smart);
    const pay = getRaw(ws, r, c.payment);
    if (clean(pay)) assetFrom('Payment Device', pay);
    const pi = get(ws, r, c.pi);
    if (pi) assetFrom('Raspberry Pi', pi);
    const cell = get(ws, r, c.cell);
    if (cell) {
      const n = Number((/(\d+)/.exec(cell) || [])[1]) || 1;
      assignStock(stockItem(plan, 'Batteries', 'Rechargeable lithium cell'), key, n, isYes(cell) && cell.length < 4 ? '' : cell);
    }
    const pillow = get(ws, r, c.pillow);
    if (pillow) assignStock(stockItem(plan, 'Back Support / Pillow', 'Back support / pillow'), key, 1, isYes(pillow) && pillow.length < 4 ? '' : pillow);

    for (const u of unknown) {
      const v = get(ws, r, u);
      if (!v) continue;
      const id = recordUnknown(plan, ws.name, u, 0);
      plan.people[key].extra[id] = v;
      plan.unknownColumns.find((x) => x.id === id).filled++;
    }
  }
}

function inventorySheet(ws, plan) {
  const { headerRow, columns } = readHeaders(ws, plan, { expect: ['type', 'model', 'quantity'] });
  if (!headerRow) return warn(plan, 'Inventory: could not find the header row; sheet skipped.');
  const type = col(columns, 'type');
  const modelCol = col(columns, 'model');
  const qtyCol = col(columns, 'quantity', 'qty');
  const userCols = columns.filter((x) => x.key === 'user');
  let mModel = modelCol;
  let mQty = qtyCol;
  let section = '';
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const typeText = lines(getRaw(ws, r, type))[0] || '';
    // A second table inside the sheet ("IT ROOM EQUIPMENTS" + its own "Type / Quantity" header).
    const rowCells = [];
    ws.getRow(r).eachCell({ includeEmpty: false }, (cell, index) => rowCells.push({ index, key: headerKey(cellText(cell.value)) }));
    if (headerKey(typeText) === 'type') {
      const q = rowCells.find((x) => x.key === 'quantity');
      mQty = q ? { index: q.index } : qtyCol;
      mModel = null;
      continue;
    }
    if (rowCells.length === 1 || (rowCells.length && rowCells.every((x) => x.key === headerKey(typeText)))) {
      section = typeText;
      continue;
    }
    const model = get(ws, r, mModel);
    const qty = Number.parseInt(get(ws, r, mQty), 10) || 0;
    if (!typeText && !model) continue;
    if (lines(getRaw(ws, r, type)).length > 1) note(plan, 'Inventory: Type cells with several lines (first line used)', `row ${r}: ${typeText}`);
    let category = guessCategory(typeText) || guessCategory(model);
    if (!category) {
      category = 'Other';
      note(plan, 'Inventory: imported as Other stock, set the right category', `${clean(`${typeText} ${model}`)}${section ? ` (${section})` : ''}`);
    }
    const holders = [];
    for (const u of userCols) {
      const h = get(ws, r, u);
      if (!h) continue;
      const m = /^(.*?)\s*\((\d+)\)$/.exec(h);
      for (let i = 0; i < (m ? Number(m[2]) : 1); i++) holders.push(m ? clean(m[1]) : h);
    }
    const office = holders.filter((h) => /^office$/i.test(h)).length;
    const named = holders.filter((h) => !/^office$/i.test(h));
    const kind = ['Monitor', 'Workstation', 'Laptop', 'Desktop', 'Printer', 'Barcode Scanner', 'Phone / VoIP Phone', 'Mobile Device',
      'Tablet', 'Android Box', 'Raspberry Pi', 'Payment Device', 'Smart Switch', 'Networking Equipment'].includes(category) ? 'asset' : 'stock';

    if (kind === 'stock') {
      const item = stockItem(plan, category, model || typeText);
      item.total = Math.max(item.total, qty);
      if (office) item.location = 'Office';
      for (const h of named) {
        const key = findPerson(plan, h, `Inventory row ${r}`);
        if (key) assignStock(item, key, 1);
        else note(plan, 'Inventory: names not matched to a person (items not assigned)', `"${h}" (${model || typeText})`);
      }
      const assigned = item.assignments.reduce((n, a) => n + a.qty, 0);
      if (qty && assigned + item.damaged > qty) warn(plan, `Inventory: ${category} ${model} has quantity ${qty} but ${assigned} assigned; total raised to ${assigned + item.damaged}.`);
    } else {
      // People's own monitors etc. come from User Inventory. Here: spares and anyone missing.
      let remaining = qty || holders.length;
      for (const h of named) {
        const key = findPerson(plan, h, `Inventory row ${r}`);
        remaining--;
        if (!key) { note(plan, 'Inventory: names not matched to a person (items not created)', `"${h}" (${model || typeText})`); continue; }
        if (!plan.assets.some((a) => a.personKey === key && a.category === category)) {
          const { brand, model: m } = splitBrand(model);
          addAsset(plan, { source: 'Inventory', category, brand, model: m, serial: '', device_name: '', wifi_mac: '', ethernet_mac: '',
            specifications: '', status: 'in_use', personKey: key, previousPersonKey: null, sold_to: '', location: '', notes: '' });
        }
      }
      for (let i = 0; i < Math.max(0, remaining); i++) {
        const { brand, model: m } = splitBrand(model);
        addAsset(plan, { source: 'Inventory', category, brand, model: m, serial: '', device_name: '', wifi_mac: '', ethernet_mac: '',
          specifications: '', status: 'spare', personKey: null, previousPersonKey: null, sold_to: '', location: office ? 'Office' : '', notes: '' });
      }
    }
  }
}

function damagedSheet(ws, plan) {
  const { headerRow, columns } = readHeaders(ws, plan, { expect: ['category'] });
  if (!headerRow) return warn(plan, 'Demage: could not find the header row; sheet skipped.');
  const c = { cat: col(columns, 'category'), brand: col(columns, 'brand'), model: col(columns, 'model description', 'model'),
    conn: col(columns, 'connection type'), qty: col(columns, 'quantity', 'qty') };
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const catText = get(ws, r, c.cat);
    const qty = Number.parseInt(get(ws, r, c.qty), 10) || 0;
    if (!catText || !qty) continue;
    const rowText = [catText, get(ws, r, c.brand), get(ws, r, c.model)].join(' ');
    if (/\b(sub ?total|grand total|total)\b/i.test(rowText)) continue;
    const brandRaw = get(ws, r, c.brand);
    const brand = /^(-|other.*|unbranded|n\/?a)$/i.test(brandRaw) ? '' : brandRaw;
    let model = get(ws, r, c.model).replace(/^\(model:\s*|\)$/gi, '');
    if (/^(-|unspecified)$/i.test(model)) model = '';
    if (brand && model.toLowerCase().startsWith(brand.toLowerCase())) model = clean(model.slice(brand.length));
    const category = guessCategory(`${catText} ${model}`) || 'Other';
    const connText = get(ws, r, c.conn);
    const connection = /wireless/i.test(connText) ? 'wireless' : (/wired/i.test(connText) ? 'wired' : 'na');
    const item = stockItem(plan, category, model || `${catText} (unspecified)`, { brand, connection });
    item.damaged += qty;
    const assigned = item.assignments.reduce((n, a) => n + a.qty, 0);
    item.total = Math.max(item.total, assigned + item.damaged);
  }
}

function oldGmailSheet(ws, plan) {
  // Only User, Gmail-ID and Status are read. Unlabelled columns beside them are ignored.
  const { headerRow, columns } = readHeaders(ws, plan, { expect: ['gmail id'] });
  if (!headerRow) return warn(plan, 'Old Gmail: could not find the header row; sheet skipped.');
  const user = col(columns, 'user');
  const gmail = col(columns, 'gmail id');
  const status = col(columns, 'status');
  const others = new Set();
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const name = get(ws, r, user);
    const id = get(ws, r, gmail);
    if (!name || !id) continue;
    const key = findPerson(plan, name, 'Old Gmail');
    if (!key) { warn(plan, `Old Gmail: no person called "${name}"; their Gmail entry was skipped.`); continue; }
    const s = get(ws, r, status);
    let st = 'active';
    let note = '';
    if (/deleted|removed/i.test(s)) st = 'removed';
    else if (s && !/in use|active/i.test(s)) { note = `Sheet status: ${s}`; others.add(s); }
    addAccess(plan, key, 'Gmail', id, st, note);
  }
  plan.skippedColumns.push({ sheet: 'Old Gmail', header: 'all columns except User, Gmail-ID and Status', reason: 'not part of the import (may contain credentials)' });
  if (others.size) warn(plan, `Old Gmail: statuses ${[...others].map((o) => `"${o}"`).join(', ')} were imported as Active with a note. Review them.`);
}

const SHEETS_IGNORED = ['inventory breakdown', 'service accounts'];

async function parseWorkbook(filePath, fileName) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const plan = newPlan(fileName);
  const sheet = (name) => wb.worksheets.find((w) => w.name.trim().toLowerCase() === name);

  // Order matters: people first, so later sheets can match them by name.
  const pk = sheet('pk team'); if (pk) peopleSheet(pk, plan, 'PK Team', 'active'); else warn(plan, 'No "PK Team" sheet found.');
  const writers = sheet('writers'); if (writers) peopleSheet(writers, plan, 'Writers', 'active');
  const left = sheet('left'); if (left) peopleSheet(left, plan, '', 'left');
  const sold = sheet('sold'); if (sold) soldSheet(sold, plan);
  const ui = sheet('user inventory'); if (ui) userInventorySheet(ui, plan);
  const invSheet = sheet('inventory'); if (invSheet) inventorySheet(invSheet, plan);
  const dmg = sheet('demage') || sheet('damage'); if (dmg) damagedSheet(dmg, plan);
  const old = sheet('old gmail'); if (old) oldGmailSheet(old, plan);

  const known = ['pk team', 'writers', 'left', 'sold', 'user inventory', 'inventory', 'demage', 'damage', 'old gmail', ...SHEETS_IGNORED];
  for (const ws of wb.worksheets) {
    const n = ws.name.trim().toLowerCase();
    if (SHEETS_IGNORED.includes(n)) plan.skippedColumns.push({ sheet: ws.name, header: 'whole sheet', reason: 'ignored (duplicate of other sheets)' });
    else if (!known.includes(n)) warn(plan, `Sheet "${ws.name}" is not part of the import and was ignored.`);
  }
  flushNotes(plan);
  return plan;
}

// ---------- executing the plan ----------

async function getOrCreate(conn, table, name, extra = {}) {
  if (!name) return null;
  const [[row]] = await conn.query(`SELECT id FROM ${table} WHERE name = ?`, [name]);
  if (row) return row.id;
  const cols = ['name', ...Object.keys(extra)];
  const [r] = await conn.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, [name, ...Object.values(extra)]);
  return r.insertId;
}

const CATEGORY_KIND = (name) => (['Keyboard', 'Mouse', 'Keyboard & Mouse Combo', 'Headset', 'Docking Station', 'USB Hub', 'Cables',
  'Batteries', 'Mouse Pad', 'Back Support / Pillow', 'Other'].includes(name) ? 'stock' : 'asset');

// mappings: { [unknownColumnId]: 'skip' | 'new' | '<custom field id>' }
async function executePlan(plan, mappings, user) {
  return transaction(async (conn) => {
    const counts = { people: 0, peopleUpdated: 0, assets: 0, assetsUpdated: 0, stock: 0, stockAssignments: 0, access: 0, fields: 0 };
    const personIds = {};

    // People (matched by name against existing records too).
    for (const p of Object.values(plan.people)) {
      const companyId = await getOrCreate(conn, 'inv_companies', p.company);
      const teamId = await getOrCreate(conn, 'inv_teams', p.team);
      const [[existing]] = await conn.query('SELECT * FROM inv_people WHERE LOWER(name) = LOWER(?) LIMIT 1', [p.name]);
      if (existing) {
        await conn.query(`
          UPDATE inv_people SET email = COALESCE(email, ?), company_id = COALESCE(company_id, ?), team_id = COALESCE(team_id, ?),
            phone = COALESCE(phone, ?), updated_by = ? WHERE id = ?
        `, [p.email || null, companyId, teamId, p.phone || null, user.id, existing.id]);
        personIds[p.key] = existing.id;
        counts.peopleUpdated++;
      } else {
        const [r] = await conn.query(`
          INSERT INTO inv_people (name, email, company_id, team_id, phone, status, notes, created_by, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [p.name, p.email || null, companyId, teamId, p.phone || null, p.status, 'Imported from the inventory spreadsheet.', user.id, user.id]);
        personIds[p.key] = r.insertId;
        counts.people++;
      }
    }

    // Unknown columns mapped to custom fields on people.
    const fieldFor = {};
    for (const u of plan.unknownColumns) {
      const choice = mappings[u.id];
      if (!choice || choice === 'skip') continue;
      if (SECRET.test(u.header)) continue; // never, even if asked
      if (choice === 'new') {
        const [[{ next }]] = await conn.query("SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM custom_fields WHERE entity_type = 'person'");
        const [r] = await conn.query(
          "INSERT INTO custom_fields (label, entity_type, field_type, show_in_list, sort_order) VALUES (?, 'person', 'text', 0, ?)",
          [u.header.slice(0, 100), Number(next)]
        );
        fieldFor[u.id] = r.insertId;
        counts.fields++;
      } else {
        const [[f]] = await conn.query("SELECT id FROM custom_fields WHERE id = ? AND entity_type = 'person'", [Number(choice)]);
        if (f) fieldFor[u.id] = f.id;
      }
    }
    for (const p of Object.values(plan.people)) {
      for (const [colId, value] of Object.entries(p.extra)) {
        const fieldId = fieldFor[colId];
        if (!fieldId) continue;
        await conn.query(`
          INSERT INTO custom_field_values (field_id, entity_type, entity_id, value) VALUES (?, 'person', ?, ?)
          ON DUPLICATE KEY UPDATE value = VALUES(value)
        `, [fieldId, personIds[p.key], String(value).slice(0, 1000)]);
      }
    }

    // Assets (matched by serial number against existing records).
    for (const a of plan.assets) {
      const categoryId = await getOrCreate(conn, 'inv_categories', a.category, { kind: CATEGORY_KIND(a.category) });
      const personId = a.personKey ? personIds[a.personKey] : null;
      let existing = null;
      if (a.serial) [[existing]] = await conn.query('SELECT * FROM inv_assets WHERE serial_number = ? LIMIT 1', [a.serial]);
      if (existing) {
        await conn.query(`
          UPDATE inv_assets SET brand = COALESCE(brand, ?), model = COALESCE(model, ?), device_name = COALESCE(device_name, ?),
            wifi_mac = COALESCE(wifi_mac, ?), ethernet_mac = COALESCE(ethernet_mac, ?), specifications = COALESCE(specifications, ?),
            sold_to = COALESCE(sold_to, ?), status = IF(? = 'sold', 'sold', status), updated_by = ? WHERE id = ?
        `, [a.brand || null, a.model || null, a.device_name || null, a.wifi_mac || null, a.ethernet_mac || null, a.specifications || null,
          a.sold_to || null, a.status, user.id, existing.id]);
        counts.assetsUpdated++;
        continue;
      }
      const tag = await inv.nextAssetTag(conn);
      const status = personId ? 'in_use' : (a.status === 'in_use' ? 'spare' : a.status);
      const [r] = await conn.query(`
        INSERT INTO inv_assets (asset_tag, category_id, brand, model, serial_number, device_name, wifi_mac, ethernet_mac, specifications,
          location, status, person_id, sold_to, notes, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [tag, categoryId, a.brand || null, (a.model || '').slice(0, 255) || null, a.serial || null, a.device_name || null,
        a.wifi_mac || null, a.ethernet_mac || null, a.specifications || null, a.location || null, status, personId,
        a.sold_to || null, a.notes || null, user.id, user.id]);
      counts.assets++;
      if (personId) {
        await conn.query('INSERT INTO inv_asset_assignments (asset_id, person_id, person_name, notes, created_by) VALUES (?, ?, ?, ?, ?)',
          [r.insertId, personId, plan.people[a.personKey].name, 'Imported', user.id]);
      } else if (a.previousPersonKey) {
        // Laptops of people who left: keep who had it in the history.
        await conn.query('INSERT INTO inv_asset_assignments (asset_id, person_id, person_name, assigned_until, notes, created_by) VALUES (?, ?, ?, CURDATE(), ?, ?)',
          [r.insertId, personIds[a.previousPersonKey], plan.people[a.previousPersonKey].name, 'Imported from the Left sheet', user.id]);
      }
    }

    // Stock (matched by category + brand + model against existing records).
    for (const s of Object.values(plan.stock)) {
      const categoryId = await getOrCreate(conn, 'inv_categories', s.category, { kind: CATEGORY_KIND(s.category) });
      const [[existing]] = await conn.query(
        "SELECT id, total_qty, damaged_qty FROM inv_stock WHERE category_id <=> ? AND COALESCE(brand, '') = ? AND model = ? LIMIT 1",
        [categoryId, s.brand || '', s.model]
      );
      let stockId;
      if (existing) {
        stockId = existing.id;
        await conn.query('UPDATE inv_stock SET total_qty = GREATEST(total_qty, ?), damaged_qty = GREATEST(damaged_qty, ?), updated_by = ? WHERE id = ?',
          [s.total, s.damaged, user.id, stockId]);
      } else {
        const [r] = await conn.query(`
          INSERT INTO inv_stock (category_id, brand, model, connection, location, total_qty, damaged_qty, created_by, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [categoryId, s.brand || null, s.model.slice(0, 255), s.connection, s.location || null, s.total, s.damaged, user.id, user.id]);
        stockId = r.insertId;
        counts.stock++;
      }
      for (const a of s.assignments) {
        const personId = personIds[a.personKey];
        const [[dupe]] = await conn.query('SELECT id FROM inv_stock_assignments WHERE stock_id = ? AND person_id = ? AND returned_at IS NULL', [stockId, personId]);
        if (dupe) continue;
        await conn.query('INSERT INTO inv_stock_assignments (stock_id, person_id, quantity, notes, created_by) VALUES (?, ?, ?, ?, ?)',
          [stockId, personId, a.qty, a.notes ? a.notes.slice(0, 255) : 'Imported', user.id]);
        counts.stockAssignments++;
      }
    }

    // Access entries (never with passwords).
    for (const a of plan.access) {
      const appId = await getOrCreate(conn, 'inv_apps', a.app);
      const personId = personIds[a.personKey];
      const [[dupe]] = await conn.query('SELECT id FROM inv_access WHERE person_id = ? AND app_id = ? AND COALESCE(username, \'\') = ?', [personId, appId, a.username]);
      if (dupe) continue;
      await conn.query(`
        INSERT INTO inv_access (person_id, app_id, username, status, removed_date, notes, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `, [personId, appId, a.username || null, a.status, null, a.notes || 'Imported', user.id, user.id]);
      counts.access++;
    }

    await inv.logInv(conn, user, { type: 'inv_setting', action: 'created', subject: 'Inventory import',
      summary: `Imported ${plan.fileName}: ${counts.people} people added (${counts.peopleUpdated} matched), ${counts.assets} assets added `
        + `(${counts.assetsUpdated} matched by serial), ${counts.stock} stock items, ${counts.stockAssignments} stock assignments, `
        + `${counts.access} access entries, ${counts.fields} new custom fields.` });
    return counts;
  });
}

// Summary for the preview page.
function planSummary(plan) {
  const people = Object.values(plan.people);
  return {
    people: people.length,
    left: people.filter((p) => p.status === 'left').length,
    assets: plan.assets.length,
    assigned: plan.assets.filter((a) => a.personKey).length,
    sold: plan.assets.filter((a) => a.status === 'sold').length,
    stock: Object.keys(plan.stock).length,
    stockAssignments: Object.values(plan.stock).reduce((n, s) => n + s.assignments.length, 0),
    access: plan.access.length,
  };
}

module.exports = { parseWorkbook, executePlan, planSummary };
