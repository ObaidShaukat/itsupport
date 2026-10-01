// Creates any missing tables from db/schema.sql. Usage: npm run migrate
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../src/config');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true });
  try {
    await conn.query(sql);
    console.log('Migration complete.');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
