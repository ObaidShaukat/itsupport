// One shared mailer (SMTP via nodemailer). Settings come from .env:
//   SMTP_HOST, SMTP_PORT (587 = STARTTLS, 465 = TLS), SMTP_USER, SMTP_PASS,
//   MAIL_FROM_EMAIL, MAIL_FROM_NAME, and optionally APP_URL for links in emails.
// If any required setting is missing, sending is disabled: sendMail() returns
// { ok: false, error } with a clear message instead of throwing.
// Every attempt that reaches SMTP is written to email_log (to, subject, status, error).
const nodemailer = require('nodemailer');
const { pool } = require('../db');

const REQUIRED = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM_EMAIL'];
const EMAIL_PATTERN = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const OUR_DOMAIN = '@cleartwo.co.uk';

const isEmail = (value) => typeof value === 'string' && value.length <= 254 && EMAIL_PATTERN.test(value);

// The user's email address: their username when it is an email address.
const userEmail = (user) => (user && isEmail(user.username) ? user.username.toLowerCase() : null);

function missingSettings() {
  return REQUIRED.filter((key) => !String(process.env[key] || '').trim());
}

function mailStatus() {
  const missing = missingSettings();
  return missing.length
    ? { enabled: false, message: `Email is not set up: add ${missing.join(', ')} to .env and restart the portal.` }
    : { enabled: true, message: '' };
}

const fromAddress = () => ({
  name: process.env.MAIL_FROM_NAME || 'Cleartwo IT Support',
  address: process.env.MAIL_FROM_EMAIL,
});

// Base URL for links in emails (no trailing slash), or '' when APP_URL is not set.
const appUrl = () => String(process.env.APP_URL || '').trim().replace(/\/+$/, '');

let transport = null;
function getTransport() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT) || 587;
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465, // 587: plain connection upgraded with STARTTLS
      requireTLS: port !== 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transport;
}

const list = (value) => (Array.isArray(value) ? value : value ? [value] : []);
const addressText = (value) => list(value).map((a) => (typeof a === 'string' ? a : a.address)).join(', ');

async function logEmail(entry) {
  try {
    await pool.query(`
      INSERT INTO email_log (user_id, kind, to_addresses, cc_addresses, subject, status, error, message_id, reminder_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      entry.userId || null, entry.kind, entry.to.slice(0, 1000), entry.cc ? entry.cc.slice(0, 1000) : null,
      String(entry.subject || '').slice(0, 255), entry.status, entry.error ? String(entry.error).slice(0, 1000) : null,
      entry.messageId ? String(entry.messageId).slice(0, 255) : null, entry.reminderId || null,
    ]);
  } catch (err) {
    console.error('Could not write email_log:', err.message);
  }
}

// Sends one email. message: { to, cc, from, replyTo, subject, html, text }; meta:
// { kind: 'reminder' | 'report', userId, reminderId }. Returns { ok, error }.
async function sendMail(message, meta) {
  const status = mailStatus();
  if (!status.enabled) return { ok: false, error: status.message };
  const log = {
    ...meta, to: addressText(message.to), subject: message.subject,
    // BCC addresses are logged after the CC ones, marked "(bcc)".
    cc: [addressText(message.cc), addressText(message.bcc) && `(bcc) ${addressText(message.bcc)}`].filter(Boolean).join(', ') || null,
  };
  try {
    const info = await getTransport().sendMail({ from: fromAddress(), ...message });
    await logEmail({ ...log, status: 'sent', messageId: info.messageId });
    return { ok: true };
  } catch (err) {
    console.error('Email failed:', err.message);
    await logEmail({ ...log, status: 'failed', error: err.message });
    return { ok: false, error: `The email could not be sent: ${err.message}` };
  }
}

// Records an email that was never handed to SMTP (e.g. the user has no email address).
const logSkipped = (message, meta, error) => logEmail({
  ...meta, to: addressText(message.to) || '(none)', cc: null, subject: message.subject, status: 'failed', error,
});

const escapeHtml = (text) => String(text == null ? '' : text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

module.exports = {
  OUR_DOMAIN, isEmail, userEmail, mailStatus, fromAddress, appUrl, sendMail, logSkipped, escapeHtml,
};
