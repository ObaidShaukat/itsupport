// Finds where CallSwitch One keeps the number shown as CS1-xxxxxx, using a known customer.
// GET only (https://CS1_API_HOST/account/reseller and /account/reseller/{uuid}), no database.
// Usage: npm run cs1-find -- "Oushk" 575445
//   1. finds the record(s) whose name is the company and searches ALL of their values and
//      keys (nested objects included, and the record's own key when the reply is keyed by
//      ID) for the number, printing each field / key path that holds it;
//   2. prints that record's crm_id and uuid, and when the list record does not hold the
//      number, reads GET /account/reseller/{uuid} and searches that too;
//   3. also searches the whole raw reply, and lists the status_id values seen (for the labels).
// Prints field paths and the matching values only; never the login or other customers' data.
require('dotenv').config({ quiet: true });
const {
  cs1ApiConfig, cs1Get, recordsOf, deepFind, getPath, listCustomers, CUSTOMERS_PATH,
} = require('../src/lib/cs1/api');

const [company = '', number = ''] = process.argv.slice(2);
const show = (hits) => (hits.length ? hits.map((h) => `    ${h.where === 'key' ? 'KEY  ' : 'VALUE'} ${h.path} = ${JSON.stringify(h.value)}`).join('\n') : '    (not found)');

async function main() {
  if (!company || !/^\d+$/.test(number)) {
    console.error('Usage: npm run cs1-find -- "Company name" 575445');
    process.exit(1);
  }
  const cfg = cs1ApiConfig();
  if (!cfg.configured) { console.error(cfg.message); process.exit(1); }

  // The raw first page, searched as a whole (covers a reply keyed by ID, and the wrapper).
  const raw = await cs1Get(cfg.url, cfg);
  console.log(`GET ${cfg.url} -> HTTP ${raw.status}`);
  console.log(`Top-level fields: ${Object.keys(raw.body || {}).join(', ') || '(array)'}`);
  console.log(`Paths in the raw reply holding ${number}:\n${show(deepFind(raw.body, number))}`);

  const { records } = await listCustomers();
  console.log(`\n${records.length} records in the list.`);
  const want = company.trim().toLowerCase();
  let matches = records.filter((r) => [r.contact_name, r.name].some((v) => String(v || '').trim().toLowerCase() === want));
  if (!matches.length) matches = records.filter((r) => JSON.stringify(r).toLowerCase().includes(want));
  if (!matches.length) console.log(`No record has the name "${company}".`);

  for (const rec of matches) {
    console.log(`\nRecord "${rec.contact_name || rec.name || '(no name)'}"`);
    console.log(`  uuid   = ${JSON.stringify(getPath(rec, 'uuid'))}`);
    console.log(`  crm_id = ${JSON.stringify(getPath(rec, 'crm_id'))}`);
    if (rec._key !== undefined) console.log(`  record key (_key) = ${JSON.stringify(rec._key)}`);
    console.log(`  fields: ${Object.keys(rec).join(', ')}`);
    const inList = deepFind(rec, number);
    console.log(`  Paths in the list record holding ${number}:\n${show(inList)}`);
    if (rec.uuid) {
      const url = `${cfg.url}/${encodeURIComponent(String(rec.uuid))}`;
      try {
        const one = await cs1Get(url, cfg);
        const detail = one.body && one.body.result && typeof one.body.result === 'object' ? one.body.result : one.body;
        console.log(`  GET ${CUSTOMERS_PATH}/{uuid} -> HTTP ${one.status}; fields: ${Object.keys(detail || {}).join(', ')}`);
        console.log(`  Paths in the single-account reply holding ${number}:\n${show(deepFind(one.body, number))}`);
      } catch (err) {
        console.log(`  GET ${CUSTOMERS_PATH}/{uuid} failed: ${err.message}`);
      }
    }
  }

  // status_id values (with how many customers have each), to name them.
  const statuses = new Map();
  for (const r of records) {
    const s = getPath(r, 'status_id');
    if (s !== undefined) statuses.set(String(s), (statuses.get(String(s)) || 0) + 1);
  }
  if (statuses.size) console.log(`\nstatus_id values: ${[...statuses].map(([s, n]) => `${s} (${n})`).join(', ')}`);
  if (matches[0] && getPath(matches[0], 'status_id') !== undefined) console.log(`"${company}" has status_id ${getPath(matches[0], 'status_id')}.`);
  // A recordsOf check, so the client reads the same list.
  if (!recordsOf(raw.body)) console.log('Warning: the client could not find the list in the raw reply.');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
