// CallSwitch One CDR files (V3, .txt or .csv): delimiter detection (comma, tab,
// semicolon, pipe), quoted values, the header row found by name, and the sum of
// Salesprice per Customer Identifier. Money is exact: amounts are BigInt units of 1e-8
// (cost) and pennies (charges), never floats.
const SCALE = 8;
const ONE = 10n ** BigInt(SCALE);
const DELIMITERS = [',', '\t', ';', '|'];
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const ID_HEADER = 'customeridentifier';
const PRICE_HEADER = 'salesprice';

// "12.345", "-0.5", "£1,234.56", "1 234,5"? (only . decimals) -> BigInt units, or null.
function toUnits(raw) {
  let s = String(raw == null ? '' : raw).trim().replace(/^"|"$/g, '').replace(/[£$€\s]/g, '');
  if (!s) return 0n;
  if (/^\(.*\)$/.test(s)) s = `-${s.slice(1, -1)}`;
  s = s.replace(/,(?=\d{3}(\D|$))/g, '');
  if (/^[+-]?\d+,\d+$/.test(s)) s = s.replace(',', '.');
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) return null;
  let digits = `${m[2] || '0'}${(m[3] || '')}`;
  let decimals = (m[3] || '').length - Number(m[4] || 0);
  if (decimals < 0) { digits += '0'.repeat(-decimals); decimals = 0; }
  let value = BigInt(digits);
  if (decimals > SCALE) {
    const cut = 10n ** BigInt(decimals - SCALE);
    const half = cut / 2n;
    value = (value + half) / cut; // round half up at 1e-8
  } else value *= 10n ** BigInt(SCALE - decimals);
  return m[1] === '-' ? -value : value;
}

// Units -> "1234.56780000" (DECIMAL(20,8)).
function unitsToDecimal(units, scale = SCALE) {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const div = 10n ** BigInt(scale);
  return `${neg ? '-' : ''}${abs / div}.${String(abs % div).padStart(scale, '0')}`;
}

// Round half away from zero: a / b.
function divRound(a, b) {
  const neg = (a < 0n) !== (b < 0n);
  const q = (a < 0n ? -a : a);
  const d = (b < 0n ? -b : b);
  const r = (q * 2n + d) / (2n * d);
  return neg ? -r : r;
}

// Charge in pennies: cost (units) x (100 + margin%) / 100, margin like "30" or "27.5".
function chargePennies(costUnits, margin) {
  const milli = BigInt(Math.round(Number(margin) * 1000)); // percent x 1000
  const factor = 100000n + milli; // (100% + margin) x 1000
  return divRound(costUnits * factor, 100000n * (ONE / 100n));
}

const penniesOf = (decimalText) => {
  const u = toUnits(decimalText);
  return u === null ? null : divRound(u, ONE / 100n);
};
const money = (pennies) => {
  const p = BigInt(pennies);
  const neg = p < 0n;
  const a = neg ? -p : p;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
};
// "£1,234.56"
const pounds = (pennies) => {
  const [int, dec] = money(pennies).replace('-', '').split('.');
  return `${BigInt(pennies) < 0n ? '-' : ''}£${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
};

// The delimiter used most consistently in the first lines (outside quotes).
function detectDelimiter(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 30);
  let best = ',';
  let bestScore = -1;
  for (const d of DELIMITERS) {
    const counts = lines.map((l) => {
      let n = 0;
      let quoted = false;
      for (const ch of l) {
        if (ch === '"') quoted = !quoted;
        else if (ch === d && !quoted) n += 1;
      }
      return n;
    }).filter((n) => n > 0);
    if (!counts.length) continue;
    const mode = counts.sort((a, b) => counts.filter((x) => x === b).length - counts.filter((x) => x === a).length)[0];
    const score = counts.filter((n) => n === mode).length * 1000 + mode;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

// RFC 4180-style rows: quoted values may contain the delimiter, quotes ("") and newlines.
function* rows(text, delimiter) {
  let field = '';
  let row = [];
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      yield row;
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); yield row; }
}

// Text of the upload: UTF-8 (BOM removed) or UTF-16 with a BOM.
function decode(buffer) {
  if (buffer[0] === 0xFF && buffer[1] === 0xFE) return buffer.slice(2).toString('utf16le');
  if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
    const swapped = Buffer.from(buffer.slice(2));
    for (let i = 0; i + 1 < swapped.length; i += 2) [swapped[i], swapped[i + 1]] = [swapped[i + 1], swapped[i]];
    return swapped.toString('utf16le');
  }
  const text = buffer.toString('utf8');
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

// Sums Salesprice per Customer Identifier. Returns { ok, delimiter, rows (data rows),
// totals: Map identifier -> units, rawTotal (units, includes blank identifiers? no:
// identified rows only), blankRows, badRows, blankTotal } or { ok: false, error }.
function parseCdr(buffer) {
  const text = decode(buffer);
  if (!text.trim()) return { ok: false, error: 'The file is empty.' };
  const delimiter = detectDelimiter(text);
  let idCol = -1;
  let priceCol = -1;
  let seen = 0;
  let headerFound = false;
  const totals = new Map();
  let dataRows = 0;
  let blankRows = 0;
  let badRows = 0;
  let blankTotal = 0n;
  let rawTotal = 0n;
  for (const row of rows(text, delimiter)) {
    if (!headerFound) {
      seen += 1;
      const names = row.map(norm);
      const i = names.indexOf(ID_HEADER);
      const p = names.indexOf(PRICE_HEADER);
      if (i >= 0 && p >= 0) { idCol = i; priceCol = p; headerFound = true; continue; }
      if (seen >= 50) break;
      continue;
    }
    if (row.every((c) => !String(c).trim())) continue;
    const id = String(row[idCol] == null ? '' : row[idCol]).trim();
    const price = toUnits(row[priceCol]);
    if (price === null) { badRows += 1; continue; }
    dataRows += 1;
    if (!id) { blankRows += 1; blankTotal += price; continue; }
    totals.set(id, (totals.get(id) || 0n) + price);
    rawTotal += price;
  }
  if (!headerFound) {
    const missing = [];
    const firstNames = [...rows(text, delimiter)].slice(0, 50).map((r) => r.map(norm));
    if (!firstNames.some((r) => r.includes(ID_HEADER))) missing.push('"Customer Identifier"');
    if (!firstNames.some((r) => r.includes(PRICE_HEADER))) missing.push('"Salesprice"');
    return { ok: false, error: `This does not look like a CallSwitch One CDR (V3) file: the ${missing.join(' and ') || '"Customer Identifier" and "Salesprice"'} column${missing.length === 1 ? ' was' : 's were'} not found in the header row.` };
  }
  if (!dataRows) return { ok: false, error: 'The file has a header row but no call lines.' };
  return { ok: true, delimiter, rows: dataRows, totals, rawTotal, blankRows, badRows, blankTotal };
}

module.exports = {
  SCALE, ONE, toUnits, unitsToDecimal, chargePennies, penniesOf, money, pounds, detectDelimiter, rows, decode, parseCdr, divRound,
};
