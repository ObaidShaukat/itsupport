// Checks the Call Switch One customer sources without touching the database (GET only, the
// X-Auth-Reseller / X-Auth-User / X-Auth-Password headers from .env; no cookies or browser
// tokens):
//   1. the dashboard list, https://www.callswitchone.com/service/account/reseller: HTTP
//      status and whether customer_id (the CS1 ID) is there;
//   2. the documented API, https://CS1_API_HOST/account/reseller.
// For each: endpoint, HTTP status, record count, field names (never values) and sample IDs /
// companies of the first few. Usage: npm run cs1-fields
require('dotenv').config({ quiet: true });
const {
  cs1ApiConfig, listService, listOfficial, fieldNames, mapCustomer,
} = require('../src/lib/cs1/api');

function report(title, reply) {
  const { records } = reply;
  const mapped = records.map(mapCustomer);
  const withId = records.filter((r) => r && r.customer_id !== undefined && r.customer_id !== null && r.customer_id !== '');
  console.log(`\n${title}`);
  console.log(`  GET ${reply.endpoint} -> HTTP ${reply.status}`);
  console.log(`  Records: ${records.length}`);
  console.log(`  customer_id: ${withId.length ? `present (${withId.length} of ${records.length})` : 'missing'}`);
  console.log(`  Fields returned: ${fieldNames(records).join(', ') || '(none)'}`);
  for (const c of mapped.slice(0, 5)) {
    console.log(`  - ${c.identifier || '(no CS1 ID)'} | ${c.company || '(no company)'} | holder ${c.holder || '-'} | store ${c.store || '-'} | ${c.status || '-'} | registered ${c.registered || '-'} | users ${c.users ?? '-'} | numbers ${c.numbers ?? '-'} | uuid ${c.uuid ? 'yes' : 'no'}`);
  }
}

async function main() {
  const cfg = cs1ApiConfig();
  if (!cfg.configured) {
    console.error(cfg.message);
    process.exit(1);
  }
  try {
    report('1. Dashboard list (used first when customer_id is present)', await listService(cfg));
  } catch (err) {
    console.log(`\n1. Dashboard list\n  GET ${err.endpoint || cfg.serviceUrl} -> ${err.status ? `HTTP ${err.status}` : 'no reply'}\n  ${err.message}\n  The sync will use the official API and link CS1 IDs by uuid (Import CS1 IDs on the Customers page).`);
  }
  try {
    report('2. Official API (fallback)', await listOfficial(cfg));
  } catch (err) {
    console.log(`\n2. Official API\n  GET ${err.endpoint || cfg.url} -> ${err.status ? `HTTP ${err.status}` : 'no reply'}\n  ${err.message}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
