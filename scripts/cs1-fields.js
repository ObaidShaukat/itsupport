// Checks the Call Switch One customer API without touching the database: GET only,
// https://CS1_API_HOST/account/reseller with the X-Auth-Reseller / X-Auth-User /
// X-Auth-Password headers from .env (no cookies or browser tokens). Prints the endpoint, HTTP
// status, record count, field names (never values) and how the first five are read.
// (CS1 IDs come from "Refresh from CallSwitch" on the Customers page: the server never reads
// the dashboard list itself.) Usage: npm run cs1-fields
require('dotenv').config({ quiet: true });
const {
  cs1ApiConfig, listOfficial, fieldNames, mapOfficial,
} = require('../src/lib/cs1/api');

async function main() {
  const cfg = cs1ApiConfig();
  if (!cfg.configured) {
    console.error(cfg.message);
    process.exit(1);
  }
  let reply;
  try {
    reply = await listOfficial(cfg);
  } catch (err) {
    console.error(`GET ${err.endpoint || cfg.url} -> ${err.status ? `HTTP ${err.status}` : 'no reply'}`);
    throw err;
  }
  const { records } = reply;
  console.log(`GET ${reply.endpoint} -> HTTP ${reply.status}`);
  console.log(`Records: ${records.length}`);
  console.log(`Fields returned: ${fieldNames(records).join(', ') || '(none)'}`);
  for (const c of records.slice(0, 5).map(mapOfficial)) {
    console.log(`- ${c.company || '(no company)'} | ${c.status || 'status not given'} | store ${c.store || '-'} | registered ${c.registered || '-'} | users ${c.users ?? '-'} | uuid ${c.uuid ? 'yes' : 'no'}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
