const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');

const SANITIZE = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img'],
  allowedAttributes: {
    a: ['href', 'title'],
    img: ['src', 'alt', 'title'],
    code: ['class'],
    th: ['align'],
    td: ['align'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { img: ['http', 'https'] },
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
  },
};
SANITIZE.allowedAttributes.a.push('rel', 'target');

// Markdown -> sanitised HTML (raw HTML in the source is stripped of anything unsafe).
function renderMarkdown(text) {
  if (!text) return '';
  return sanitizeHtml(marked.parse(String(text), { gfm: true, breaks: true }), SANITIZE);
}

module.exports = { renderMarkdown };
