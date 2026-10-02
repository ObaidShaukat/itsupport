// Creates any missing tables from db/schema.sql, then adds any columns that newer
// versions introduced to existing tables. Safe to run repeatedly. Usage: npm run migrate
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../src/config');

// [table, column, definition] for columns added after a table was first released.
// MySQL has no "ADD COLUMN IF NOT EXISTS", so each is checked first.
const ADDED_COLUMNS = [
  ['activity_log', 'changes', 'VARCHAR(255) NULL AFTER summary'],
  // Inventory entries also point at the person they concern (person timeline).
  ['activity_log', 'related_person_id', 'INT UNSIGNED NULL AFTER changes'],
  ['services', 'report_phrase', 'VARCHAR(255) NULL AFTER description'],
  ['tickets', 'priority', "ENUM('low', 'normal', 'high', 'urgent') NOT NULL DEFAULT 'normal' AFTER status"],
  ['tickets', 'updated_by', 'INT UNSIGNED NULL AFTER created_by'],
  ['ticket_history', 'old_priority', "ENUM('low', 'normal', 'high', 'urgent') NULL AFTER new_status"],
  ['ticket_history', 'new_priority', "ENUM('low', 'normal', 'high', 'urgent') NULL AFTER old_priority"],
  // Daily Report action / issue / detail on comments, notes and log entries.
  ...['ticket_comments', 'client_service_notes', 'activity_log'].flatMap((table) => [
    [table, 'action_id', 'INT UNSIGNED NULL'],
    [table, 'issue_id', 'INT UNSIGNED NULL'],
    [table, 'report_detail', 'VARCHAR(255) NULL'],
  ]),
];

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const conn = await mysql.createConnection({ ...config.db, multipleStatements: true });
  try {
    // Columns first, so the ALTER ... MODIFY statements in schema.sql find them.
    for (const [table, column, definition] of ADDED_COLUMNS) {
      const [[tableRow]] = await conn.query(
        'SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
        [table]
      );
      if (!Number(tableRow.n)) continue; // New install: schema.sql creates it with the column.
      const [[columnRow]] = await conn.query(
        'SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
        [table, column]
      );
      if (Number(columnRow.n)) continue;
      // Identifiers come from the fixed list above, never from input.
      await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
      console.log(`Added column ${table}.${column}.`);
    }
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
