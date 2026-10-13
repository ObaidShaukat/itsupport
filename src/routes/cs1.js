// Call Switch One (/call-switch-one): Customers (synced daily from the CallSwitch One API,
// read only) and Billing = the monthly call charges from the CDR file (Upload & review,
// History). More sub-items (Devices, Numbers...) can be
// added here and in navItems (index.js). Every change is logged (entity_type 'cs1'),
// never on the Daily Report.
const fs = require('fs');
const express = require('express');
const { pool, transaction } = require('../db');
const { str, requireId, toId, flash, backPath } = require('../lib/http');
const { londonDate } = require('../lib/activity');
const { sanitizeSignature, fillSignature } = require('../lib/signature');
const { mailStatus, sendMail, userEmail } = require('../lib/mailer');
const { parseAddresses, signatureText } = require('../lib/report-email');
const { originalName } = require('../lib/uploads');
const { parseCdr, penniesOf, money, pounds, unitsToDecimal } = require('../lib/cs1/parse');
const {
  getSettings, saveSetting, monthStart, monthLabel, monthChoices, logCs1, saveRun, recalculate, getRun, reviewLines,
  excelBuffer, emailBody, defaultSubject, defaultIntro, realName, rematchLines,
} = require('../lib/cs1/billing');
const {
  syncCustomers, lastSync, importIds, linkId,
} = require('../lib/cs1/sync');
const { readSheet } = require('../lib/inventory/import-files');
const { cs1ApiConfig, normaliseId } = require('../lib/cs1/api');

const router = express.Router();
const BASE = '/call-switch-one/billing';
const MAX_BYTES = 50 * 1024 * 1024;
const OUR_DOMAIN = '@cleartwo.co.uk';
const MAX_RECIPIENTS = 25;

router.get('/', (req, res) => res.redirect(BASE));

// ---- Upload & review ----

async function runsList() {
  const [runs] = await pool.query(`
    SELECT r.id, r.billing_month, r.raw_total, r.uploaded_at, r.sent_at, r.sent_to, r.sent_total,
           COALESCE(NULLIF(u.display_name, ''), u.username) AS uploaded_name,
           (SELECT COUNT(*) FROM cs1_lines l WHERE l.run_id = r.id) AS line_count
    FROM cs1_runs r LEFT JOIN users u ON u.id = r.uploaded_by
    ORDER BY r.billing_month DESC
  `);
  return runs;
}

router.get('/billing', async (req, res) => {
  const runs = await runsList();
  res.render('cs1/upload', {
    title: 'Call Switch One billing', nav: 'cs1', area: 'upload', months: monthChoices(londonDate()), runs, settings: await getSettings(),
    existing: Object.fromEntries(runs.map((r) => [String(r.billing_month).slice(0, 7), r.id])), error: null, monthLabel,
  });
});

// Reads the CDR file, keeps only the sums, deletes the file straight away.
router.post('/billing/upload', async (req, res) => {
  const file = req.files && req.files.file && req.files.file[0];
  const fail = (message) => {
    flash(req, 'error', message);
    return res.redirect(BASE);
  };
  try {
    if (req.uploadError) return fail(req.uploadError);
    if (!file) return fail('Choose the CallSwitch One CDR file (.txt or .csv).');
    const name = originalName(file);
    if (!/\.(txt|csv)$/i.test(name)) return fail('Upload the CDR file as .txt or .csv.');
    if (file.size > MAX_BYTES) return fail('The file must be 50 MB or smaller.');
    const month = monthStart(req.body.month);
    if (!month) return fail('Choose the billing month.');
    const [[existing]] = await pool.query('SELECT id FROM cs1_runs WHERE billing_month = ?', [month]);
    if (existing && req.body.replace !== '1') {
      return fail(`${monthLabel(month)} has already been calculated. Tick "Replace the existing calculation" to upload it again.`);
    }
    const parsed = parseCdr(await fs.promises.readFile(file.path));
    if (!parsed.ok) return fail(parsed.error);
    const settings = await getSettings();
    const id = await transaction(async (conn) => {
      const runId = await saveRun(conn, req.user, { month, fileName: name.slice(0, 255), parsed, settings, replaceId: existing ? existing.id : null });
      await logCs1(conn, req.user, {
        id: runId, action: existing ? 'updated' : 'uploaded',
        summary: `${existing ? 'Replaced' : 'Calculated'} the Call Switch One call charges for ${monthLabel(month)} from ${name}: ${parsed.totals.size} customer identifiers, raw total £${unitsToDecimal(parsed.rawTotal + parsed.blankTotal).replace(/(\.\d{2})\d+$/, '$1')}`,
      });
      return runId;
    });
    flash(req, 'saved', `${monthLabel(month)} calculated from ${parsed.rows} call lines.`);
    return res.redirect(`${BASE}/runs/${id}`);
  } finally {
    // The uploaded file is never kept (only the calculated sums are stored).
    if (file) fs.promises.unlink(file.path).catch(() => {});
  }
});

