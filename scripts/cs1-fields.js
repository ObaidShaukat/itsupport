// Checks the Call Switch One customer API settings without touching the database:
// GET only (CS1_API_URL with CS1_API_TOKEN / CS1_API_AUTH from .env), then prints how many
// customers came back, the field names returned (never their values) and how the first
// few are mapped (CS1 ID, company, store, status). Usage: npm run cs1-fields
require('dotenv').config({ quiet: true });
const { cs1ApiConfig, listCustomers, fieldNames, mapCustomer } = require('../src/lib/cs1/api');

async function main() {
  const cfg = cs1ApiConfig();
  if (!cfg.configured) {
    console.error(cfg.message);
    process.exit(1);
  }
  console.log(`GET ${cfg.url}`);
  const records = await listCustomers();
  console.log(`${records.length} customer record(s).`);
  console.log(`Fields returned: ${fieldNames(records).join(', ') || '(none)'}`);
  const mapped = records.map(mapCustomer);
  const withId = mapped.filter((c) => c.identifier);
  console.log(`${withId.length} with a CS1 ID, ${withId.filter((c) => c.company).length} with a company.`);
  for (const c of mapped.slice(0, 5)) {
    console.log(`- ${c.identifier || '(no ID)'} | ${c.company || '(no company)'} | store ${c.store || '-'} | ${c.status || '-'} | registered ${c.registered || '-'} | users ${c.users ?? '-'} | numbers ${c.numbers ?? '-'}`);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
