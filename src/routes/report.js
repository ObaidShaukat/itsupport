// Daily Report: one day (default today) or a date range. "View" picks whose work is
// shown: 'me' (default), 'all' or a user id. The last choice is saved on the user
// (users.report_view); that is a display preference, so it is not activity-logged.
// "Send report" emails the signed-in user's own report (POST /report/send).
const express = require('express');
const { pool } = require('../db');
const { toId, str, flash } = require('../lib/http');
const { londonDate, logActivity } = require('../lib/activity');
const { MAX_RANGE_DAYS, isDate, addDays, daysBetween, dayLabel, buildReport } = require('../lib/report');
const { OUR_DOMAIN, mailStatus, userEmail, isEmail, sendMail } = require('../lib/mailer');
const {
  MAX_RECIPIENTS, reportSubject, parseAddresses, parseReportJson, fromReport, reportText, reportHtml, signatureText,
} = require('../lib/report-email');
const { sanitizeSignature, fillSignature } = require('../lib/signature');

const router = express.Router();

router.get('/', async (req, res) => {
  const today = londonDate();
  let from = isDate(req.query.from) ? req.query.from : today;
  let to = isDate(req.query.to) ? req.query.to : from;
  if (to < from) [from, to] = [to, from];
  let notice = null;
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) {
    to = addDays(from, MAX_RANGE_DAYS - 1);
    notice = `Reports cover at most ${MAX_RANGE_DAYS} days, so this one ends on ${dayLabel(to)}.`;
  }

  const [users] = await pool.query("SELECT id, COALESCE(NULLIF(display_name, ''), username) AS name FROM users ORDER BY name");

  // ?view= wins (and is remembered); otherwise the saved choice; otherwise "me".
  // The old ?user= links still work.
  const valid = (v) => v === 'me' || v === 'all' || users.some((u) => String(u.id) === v);
  let view = typeof req.query.view === 'string' ? req.query.view : (toId(req.query.user) ? String(toId(req.query.user)) : '');
  if (valid(view)) {
    if (view !== req.user.report_view) {
      await pool.query('UPDATE users SET report_view = ? WHERE id = ?', [view, req.user.id]);
    }
  } else {
    view = valid(req.user.report_view || '') ? req.user.report_view : 'me';
  }
  const userId = view === 'all' ? null : view === 'me' ? req.user.id : Number(view);

  const report = await buildReport({ from, to, userId });
  // Each user sends only their own report.
  const ownReport = userId === req.user.id ? report : await buildReport({ from, to, userId: req.user.id });

  // Your own manual entries in this period, for editing.
  const [manual] = await pool.query(`
    SELECT id, client_name, summary, activity_date
    FROM activity_log
    WHERE entity_type = 'manual' AND user_id = ? AND activity_date BETWEEN ? AND ?
    ORDER BY activity_date, created_at, id
  `, [req.user.id, from, to]);

  // Send report popup: last recipients, suggestions (earlier recipients + portal users)
  // and the sends already made for these dates.
  const [[me]] = await pool.query('SELECT report_to, report_cc, email_signature FROM users WHERE id = ?', [req.user.id]);
  const [usedRows] = await pool.query(
    "SELECT to_addresses, cc_addresses FROM email_log WHERE user_id = ? AND kind = 'report' AND status = 'sent' ORDER BY created_at DESC LIMIT 100",
    [req.user.id]
  );
  const [userRows] = await pool.query("SELECT username, COALESCE(NULLIF(display_name, ''), username) AS name FROM users ORDER BY name");
  const suggestions = [];
  const suggest = (email, label) => {
    const e = String(email || '').trim().toLowerCase();
    if (isEmail(e) && !suggestions.some((x) => x.email === e)) suggestions.push({ email: e, label: label || '' });
  };
  for (const row of usedRows) [row.to_addresses, row.cc_addresses].forEach((v) => String(v || '').split(/,\s*/).forEach((e) => suggest(e)));
  for (const u of userRows) suggest(u.username, u.name);
  const [sends] = await pool.query(`
    SELECT summary, activity_date, created_at FROM activity_log
    WHERE entity_type = 'report' AND action = 'sent' AND user_id = ? AND activity_date BETWEEN ? AND ?
    ORDER BY created_at, id
  `, [req.user.id, from, to]);

  const link = (range) => {
    const params = new URLSearchParams({ from: range.from });
    if (range.to !== range.from) params.set('to', range.to);
    params.set('view', view);
    return `/report?${params}`;
  };

  const span = daysBetween(from, to) + 1;
  const dow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const monday = addDays(today, -((dow + 6) % 7));
  const presets = [
    { label: 'Today', from: today, to: today },
    { label: 'Yesterday', from: addDays(today, -1), to: addDays(today, -1) },
    { label: 'This week', from: monday, to: today },
    { label: 'Last week', from: addDays(monday, -7), to: addDays(monday, -1) },
  ].map((p) => ({ ...p, href: link(p), active: p.from === from && p.to === to }));

  res.render('report/index', {
    title: 'Daily Report',
    from,
    to,
    view,
    users,
    report,
    manual,
    notice,
    presets,
    periodLabel: from === to ? dayLabel(from) : `${dayLabel(from)} – ${dayLabel(to)}`,
    prevHref: link({ from: addDays(from, -span), to: addDays(to, -span) }),
    nextHref: link({ from: addDays(from, span), to: addDays(to, span) }),
    unit: span === 1 ? 'day' : `${span} days`,
    backPath: req.originalUrl,
    ownReport,
    send: {
      status: mailStatus(),
      senderEmail: userEmail(req.user),
      ourDomain: OUR_DOMAIN,
      to: me.report_to || '',
      cc: me.report_cc || '',
      subject: reportSubject(from, to),
      hasSignature: Boolean(me.email_signature),
      signature: fillSignature(sanitizeSignature(me.email_signature || ''), req.user),
      suggestions,
      sends,
    },
  });
});