async function runOr404(req) {
  const run = await getRun(pool, requireId(req.params.id));
  if (!run) { const e = new Error('That month was not found.'); e.status = 404; throw e; }
  return run;
}

router.get('/billing/runs/:id', async (req, res) => {
  const run = await runOr404(req);
  const settings = await getSettings();
  const { lines, totals } = await reviewLines(pool, run);
  const [clients] = await pool.query('SELECT id, name FROM clients ORDER BY name');
  const [[me]] = await pool.query('SELECT email_signature FROM users WHERE id = ?', [req.user.id]);
  res.render('cs1/review', {
    title: `Call Switch One · ${monthLabel(run.billing_month)}`, nav: 'cs1', area: 'upload', run, lines, totals, settings, clients,
    month: monthLabel(run.billing_month), pounds, money, unitsToDecimal, penniesOf,
    showExcluded: req.query.excluded === '1',
    email: {
      to: run.sent_to || settings.email_to, cc: run.sent_to ? run.sent_cc || '' : settings.email_cc, subject: run.sent_subject || defaultSubject(run),
      intro: defaultIntro(run), copy: settings[`copy:${req.user.id}`] === '1', status: mailStatus(), sender: userEmail(req.user),
      hasSignature: Boolean(me && me.email_signature),
    },
  });
});

// One line: charge override for this month ('' = back to the calculated one) and
// include / exclude ('auto' = by the minimum).
router.post('/billing/runs/:id/lines/:lid', async (req, res) => {
  const run = await runOr404(req);
  const back = backPath(req, `${BASE}/runs/${run.id}`);
  const [[line]] = await pool.query('SELECT * FROM cs1_lines WHERE id = ? AND run_id = ?', [requireId(req.params.lid), run.id]);
  if (!line) { flash(req, 'error', 'That line no longer exists.'); return res.redirect(back); }
  const changes = [];
  let override = line.override_charge;
  if ('override' in req.body) {
    const text = str(req.body.override, 20);
    if (!text) override = null;
    else {
      const p = penniesOf(text);
      if (p === null || p < 0n || p > 100000000n) { flash(req, 'error', 'Enter the charge as an amount, e.g. 12.50.'); return res.redirect(back); }
      override = money(p);
    }
    if ((override || null) !== (line.override_charge || null)) changes.push(override === null ? `charge back to the calculated £${line.charge}` : `charge overridden to £${override} (calculated £${line.charge})`);
  }
  let include = line.include_override;
  if ('include' in req.body) {
    include = req.body.include === '1' ? 1 : req.body.include === '0' ? 0 : null;
    if (include !== line.include_override) changes.push(include === null ? 'included by the minimum rule again' : include ? 'included by hand' : 'excluded by hand');
  }
  if (changes.length) {
    await pool.query('UPDATE cs1_lines SET override_charge = ?, include_override = ? WHERE id = ?', [override, include, line.id]);
    const [[c]] = await pool.query('SELECT name FROM cs1_customers WHERE identifier = ?', [line.customer_key || line.identifier]);
    await logCs1(null, req.user, { id: run.id, action: 'updated', summary: `${monthLabel(run.billing_month)}, ${c ? c.name : line.identifier}: ${changes.join(', ')}` });
    flash(req, 'saved', 'Saved.');
  }
  return res.redirect(back);
});

router.post('/billing/runs/:id/recalculate', async (req, res) => {
  const run = await runOr404(req);
  const settings = await getSettings();
  await transaction(async (conn) => {
    await recalculate(conn, run, settings);
    await logCs1(conn, req.user, { id: run.id, action: 'updated', summary: `Recalculated ${monthLabel(run.billing_month)} with a ${settings.margin}% margin and a £${settings.minimum} minimum` });
  });
  flash(req, 'saved', `Recalculated with a ${settings.margin}% margin and a £${settings.minimum} minimum.`);
  res.redirect(`${BASE}/runs/${run.id}`);
});

