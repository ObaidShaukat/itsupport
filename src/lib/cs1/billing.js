// Call Switch One monthly call charges: settings (margin, minimum), months (cs1_runs) and
// their lines (cs1_lines), customer names (cs1_customers), the review data, the Excel
// file and the email. Money stays exact (BigInt pennies / 1e-8 units, see parse.js).
const ExcelJS = require('exceljs');
const { pool } = require('../../db');
const { logActivity } = require('../activity');
const {
  toUnits, unitsToDecimal, chargePennies, penniesOf, money, pounds,
} = require('./parse');
const { normaliseId } = require('./api');

const DEFAULTS = { margin: '30', minimum: '1.00', email_to: '', email_cc: '' };

async function getSettings(db = pool) {
  const [rows] = await db.query('SELECT name, value FROM cs1_settings');
  const out = { ...DEFAULTS };
  for (const r of rows) if (r.value !== null) out[r.name] = r.value;
  return out;
}
const saveSetting = (db, name, value) => db.query(
  'INSERT INTO cs1_settings (name, value) VALUES (?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value)', [name, value]
);

// "2026-09" -> "2026-09-01"; month labels "September 2026".
const monthStart = (ym) => (/^\d{4}-(0[1-9]|1[0-2])$/.test(String(ym)) ? `${ym}-01` : null);
const monthLabel = (date) => {
  const d = new Date(`${String(date).slice(0, 7)}-15T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
// The last 18 months, newest first, as { value: "2026-09", label }; default last month.
function monthChoices(today) {
  const [y, m] = today.split('-').map(Number);
  const out = [];
  for (let i = 1; i <= 18; i += 1) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    const value = d.toISOString().slice(0, 7);
    out.push({ value, label: monthLabel(value) });
  }
  return out;
}

const logCs1 = (db, user, entry) => logActivity(db, user, { type: 'cs1', subject: 'Call Switch One', ...entry });

// Stores a parsed file as the month's calculation (replacing an existing one).
async function saveRun(conn, user, { month, fileName, parsed, settings, replaceId }) {
  if (replaceId) await conn.query('DELETE FROM cs1_runs WHERE id = ?', [replaceId]);
  const [r] = await conn.query(`
    INSERT INTO cs1_runs (billing_month, file_name, row_count, raw_total, ignored_rows, ignored_total, margin, minimum, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [month, fileName, parsed.rows, unitsToDecimal(parsed.rawTotal + parsed.blankTotal), parsed.blankRows, unitsToDecimal(parsed.blankTotal),
    settings.margin, settings.minimum, user.id]);
  const lines = [...parsed.totals].map(([identifier, units]) => [r.insertId, identifier.slice(0, 191), normaliseId(identifier) || null, unitsToDecimal(units), money(chargePennies(units, settings.margin))]);
  for (let i = 0; i < lines.length; i += 500) {
    await conn.query('INSERT INTO cs1_lines (run_id, identifier, customer_key, cost, charge) VALUES ?', [lines.slice(i, i + 500)]);
  }
  return r.insertId;
}

// Re-matches the lines of every saved month to customers: customer_key = the normalised
// CS1 ID (normaliseId), so CS1-001234, 1234 and cs1 1234 all find the same customer. Run after
// each sync, each customer change and once by migrate. Unsent months then show the new
// companies; sent months keep the names they were sent with (name_snapshot).
// Returns { keys, newlyMatched, months, unknown } (months = months with a line that gained a
// company; unknown = lines still without one).
const UNKNOWN_LINES_SQL = `
  SELECT l.id, l.run_id FROM cs1_lines l
  LEFT JOIN cs1_customers c ON c.identifier = COALESCE(l.customer_key, l.identifier) AND TRIM(c.name) <> ''
  WHERE c.id IS NULL`;

// before: unknownLines() taken earlier (e.g. at the start of a sync), so lines matched by
// customer changes made since then count too.
const unknownLines = async (conn) => (await conn.query(UNKNOWN_LINES_SQL))[0];

async function rematchLines(conn, before = null) {
  if (!before) before = await unknownLines(conn);
  const [ids] = await conn.query('SELECT DISTINCT identifier, customer_key FROM cs1_lines');
  let keys = 0;
  for (const row of ids) {
    const key = normaliseId(row.identifier) || null;
    if (key !== row.customer_key) {
      await conn.query('UPDATE cs1_lines SET customer_key = ? WHERE identifier = ?', [key, row.identifier]);
      keys += 1;
    }
  }
  const [after] = await conn.query(UNKNOWN_LINES_SQL);
  const stillUnknown = new Set(after.map((l) => l.id));
  const gained = before.filter((l) => !stillUnknown.has(l.id));
  return { keys, newlyMatched: gained.length, months: new Set(gained.map((l) => l.run_id)).size, unknown: after.length };
}

// Recalculates every line's charge with the current margin (overrides are kept).
async function recalculate(conn, run, settings) {
  const [lines] = await conn.query('SELECT id, cost FROM cs1_lines WHERE run_id = ?', [run.id]);
  for (const l of lines) await conn.query('UPDATE cs1_lines SET charge = ? WHERE id = ?', [money(chargePennies(toUnits(l.cost), settings.margin)), l.id]);
  await conn.query('UPDATE cs1_runs SET margin = ?, minimum = ? WHERE id = ?', [settings.margin, settings.minimum, run.id]);
}

async function getRun(db, id) {
  const [[run]] = await db.query(`
    SELECT r.*, COALESCE(NULLIF(u.display_name, ''), u.username) AS uploaded_name, COALESCE(NULLIF(s.display_name, ''), s.username) AS sent_name
    FROM cs1_runs r LEFT JOIN users u ON u.id = r.uploaded_by LEFT JOIN users s ON s.id = r.sent_by WHERE r.id = ?
  `, [id]);
  return run || null;
}

// The name shown for a customer: the Company from CallSwitch One (or typed by hand), never
// the CS1 ID; without one, "Unknown (CS1-123456)" and the line is flagged (known false).
const unknownLabel = (identifier) => `Unknown (${identifier})`;
// A "name" that is really an ID (the CS1 ID itself, or anything like CS1-123456) is no name.
const realName = (name, identifier) => {
  const n = String(name || '').trim();
  if (!n || n.toUpperCase() === String(identifier || '').trim().toUpperCase() || /^CS1-d+$/i.test(n)) return null;
  return n;
};

// Lines of a month with their name (live mapping, or the name used when it was sent),
// effective charge and whether they are included; sorted by charge, highest first.
async function reviewLines(db, run) {
  const [rows] = await db.query(`
    SELECT l.*, c.id AS customer_id, c.name AS customer_name, c.removed_at AS customer_removed_at, c.client_id, cl.name AS client_name
    FROM cs1_lines l
    LEFT JOIN cs1_customers c ON c.identifier = COALESCE(l.customer_key, l.identifier)
    LEFT JOIN clients cl ON cl.id = c.client_id
    WHERE l.run_id = ?
  `, [run.id]);
  const minimum = penniesOf(run.minimum);
  const lines = rows.map((l) => {
    const chargeP = penniesOf(l.charge);
    const effective = l.override_charge !== null ? penniesOf(l.override_charge) : chargeP;
    const auto = effective >= minimum;
    const included = l.include_override === null ? auto : Boolean(l.include_override);
    const name = realName(l.customer_name, l.identifier) || realName(l.name_snapshot, l.identifier);
    return {
      ...l, name, known: Boolean(name), label: name || unknownLabel(l.identifier), costUnits: toUnits(l.cost),
      chargePennies: chargeP, effective, auto, included, overridden: l.override_charge !== null, manual: l.include_override !== null,
      costText: Number(l.cost).toFixed(4), chargeText: pounds(effective),
    };
  });
  lines.sort((a, b) => (b.effective > a.effective ? 1 : b.effective < a.effective ? -1 : a.label.localeCompare(b.label)));
  const sum = (list, key) => list.reduce((n, l) => n + l[key], 0n);
  const included = lines.filter((l) => l.included);
  return {
    lines,
    totals: {
      lines: lines.length, included: included.length, excluded: lines.length - included.length,
      rawUnits: toUnits(run.raw_total), ignoredUnits: toUnits(run.ignored_total), costUnits: sum(lines, 'costUnits'),
      includedCostUnits: sum(included, 'costUnits'), includedPennies: sum(included, 'effective'),
    },
  };
}

// ---- Excel (Customer name, CS1 ID, Cost, Charge ex VAT; one row per customer, no total row) ----

async function excelBuffer(run, lines) {
  const book = new ExcelJS.Workbook();
  book.creator = 'Cleartwo IT Support';
  const sheet = book.addWorksheet(`Call charges ${monthLabel(run.billing_month)}`.slice(0, 31));
  sheet.columns = [
    { header: 'Customer name', key: 'customer', width: 36 },
    { header: 'CS1 ID', key: 'identifier', width: 22 },
    { header: 'Cost', key: 'cost', width: 14, style: { numFmt: '£#,##0.0000' } },
    { header: 'Charge ex VAT', key: 'charge', width: 16, style: { numFmt: '£#,##0.00' } },
  ];
  sheet.getRow(1).font = { bold: true };
  for (const l of lines.filter((x) => x.included)) {
    sheet.addRow({ customer: l.label, identifier: l.identifier, cost: Number(l.cost), charge: Number(money(l.effective)) });
  }
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  return Buffer.from(await book.xlsx.writeBuffer());
}

// ---- Email ----

const escapeHtml = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const defaultSubject = (run) => `CallSwitch One call charges: ${monthLabel(run.billing_month)}`;
const defaultIntro = (run) => `Hi,\n\nBelow are the CallSwitch One call charges for ${monthLabel(run.billing_month)}, with the ${Number(run.margin)}% margin added. All prices are ex VAT.`;

// HTML and text of the email: the intro (as typed, escaped), the table (Customer name | CS1 ID |
// Charge ex VAT, one row per customer, no total row), the signature. total is only stored on the run.
function emailBody({ intro, lines, signatureHtml, signatureText }) {
  const font = "font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #000000;";
  const included = lines.filter((l) => l.included);
  const total = included.reduce((n, l) => n + l.effective, 0n);
  const paras = String(intro || '').replace(/\r/g, '').split(/\n{2,}/).map((p) => `<p style="${font} margin: 0 0 11pt;">${escapeHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
  const cell = 'padding: 4px 10px; border: 1px solid #D9D9D9;';
  const table = `<table cellpadding="0" cellspacing="0" style="border-collapse: collapse; margin: 0 0 14pt; ${font}">
<tr><th align="left" style="${font} ${cell} background: #F2F2F2;">Customer name</th><th align="left" style="${font} ${cell} background: #F2F2F2;">CS1 ID</th><th align="right" style="${font} ${cell} background: #F2F2F2;">Charge ex VAT</th></tr>
${included.map((l) => `<tr><td style="${font} ${cell}">${escapeHtml(l.label)}</td><td style="${font} ${cell}">${escapeHtml(l.identifier)}</td><td align="right" style="${font} ${cell}">${pounds(l.effective)}</td></tr>`).join('\n')}
</table>`;
  const html = `<!doctype html><html><body style="${font}">${paras}${table}${signatureHtml ? `<div>${signatureHtml}</div>` : ''}</body></html>`;
  const width = Math.max(13, ...included.map((l) => l.label.length));
  const idWidth = Math.max(6, ...included.map((l) => String(l.identifier).length));
  const text = [String(intro || '').replace(/\r/g, ''), '',
    `${'Customer name'.padEnd(width)}  ${'CS1 ID'.padEnd(idWidth)}  Charge ex VAT`,
    ...included.map((l) => `${l.label.padEnd(width)}  ${String(l.identifier).padEnd(idWidth)}  ${pounds(l.effective)}`),
    '', signatureText || ''].join('\n').trim();
  return { html, text, total };
}

module.exports = {
  DEFAULTS, getSettings, saveSetting, monthStart, monthLabel, monthChoices, logCs1, saveRun, recalculate, getRun, reviewLines, rematchLines, unknownLines,
  excelBuffer, emailBody, defaultSubject, defaultIntro, unknownLabel, realName,
};
