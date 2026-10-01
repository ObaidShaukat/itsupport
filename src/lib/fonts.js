const fs = require('fs');
const path = require('path');

const FONT_DIR = path.join(__dirname, '..', '..', 'public', 'fonts');

const FAMILIES = [
  { family: 'Kollektif', match: /kollektif/i },
  { family: 'Made Tommy', match: /made[\s_-]*tommy/i },
];

const FORMATS = { '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'truetype', '.otf': 'opentype' };

function weightOf(file) {
  if (/black|heavy/i.test(file)) return 900;
  if (/extra[\s_-]*bold/i.test(file)) return 800;
  if (/bold/i.test(file)) return 700;
  if (/medium/i.test(file)) return 500;
  if (/thin/i.test(file)) return 100;
  if (/light/i.test(file)) return 300;
  return 400;
}

// Builds @font-face rules for brand font files found in public/fonts.
// needPoppins is true when any brand font is missing, so the Google Fonts fallback is loaded.
// Runs once at startup: restart the app after adding font files.
function detectFonts() {
  let files = [];
  try {
    files = fs.readdirSync(FONT_DIR);
  } catch {
    // No fonts folder: fall back to Poppins.
  }

  const rules = [];
  let found = 0;
  for (const { family, match } of FAMILIES) {
    const matches = files.filter((f) => match.test(f) && FORMATS[path.extname(f).toLowerCase()]);
    if (!matches.length) continue;
    found++;
    for (const file of matches) {
      const format = FORMATS[path.extname(file).toLowerCase()];
      const style = /italic|oblique/i.test(file) ? 'italic' : 'normal';
      rules.push(
        `@font-face{font-family:"${family}";src:url("/fonts/${encodeURIComponent(file)}") format("${format}");` +
          `font-weight:${weightOf(file)};font-style:${style};font-display:swap;}`
      );
    }
  }

  return { css: rules.join('\n') + '\n', needPoppins: found < FAMILIES.length };
}

module.exports = { detectFonts };
