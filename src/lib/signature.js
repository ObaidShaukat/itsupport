// Email signatures: HTML typed in the editor or pasted (e.g. from Outlook), always
// sanitised with sanitize-html before it is saved and again before it is sent.
// Allowed: text formatting, links, line breaks, images (by URL or embedded) and the
// simple tables / inline styles Outlook signatures are built from. No scripts, forms,
// <style> blocks or event handlers.
const sanitizeHtml = require('sanitize-html');

const MAX_LENGTH = 500000; // embedded images make Outlook signatures large

// Plain values only: no url(), expression(), javascript: or anything that ends the declaration.
const STYLE_VALUE = [/^(?!.*\b(url|expression|image-set|var)\s*\()(?!.*javascript:)[^;{}<>\\]*$/i];
const STYLES = ['color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration',
  'text-align', 'vertical-align', 'line-height', 'letter-spacing', 'white-space', 'width', 'height', 'max-width',
  'min-width', 'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'padding', 'padding-top',
  'padding-right', 'padding-bottom', 'padding-left', 'border', 'border-top', 'border-right', 'border-bottom',
  'border-left', 'border-collapse', 'border-spacing', 'border-radius', 'display'];

const OPTIONS = {
  allowedTags: ['p', 'div', 'span', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'small', 'big', 'sub', 'sup', 'font',
    'a', 'img', 'hr', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'colgroup', 'col'],
  allowedAttributes: {
    '*': ['style', 'align', 'valign', 'width', 'height', 'bgcolor', 'dir'],
    a: ['href', 'title', 'target'],
    img: ['src', 'alt', 'title', 'border'],
    font: ['color', 'face', 'size'],
    table: ['cellpadding', 'cellspacing', 'border', 'role'],
    td: ['colspan', 'rowspan', 'nowrap'],
    th: ['colspan', 'rowspan', 'nowrap'],
    col: ['span'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  allowedSchemesAppliedToAttributes: ['href', 'src'],
  allowProtocolRelative: false,
  allowedStyles: { '*': Object.fromEntries(STYLES.map((name) => [name, STYLE_VALUE])) },
  // Office markup such as <o:p> is dropped but its text is kept.
  disallowedTagsMode: 'discard',
  nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'title', 'head', 'xml'],
  transformTags: {
    a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, target: '_blank' } }),
  },
};

function sanitizeSignature(html) {
  const raw = typeof html === 'string' ? html : '';
  if (!raw.trim()) return '';
  const clean = sanitizeHtml(raw, OPTIONS).trim();
  // Nothing visible left (e.g. only empty paragraphs): store nothing.
  const visible = clean.replace(/<br\s*\/?>/gi, '').replace(/<(p|div|span)[^>]*>\s*<\/\1>/gi, '').trim();
  return visible ? clean : '';
}

// Returns { html } or { error } for a submitted signature.
function readSignature(value) {
  const raw = typeof value === 'string' ? value : '';
  if (raw.length > MAX_LENGTH * 2) return { error: 'That signature is too large. Use linked images instead of embedded ones.' };
  const html = sanitizeSignature(raw);
  if (html.length > MAX_LENGTH) return { error: 'That signature is too large. Use linked images instead of embedded ones.' };
  return { html: html || null };
}

// Fills placeholders in a saved signature: {job_title} becomes the user's job title
// (or nothing). Run after sanitising, with the value escaped.
function fillSignature(html, user) {
  if (!html) return '';
  const jobTitle = String((user && user.job_title) || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return html.split('{job_title}').join(jobTitle);
}

module.exports = { sanitizeSignature, readSignature, fillSignature };
