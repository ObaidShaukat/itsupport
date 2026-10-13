// Checks the Call Switch One customer API settings without touching the database:
// GET only, to https://CS1_API_HOST/account/reseller with the X-Auth-Reseller / X-Auth-User /
// X-Auth-Password headers (CS1_RESELLER, CS1_USER, CS1_PASSWORD from .env). Prints the
// endpoint, HTTP status, record count, the field names returned (never their values) and
// sample IDs with how the first few are read. Usage: npm run cs1-fields
require('dotenv').config({ quiet: true });
const { cs1ApiConfig, listCustomers, fieldNames, mapCustomer } = require('../src/lib/cs1/api');

async function main() {
  const cfg = cs1ApiConfig();
  if (!cfg.configured) {
    console.error(cfg.message);
    process.exit(1);
  }
  console.log(`GET ${cfg.url} (X-Auth-Reseller / X-Auth-User / X-Auth-Password from .env)`);
  let reply;
  try {
    reply = await listCustomers();
  } catch (err) {
    console.error(`GET ${err.endpoint || cfg.url} -> ${err.status ? `HTTP ${err.status}` : 'no reply'}`);
    throw err;
  }
  const { records } = reply;
  console.log(`Endpoint: GET ${reply.endpoint}`);
  console.log(`HTTP status: ${reply.status}`);
  console.log(`Records: ${records.length}`);
  console.log(`Fields returned: ${fieldNames(records).join(', ') || '(none)'}`);
  const mapped = records.map(mapCustomer);
  const withId = mapped.filter((c) => c.identifier);
  console.log(`Sample IDs: ${withId.slice(0, 8).map((c) => (c.rawId && c.rawId.toUpperCase() !== c.identifier ? `${c.rawId} -> ${c.identifier}` : c.identifier)).join(', ') || '(none)'}`);
  console.log(`${withId.length} with a CS1 ID, ${withId.filter((c) => c.company).length} with a company.`);
  for (const c of mapped.slice(0, 5)) {
    console.log(`- ${c.identifier || '(no ID)'} | ${c.company || '(no company)'} | store ${c.store || '-'} | ${c.status || '-'} | registered ${c.registered || '-'} | users ${c.users ?? '-'} | numbers ${c.numbers ?? '-'}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
