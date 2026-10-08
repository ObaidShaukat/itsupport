// Adds any columns that newer versions introduced to existing tables, creates any missing
// tables from db/schema.sql, then runs one-time steps (recorded in schema_migrations, so
// each runs once, e.g. the inventory rebuild). Safe to run repeatedly. Usage: npm run migrate
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../src/config');
const { installDefaults } = require('../src/lib/inventory/defaults');

// [table, column, definition] for columns added after a table was first released.
// MySQL has no "ADD COLUMN IF NOT EXISTS", so each is checked first.
const ADDED_COLUMNS = [
  ['users', 'display_name', 'VARCHAR(100) NULL AFTER username'],
  ['users', 'report_view', 'VARCHAR(20) NULL AFTER display_name'],
  ['users', 'email_signature', 'MEDIUMTEXT NULL AFTER report_view'],
  ['users', 'report_to', 'VARCHAR(1000) NULL AFTER email_signature'],
  ['users', 'report_cc', 'VARCHAR(1000) NULL AFTER report_to'],
  ['users', 'report_copy', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER report_cc'],
  ['users', 'job_title', 'VARCHAR(100) NULL AFTER report_cc'],
  ['users', 'avatar_file', 'VARCHAR(64) NULL AFTER job_title'],
  ['users', 'reminder_channel', "ENUM('popup', 'email', 'both') NOT NULL DEFAULT 'both' AFTER avatar_file"],
  ['users', 'date_format', "ENUM('d_mon_yyyy', 'dd_mm_yyyy') NOT NULL DEFAULT 'd_mon_yyyy' AFTER reminder_channel"],
  ['reminders', 'email_sent_at', 'DATETIME NULL AFTER snoozed_until'],
  ['activity_log', 'changes', 'VARCHAR(255) NULL AFTER summary'],
  // Inventory entries also point at the person they concern (person timeline).
  ['activity_log', 'related_person_id', 'INT UNSIGNED NULL AFTER changes'],
  ['services', 'report_phrase', 'VARCHAR(255) NULL AFTER description'],
  ['tickets', 'priority', "ENUM('low', 'normal', 'high', 'urgent') NOT NULL DEFAULT 'normal' AFTER status"],
  ['tickets', 'updated_by', 'INT UNSIGNED NULL AFTER created_by'],
  // Ticket reminders become notifications (the old task_id stays for old rows).
  ['notifications', 'reminder_id', 'INT UNSIGNED NULL AFTER task_id'],
  ['ticket_history', 'old_priority', "ENUM('low', 'normal', 'high', 'urgent') NULL AFTER new_status"],
  ['ticket_history', 'new_priority', "ENUM('low', 'normal', 'high', 'urgent') NULL AFTER old_priority"],
  // Daily Report action / issue / detail on comments, notes and log entries.
  ...['ticket_comments', 'client_service_notes', 'activity_log'].flatMap((table) => [
    [table, 'action_id', 'INT UNSIGNED NULL'],
    [table, 'issue_id', 'INT UNSIGNED NULL'],
    [table, 'report_detail', 'VARCHAR(255) NULL'],
  ]),
];

// The old inventory (people, assets, stock, access, shared accounts, offboarding, custom
// fields). Dropped with their data when the module was rebuilt; children before parents.
const OLD_INVENTORY_TABLES = [
  'custom_field_values', 'custom_fields', 'inv_offboarding_items', 'inv_shared_accounts', 'inv_access',
  'inv_stock_assignments', 'inv_stock', 'inv_asset_assignments', 'inv_assets', 'inv_people',
  'inv_apps', 'inv_categories', 'inv_teams', 'inv_companies',
];

// [name, async (conn) => {}] run once each, in order, after schema.sql.
const ONE_TIME_STEPS = [
  ['inventory_v2_reset', async (conn) => {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    try {
      // Table names come from the fixed list above, never from input.
      for (const table of OLD_INVENTORY_TABLES) await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
    } finally {
      await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    }
  }],
  ['inventory_v2_defaults', async (conn) => {
    await conn.beginTransaction();
    try {
      await installDefaults(conn);
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    }
  }],
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

    // One-time steps, recorded in schema_migrations so they never run twice.
    for (const [name, step] of ONE_TIME_STEPS) {
      const [[done]] = await conn.query('SELECT name FROM schema_migrations WHERE name = ?', [name]);
      if (done) continue;
      await step(conn);
      await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [name]);
      console.log(`Ran one-time step ${name}.`);
    }
    console.log('Migration complete.');
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