router.get('/billing/runs/:id/excel', async (req, res) => {
  const run = await runOr404(req);
  const { lines } = await reviewLines(pool, run);
  const buf = await excelBuffer(run, lines);
  res.attachment(`callswitch-one-call-charges-${String(run.billing_month).slice(0, 7)}.xlsx`);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

router.post('/billing/runs/:id/delete', async (req, res) => {
  const run = await runOr404(req);
  await pool.query('DELETE FROM cs1_runs WHERE id = ?', [run.id]);
  await logCs1(null, req.user, { action: 'deleted', summary: `Deleted the Call Switch One calculation for ${monthLabel(run.billing_month)}` });
  flash(req, 'saved', `${monthLabel(run.billing_month)} deleted.`);
  res.redirect(`${BASE}/history`);
});

// ---- Send email ----

router.post('/billing/runs/:id/send', async (req, res) => {
  const run = await runOr404(req);
  const back = `${BASE}/runs/${run.id}#send`;
  const fail = (message) => { flash(req, 'error', message); return res.redirect(back); };
  const status = mailStatus();
  if (!status.enabled) return fail(status.message);
  const sender = userEmail(req.user);
  if (!sender) return fail('Your username is not an email address, so the email cannot be sent from you.');
  const toList = parseAddresses(req.body.to_emails);
  const ccList = parseAddresses(req.body.cc_emails);
  const invalid = [...toList.invalid, ...ccList.invalid];
  if (invalid.length) return fail(`These are not valid email addresses: ${invalid.join(', ')}`);
  if (!toList.emails.length) return fail('Add at least one recipient.');
  const cc = ccList.emails.filter((e) => !toList.emails.includes(e));
  const copy = req.body.send_copy === '1';
  const bcc = copy && !toList.emails.includes(sender) && !cc.includes(sender) ? [sender] : [];
  if (toList.emails.length + cc.length + bcc.length > MAX_RECIPIENTS) return fail(`Send to at most ${MAX_RECIPIENTS} addresses.`);
  const subject = str(req.body.subject, 200) || defaultSubject(run);
  const intro = String(req.body.intro || '').slice(0, 5000).trim() || defaultIntro(run);

  const { lines } = await reviewLines(pool, run);
  if (!lines.some((l) => l.included)) return fail('No customers are included, so there is nothing to send.');
  const [[me]] = await pool.query('SELECT email_signature FROM users WHERE id = ?', [req.user.id]);
  const signature = fillSignature(sanitizeSignature((me && me.email_signature) || ''), req.user);
  const body = emailBody({ intro, lines, signatureHtml: signature, signatureText: signatureText(signature) });
  const name = req.user.name;
  // Same rules as the Daily Report: our own domain sends as the user, others from the portal.
  const from = sender.endsWith(OUR_DOMAIN) ? { name, address: sender } : { name, address: process.env.MAIL_FROM_EMAIL };
  const result = await sendMail({
    from, replyTo: { name, address: sender }, to: toList.emails, cc, bcc,
    headers: { 'X-MC-PreserveRecipients': 'true' },
    normalizeHeaderKey: (key) => (key.toLowerCase() === 'x-mc-preserverecipients' ? 'X-MC-PreserveRecipients' : key),
    subject, html: body.html, text: body.text,
    attachments: [{ filename: `CallSwitch One call charges ${monthLabel(run.billing_month)}.xlsx`, content: await excelBuffer(run, lines) }],
  }, { kind: 'cs1', userId: req.user.id });
  if (!result.ok) return fail(result.error);

  await transaction(async (conn) => {
    // The names used in this email stay with the month (History shows them as sent).
    for (const l of lines) if (l.name) await conn.query('UPDATE cs1_lines SET name_snapshot = ? WHERE id = ?', [l.name.slice(0, 200), l.id]);
    await conn.query('UPDATE cs1_runs SET sent_to = ?, sent_cc = ?, sent_subject = ?, sent_total = ?, sent_at = NOW(), sent_by = ? WHERE id = ?',
      [toList.emails.join(', ').slice(0, 1000), cc.join(', ').slice(0, 1000) || null, subject, money(body.total), req.user.id, run.id]);
    await saveSetting(conn, 'email_to', toList.emails.join(', ').slice(0, 1000));
    await saveSetting(conn, 'email_cc', cc.join(', ').slice(0, 1000));
    await saveSetting(conn, `copy:${req.user.id}`, copy ? '1' : '0');
    await logCs1(conn, req.user, {
      id: run.id, action: 'sent',
      summary: `Sent the Call Switch One call charges for ${monthLabel(run.billing_month)} (${lines.filter((l) => l.included).length} customers) to ${toList.emails.join(', ')}${cc.length ? ` (CC ${cc.join(', ')})` : ''}${bcc.length ? ', with a copy to you' : ''}`,
    });
  });
  flash(req, 'saved', `Sent to ${toList.emails.join(', ')}.`);
  res.redirect(`${BASE}/runs/${run.id}`);
});

// ---- History ----

router.get('/billing/history', async (req, res) => {
  const runs = await runsList();
  const withTotals = [];
  for (const r of runs) {
    const { totals } = await reviewLines(pool, r);
    withTotals.push({ ...r, totals });
  }
  res.render('cs1/history', { title: 'Call Switch One billing history', nav: 'cs1', area: 'history', runs: withTotals, monthLabel, pounds, unitsToDecimal, penniesOf, settings: await getSettings() });
});

// ---- Customers (/call-switch-one/customers): synced from CallSwitch One (read only) ----
// CS1 ID -> Company (the customer name everywhere), account holder, store, email, users,
// numbers, status; optional link to a portal client. The old /billing/customers address
// redirects here.

const CUSTOMERS = '/call-switch-one/customers';
router.use('/billing/customers', (req, res) => res.redirect(req.method === 'GET' || req.method === 'HEAD' ? 301 : 308, CUSTOMERS + (req.url === '/' ? '' : req.url.startsWith('/?') ? req.url.slice(1) : req.url)));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2025-04-29" -> "29 Apr 25" (the CS1 dashboard style).
const regDate = (d) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1].slice(2)}` : '';
};
const statusOfRow = (c) => (c.removed_at ? 'Removed' : (c.status || (c.source === 'api' ? 'Unknown' : 'Added by hand')));
const statusTone = (s) => (/^active$/i.test(s) ? 'ok' : /removed|ceased|locked|suspend|cancel|closed|terminat|disabled|blocked|deleted/i.test(s) ? 'bad' : 'muted');

// Sortable columns (sorting happens in JavaScript on the fetched rows; never SQL from input).
const SORTS = {
  registered: (c) => c.registered_on || '',
  status: (c) => statusOfRow(c).toLowerCase(),
  company: (c) => (realName(c.name, c.identifier) || '').toLowerCase() || '￿',
  holder: (c) => (c.account_holder || '').toLowerCase() || '￿',
  store: (c) => (c.store || '').toLowerCase() || '￿',
  id: (c) => (c.identifier || '').toLowerCase() || '￿',
  email: (c) => (c.email || '').toLowerCase() || '￿',
  users: (c) => (c.users_count === null ? -1 : Number(c.users_count)),
  numbers: (c) => (c.numbers_count === null ? -1 : Number(c.numbers_count)),
  client: (c) => (c.client_name || '').toLowerCase() || '￿',
};

router.get('/customers', async (req, res) => {
  const [all] = await pool.query(`
    SELECT c.*, cl.name AS client_name, COALESCE(NULLIF(u.display_name, ''), u.username) AS updated_name
    FROM cs1_customers c LEFT JOIN clients cl ON cl.id = c.client_id LEFT JOIN users u ON u.id = c.updated_by
  `);
  // CS1 IDs seen in uploads that are not customers yet.
  const [unknown] = await pool.query(`
    SELECT COALESCE(l.customer_key, l.identifier) AS identifier, MAX(r.billing_month) AS last_month, COUNT(DISTINCT r.id) AS months
    FROM cs1_lines l JOIN cs1_runs r ON r.id = l.run_id
    LEFT JOIN cs1_customers c ON c.identifier = COALESCE(l.customer_key, l.identifier)
    WHERE c.id IS NULL GROUP BY COALESCE(l.customer_key, l.identifier) ORDER BY identifier
  `);
  const [clients] = await pool.query('SELECT id, name FROM clients ORDER BY name');
  for (const c of all) {
    c.company = realName(c.name, c.identifier);
    c.statusText = statusOfRow(c);
    c.tone = statusTone(c.statusText);
  }
  const q = str(req.query.q, 100).toLowerCase();
  const status = str(req.query.status, 40);
  const store = str(req.query.store, 200);
  const sort = SORTS[req.query.sort] ? req.query.sort : 'company';
  const dir = req.query.dir === 'desc' ? 'desc' : 'asc';
  const needsId = all.filter((c) => !c.identifier && !c.removed_at).length;
  const statuses = [...new Set(all.map((c) => c.statusText))].sort((a, b) => (a === 'Active' ? -1 : b === 'Active' ? 1 : a.localeCompare(b)));
  if (needsId) statuses.push('Needs CS1 ID');
  const stores = [...new Set(all.map((c) => c.store).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const statusOk = (c) => !status || (status === 'Needs CS1 ID' ? !c.identifier && !c.removed_at : c.statusText === status);
  let customers = all.filter((c) => statusOk(c) && (!store || (store === '-' ? !c.store : c.store === store)));
  if (q) {
    customers = customers.filter((c) => [c.company, c.identifier, c.account_holder, c.store, c.email, c.client_name, c.statusText]
      .some((v) => v && String(v).toLowerCase().includes(q)));
  }
  const key = SORTS[sort];
  customers.sort((a, b) => {
    const x = key(a); const y = key(b);
    const r = x < y ? -1 : x > y ? 1 : String(a.identifier || '').localeCompare(String(b.identifier || '')) || a.id - b.id;
    return dir === 'desc' ? -r : r;
  });
  const sync = await lastSync();
  res.render('cs1/customers', {
    title: 'Call Switch One customers', nav: 'cs1', customers, total: all.length, unknown, clients, monthLabel, regDate,
    filters: { q: str(req.query.q, 100), status, store, sort, dir }, statuses, stores, sync, api: cs1ApiConfig(),
    unnamed: all.filter((c) => !c.company && !c.removed_at).length, needsId,
  });
});

router.post('/customers/sync', async (req, res) => {
  const result = await syncCustomers(req.user, { trigger: 'manual' });
  if (result.ok) {
    flash(req, 'saved', `Synced: ${result.total} customers from CallSwitch One, ${result.added} added, ${result.updated} updated, ${result.removed} marked removed${result.needsId ? `, ${result.needsId} need a CS1 ID` : ''}${result.source === 'official' ? ' (dashboard list unavailable: CS1 IDs linked by uuid)' : ''}${result.rematched ? `; ${result.rematched} billing line${result.rematched === 1 ? '' : 's'} in ${result.months} month${result.months === 1 ? '' : 's'} now matched` : ''}.`);
  } else flash(req, 'error', result.error);
  res.redirect(CUSTOMERS);
});

// Add a customer by hand (also the review screen's inline "Add company" for an unknown
// CS1 ID). The daily sync takes over the row when CallSwitch One returns that ID.
router.post('/customers', async (req, res) => {
  const back = backPath(req, CUSTOMERS);
  const identifier = normaliseId(str(req.body.identifier, 191));
  const name = str(req.body.name, 200);
  const clientId = toId(req.body.client_id);
  if (!identifier || !name) { flash(req, 'error', 'Enter the CS1 ID and the company name.'); return res.redirect(back); }
  if (!realName(name, identifier)) { flash(req, 'error', 'Enter the company name, not the CS1 ID.'); return res.redirect(back); }
  const [[before]] = await pool.query('SELECT id, name, client_id FROM cs1_customers WHERE identifier = ?', [identifier]);
  let client = null;
  if (clientId) [[client]] = await pool.query('SELECT id, name FROM clients WHERE id = ?', [clientId]);
  const keepClient = !('client_id' in req.body) && before ? before.client_id : (client ? client.id : null);
  if (before) await pool.query('UPDATE cs1_customers SET name = ?, client_id = ?, updated_by = ? WHERE id = ?', [name, keepClient, req.user.id, before.id]);
  else await pool.query('INSERT INTO cs1_customers (identifier, name, client_id, source, created_by, updated_by) VALUES (?, ?, ?, \'manual\', ?, ?)', [identifier, name, keepClient, req.user.id, req.user.id]);
  await logActivity2(req, before ? `Changed the Call Switch One customer ${identifier}: "${before.name}" → "${name}"${client ? ` (client ${client.name})` : ''}` : `Added the Call Switch One customer ${identifier} "${name}"${client ? ` (client ${client.name})` : ''}`, client);
  await rematchLines(pool);
  flash(req, 'saved', `Saved. ${identifier} is "${name}".`);
  res.redirect(back);
});

// Edit: the portal client link; the company only for customers added by hand or when
// CallSwitch One has none (synced fields are overwritten by the next sync anyway).
// Import CS1 IDs: the CS1 dashboard Customers export (.xlsx / .csv with ID and Company and /
// or Email). Each row is matched to a synced customer (company, then email) and its CS1 ID
// saved (CS1 ID <-> uuid); the file is deleted straight after reading.
router.post('/customers/import', async (req, res) => {
  const file = req.files && req.files.file && req.files.file[0];
  try {
    if (req.uploadError) { flash(req, 'error', req.uploadError); return res.redirect(CUSTOMERS); }
    if (!file) { flash(req, 'error', 'Choose the CS1 dashboard Customers export (.xlsx or .csv).'); return res.redirect(CUSTOMERS); }
    const sheet = await readSheet({ ...file, originalname: originalName(file) });
    if (sheet.error) { flash(req, 'error', sheet.error); return res.redirect(CUSTOMERS); }
    const out = await transaction(async (conn) => {
      const r = await importIds(conn, sheet);
      if (r.error) return r;
      const match = await rematchLines(conn);
      r.rematched = match.newlyMatched;
      await logCs1(conn, req.user, {
        action: 'uploaded',
        summary: `Imported CS1 IDs from ${originalName(file)}: ${r.rows} rows, ${r.linked.length + r.merged.length} linked, ${r.already} already linked, ${r.unmatched.length} not matched, ${r.conflicts.length} conflicts; ${r.rematched} billing lines now matched${r.linked.length + r.merged.length ? ` (${[...r.linked, ...r.merged].slice(0, 20).join(', ')})` : ''}`,
      });
      return r;
    });
    if (out.error) { flash(req, 'error', out.error); return res.redirect(CUSTOMERS); }
    const parts = [`${out.linked.length + out.merged.length} CS1 ID${out.linked.length + out.merged.length === 1 ? '' : 's'} saved`, `${out.already} already linked`];
    if (out.rematched) parts.push(`${out.rematched} billing line${out.rematched === 1 ? '' : 's'} now named`);
    if (out.unmatched.length) parts.push(`not matched: ${out.unmatched.slice(0, 15).join('; ')}${out.unmatched.length > 15 ? ` and ${out.unmatched.length - 15} more` : ''}`);
    if (out.conflicts.length) parts.push(`skipped: ${out.conflicts.slice(0, 10).join('; ')}`);
    flash(req, out.unmatched.length || out.conflicts.length ? 'info' : 'saved', `Import CS1 IDs: ${parts.join(', ')}.`);
    return res.redirect(CUSTOMERS);
  } finally {
    if (file) fs.promises.unlink(file.path).catch(() => {});
  }
});

router.post('/customers/:id', async (req, res) => {
  const id = requireId(req.params.id);
  const back = backPath(req, CUSTOMERS);
  const [[before]] = await pool.query('SELECT * FROM cs1_customers WHERE id = ?', [id]);
  if (!before) { flash(req, 'error', 'That customer no longer exists.'); return res.redirect(back); }
  const synced = before.source === 'api';
  // A synced customer still waiting for its CS1 ID gets it here (merged with a row that
  // already has that ID, e.g. one added by hand or seen in a CDR file).
  if (synced && !before.identifier && str(req.body.identifier, 191)) {
    const result = await transaction(async (conn) => {
      const r = await linkId(conn, before, str(req.body.identifier, 191));
      if (r.result === 'linked' || r.result === 'merged') {
        await logCs1(conn, req.user, { action: 'updated', summary: `Added the CS1 ID to the Call Switch One customer "${realName(before.name, before.identifier) || before.uuid}": ${r.message}` });
        await rematchLines(conn);
      }
      return r;
    });
    flash(req, result.result === 'conflict' ? 'error' : 'saved', result.message);
    if (result.result === 'conflict') return res.redirect(back);
  }
  const [[current]] = await pool.query('SELECT * FROM cs1_customers WHERE id = ?', [id]);
  if (!current) return res.redirect(back); // merged into the row that had the CS1 ID
  Object.assign(before, current);
  const identifier = synced ? before.identifier : (normaliseId(str(req.body.identifier, 191)) || before.identifier);
  const canName = !synced || !realName(before.name, before.identifier);
  const name = canName && 'name' in req.body ? str(req.body.name, 200) : before.name;
  if (canName && 'name' in req.body && !realName(name, identifier)) { flash(req, 'error', 'Enter the company name, not the CS1 ID.'); return res.redirect(back); }
  const clientId = toId(req.body.client_id);
  let client = null;
  if (clientId) [[client]] = await pool.query('SELECT id, name FROM clients WHERE id = ?', [clientId]);
  try {
    await pool.query('UPDATE cs1_customers SET identifier = ?, name = ?, client_id = ?, updated_by = ? WHERE id = ?', [identifier, name, client ? client.id : null, req.user.id, id]);
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    flash(req, 'error', `Another customer already uses the CS1 ID ${identifier}.`);
    return res.redirect(back);
  }
  const changes = [];
  if (identifier !== before.identifier) changes.push(`CS1 ID ${before.identifier} → ${identifier}`);
  if (name !== before.name) changes.push(`company "${before.name}" → "${name}"`);
  if ((client ? client.id : null) !== (before.client_id || null)) changes.push(client ? `linked to the client ${client.name}` : 'no longer linked to a client');
  if (changes.length) await logActivity2(req, `Changed the Call Switch One customer ${before.identifier || realName(before.name, before.identifier) || before.uuid}: ${changes.join(', ')}`, client);
  if (changes.length) await rematchLines(pool);
  if (!req.session.flash) flash(req, 'saved', 'Saved.');
  res.redirect(back);
});

router.post('/customers/:id/delete', async (req, res) => {
  const id = requireId(req.params.id);
  const back = backPath(req, CUSTOMERS);
  const [[before]] = await pool.query('SELECT * FROM cs1_customers WHERE id = ?', [id]);
  if (before && before.source === 'api' && !before.removed_at) {
    flash(req, 'error', `${realName(before.name, before.identifier) || before.identifier} comes from CallSwitch One, so it cannot be deleted here. It is marked Removed when CallSwitch One no longer lists it.`);
    return res.redirect(back);
  }
  if (before) {
    await pool.query('DELETE FROM cs1_customers WHERE id = ?', [id]);
    await logActivity2(req, `Deleted the Call Switch One customer ${before.identifier} "${before.name}"`);
  }
  flash(req, 'saved', before ? `Deleted ${before.identifier}.` : 'Already deleted.');
  res.redirect(back);
});

const logActivity2 = (req, summary, client = null) => logCs1(null, req.user, {
  action: 'updated', summary, clientId: client ? client.id : null, clientName: client ? client.name : null,
});

// ---- Settings: margin and minimum ----

router.post('/billing/settings', async (req, res) => {
  const back = backPath(req, BASE);
  const before = await getSettings();
  const margin = str(req.body.margin, 10).replace('%', '');
  const minimum = str(req.body.minimum, 12).replace('£', '');
  if (!/^\d{1,3}(\.\d{1,3})?$/.test(margin) || Number(margin) > 500) { flash(req, 'error', 'Enter the margin as a percentage from 0 to 500, e.g. 30.'); return res.redirect(back); }
  const minP = penniesOf(minimum);
  if (minP === null || minP < 0n || minP > 100000n) { flash(req, 'error', 'Enter the minimum as an amount, e.g. 1.00.'); return res.redirect(back); }
  const next = { margin: String(Number(margin)), minimum: money(minP) };
  const changes = Object.keys(next).filter((k) => String(before[k]) !== next[k]);
  for (const k of changes) await saveSetting(pool, k, next[k]);
  if (changes.length) await logCs1(null, req.user, { action: 'updated', summary: `Changed the Call Switch One billing settings: margin ${next.margin}%, minimum £${next.minimum}` });
  flash(req, 'saved', changes.length ? `Saved. New calculations use a ${next.margin}% margin and a £${next.minimum} minimum.` : 'Saved. Nothing changed.');
  res.redirect(back);
});

module.exports = router;