// Emails the signed-in user's own report for from..to. The posted preview (with any
// edits) is rebuilt as plain text on the server, so no HTML from the browser is sent.
router.post('/send', async (req, res) => {
  const today = londonDate();
  let from = isDate(req.body.from) ? req.body.from : today;
  let to = isDate(req.body.to) ? req.body.to : from;
  if (to < from) [from, to] = [to, from];
  if (daysBetween(from, to) + 1 > MAX_RANGE_DAYS) to = addDays(from, MAX_RANGE_DAYS - 1);
  const back = `/report?${new URLSearchParams(from === to ? { from, view: 'me' } : { from, to, view: 'me' })}`;
  const fail = (message) => {
    flash(req, 'error', message);
    return res.redirect(back);
  };

  const status = mailStatus();
  if (!status.enabled) return fail(status.message);
  const sender = userEmail(req.user);
  if (!sender) return fail('Your username is not an email address, so the report cannot be sent from you. Ask for it to be changed on the Users page.');

  const toList = parseAddresses(req.body.to_emails);
  const ccList = parseAddresses(req.body.cc_emails);
  const invalid = [...toList.invalid, ...ccList.invalid];
  if (invalid.length) return fail(`These are not valid email addresses: ${invalid.join(', ')}`);
  if (!toList.emails.length) return fail('Add at least one recipient.');
  // The sender is always copied in so they have a copy.
  const cc = ccList.emails.filter((e) => !toList.emails.includes(e));
  const ccWithSender = toList.emails.includes(sender) || cc.includes(sender) ? cc : [...cc, sender];
  if (toList.emails.length + ccWithSender.length > MAX_RECIPIENTS) return fail(`Send to at most ${MAX_RECIPIENTS} addresses.`);
  const subject = str(req.body.subject, 200) || reportSubject(from, to);

  const days = parseReportJson(req.body.report) || fromReport(await buildReport({ from, to, userId: req.user.id }));
  if (!days.length) return fail('There is nothing in your report to send.');

  const [[me]] = await pool.query('SELECT email_signature FROM users WHERE id = ?', [req.user.id]);
  // {job_title} in the signature becomes the sender's job title.
  const signature = fillSignature(sanitizeSignature(me.email_signature || ''), req.user);
  const name = req.user.name;
  // Our own domain sends as the user; anyone else sends from the portal address.
  const fromAddress = sender.endsWith(OUR_DOMAIN)
    ? { name, address: sender }
    : { name, address: process.env.MAIL_FROM_EMAIL };
  const result = await sendMail({
    from: fromAddress,
    replyTo: { name, address: sender },
    to: toList.emails,
    cc: ccWithSender,
    subject,
    html: reportHtml(days, signature),
    text: reportText(days, signatureText(signature)),
  }, { kind: 'report', userId: req.user.id });
  if (!result.ok) return fail(result.error);

  // Remembered for next time (without the automatic copy to the sender).
  await pool.query('UPDATE users SET report_to = ?, report_cc = ? WHERE id = ?',
    [toList.emails.join(', ').slice(0, 1000), cc.join(', ').slice(0, 1000) || null, req.user.id]);
  const summary = `Sent to ${toList.emails.join(', ')}${cc.length ? ` (CC ${cc.join(', ')})` : ''}`;
  await logActivity(null, req.user, { type: 'report', action: 'sent', subject, summary, date: from });
  flash(req, 'success', `Report sent to ${toList.emails.join(', ')}.`);
  res.redirect(back);
});

module.exports = router;
