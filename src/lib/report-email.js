// Emailing the Daily Report: subject, recipients and the HTML body. The body is
// rebuilt on the server from the (possibly edited) preview text, so only plain text
// reaches the email: bold "{Name}'s Work:", real bullets, Calibri 11pt, then the
// sender's sanitised signature.
const { isEmail, escapeHtml } = require('./mailer');
const { sanitizeSignature } = require('./signature');

const MAX_RECIPIENTS = 25;
const MAX_LINES = 300;

// "2026-10-07" -> "7 October"
const dayMonth = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });

// "EOD 7 October" (a range: "EOD 6 October – 10 October").
const reportSubject = (from, to) => (from === to ? `EOD ${dayMonth(from)}` : `EOD ${dayMonth(from)} – ${dayMonth(to)}`);

// "a@x.com, b@y.com; c@z.com" -> { emails: [...] (lower case, no duplicates), invalid: [...] }
function parseAddresses(value) {
  const parts = String(value || '').split(/[\s,;]+/).map((p) => p.trim().replace(/^<|>$/g, '')).filter(Boolean);
  const emails = [];
  const invalid = [];
  for (const part of parts) {
    if (!isEmail(part)) invalid.push(part);
    else if (!emails.includes(part.toLowerCase())) emails.push(part.toLowerCase());
  }
  return { emails, invalid };
}

const clean = (text, max = 1000) => String(text == null ? '' : text).replace(/\s+/g, ' ').trim().slice(0, max);

// The edited preview as posted by the browser: [{ title, users: [{ heading, lines }] }].
// Returns a cleaned copy, or null when it is missing or malformed.
function parseReportJson(json) {
  let days;
  try {
    days = JSON.parse(String(json || ''));
  } catch (err) {
    return null;
  }
  if (!Array.isArray(days)) return null;
  let count = 0;
  const out = days.slice(0, 62).map((day) => ({
    title: clean(day && day.title, 200),
    users: (Array.isArray(day && day.users) ? day.users : []).slice(0, 50).map((u) => ({
      heading: clean(u && u.heading, 200),
      lines: (Array.isArray(u && u.lines) ? u.lines : []).map((l) => clean(l)).filter(Boolean)
        .filter(() => ++count <= MAX_LINES),
    })).filter((u) => u.heading || u.lines.length),
  })).filter((day) => day.users.length);
  return out.length ? out : null;
}

// buildReport() days -> the same shape as the posted preview.
const fromReport = (report) => report.days.map((day) => ({
  title: report.multiDay ? day.label : '',
  users: day.users.map((u) => ({ heading: u.heading, lines: u.lines })),
}));

function reportText(days, signatureText) {
  const body = days.map((day) => {
    const blocks = day.users.map((u) => [u.heading, ...u.lines.map((l) => `- ${l}`)].join('\n')).join('\n\n');
    return (day.title ? `${day.title}\n\n` : '') + blocks;
  }).join('\n\n\n');
  return signatureText ? `${body}\n\n${signatureText}` : body;
}

function reportHtml(days, signature) {
  const font = 'font-family: Calibri, Arial, sans-serif; font-size: 11pt; color: #000000;';
  const parts = days.map((day) => {
    const title = day.title ? `<p style="${font} margin: 12pt 0 6pt;"><b><u>${escapeHtml(day.title)}</u></b></p>` : '';
    const users = day.users.map((u) => `<p style="${font} margin: 0 0 4pt;"><b>${escapeHtml(u.heading)}</b></p>`
      + `<ul style="${font} margin: 0 0 12pt; padding-left: 18pt;">`
      + u.lines.map((l) => `<li style="${font} margin: 0 0 2pt;">${escapeHtml(l)}</li>`).join('')
      + '</ul>').join('');
    return title + users;
  }).join('');
  const sig = sanitizeSignature(signature || '');
  return `<!doctype html><html><body style="${font}"><div style="${font}">${parts}</div>`
    + (sig ? `<div style="${font} margin-top: 14pt;">${sig}</div>` : '')
    + '</body></html>';
}

// Signature as plain text for the text/plain part.
const signatureText = (html) => String(html || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

module.exports = {
  MAX_RECIPIENTS, reportSubject, parseAddresses, parseReportJson, fromReport, reportText, reportHtml, signatureText,
};
