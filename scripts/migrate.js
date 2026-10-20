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
  ['users', 'notify_channels', "VARCHAR(40) NOT NULL DEFAULT 'popup,email,desktop' AFTER reminder_channel"],
  ['reminders', 'email_sent_at', 'DATETIME NULL AFTER snoozed_until'],
  ['reminder_recipients', 'pushed_at', 'DATETIME NULL AFTER sent_at'],
  ['ticket_comments', 'updated_at', 'DATETIME NULL AFTER body'],
  ['gdap_relationships', 'hidden_at', 'DATETIME NULL AFTER removed_at'],
  ['inventory_tabs', 'add_field_default', "ENUM('all', 'record') NOT NULL DEFAULT 'all' AFTER name"],
  ['gdap_relationships', 'hidden_by', 'INT UNSIGNED NULL AFTER hidden_at'],
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
  ['cs1_customers', 'account_holder', "VARCHAR(200) NULL AFTER name"],
  ['cs1_customers', 'store', "VARCHAR(200) NULL AFTER account_holder"],
  ['cs1_customers', 'email', "VARCHAR(255) NULL AFTER store"],
  ['cs1_customers', 'status', "VARCHAR(40) NULL AFTER email"],
  ['cs1_customers', 'registered_on', "DATE NULL AFTER status"],
  ['cs1_customers', 'users_count', "INT UNSIGNED NULL AFTER registered_on"],
  ['cs1_customers', 'numbers_count', "INT UNSIGNED NULL AFTER users_count"],
  ['cs1_customers', 'source', "VARCHAR(10) NOT NULL DEFAULT 'manual' AFTER numbers_count"],
  ['cs1_customers', 'synced_at', "DATETIME NULL AFTER source"],
  ['cs1_customers', 'removed_at', "DATETIME NULL AFTER synced_at"],
  ['cs1_lines', 'customer_key', 'VARCHAR(191) NULL AFTER identifier'],
  ['cs1_sync_log', 'endpoint', 'VARCHAR(500) NULL AFTER removed'],
  ['cs1_sync_log', 'http_status', 'SMALLINT UNSIGNED NULL AFTER endpoint'],
  ['cs1_sync_log', 'records', 'INT UNSIGNED NULL AFTER http_status'],
  ['cs1_sync_log', 'sample_ids', 'VARCHAR(1000) NULL AFTER fields'],
  ['cs1_sync_log', 'rematched', 'INT UNSIGNED NULL AFTER sample_ids'],
  ['cs1_customers', 'uuid', 'VARCHAR(64) NULL AFTER removed_at'],
  ['cs1_customers', 'account_id', 'VARCHAR(64) NULL AFTER uuid'],
  ['cs1_customers', 'id_alerted_at', 'DATETIME NULL AFTER account_id'],
  ['cs1_sync_log', 'source', 'VARCHAR(20) NULL AFTER removed'],
  ['cs1_sync_log', 'probe', 'VARCHAR(500) NULL AFTER source'],
  ['cs1_customers', 'phone', 'VARCHAR(40) NULL AFTER email'],
  ['cs1_customers', 'ceased_on', 'DATE NULL AFTER status'],
  ['cs1_customers', 'is_demo', 'TINYINT(1) NOT NULL DEFAULT 0 AFTER id_alerted_at'],
  ['cs1_customers', 'refreshed_at', 'DATETIME NULL AFTER is_demo'],
  ['tickets', 'assigned_to', 'INT UNSIGNED NULL AFTER updated_by'],
  ['users', 'ticket_view', 'VARCHAR(10) NULL AFTER report_view'],
  ['service_steps', 'stage', 'VARCHAR(100) NULL AFTER title'],
  ['client_service_steps', 'stage', 'VARCHAR(100) NULL AFTER title'],
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
  // Reminders get several recipients: copy each reminder's one recipient (with its snooze,
  // email and done state) into reminder_recipients, and stop deleting a whole reminder
  // when its first recipient's user is deleted.
  ['reminder_recipients_v1', async (conn) => {
    const [[fk]] = await conn.query(`
      SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reminders' AND CONSTRAINT_NAME = 'fk_reminders_user'
    `);
    if (Number(fk.n)) await conn.query('ALTER TABLE reminders DROP FOREIGN KEY fk_reminders_user');
    await conn.query('ALTER TABLE reminders MODIFY for_user_id INT UNSIGNED NULL');
    await conn.query('ALTER TABLE reminders ADD CONSTRAINT fk_reminders_user FOREIGN KEY (for_user_id) REFERENCES users (id) ON DELETE SET NULL');
    await conn.query(`
      INSERT IGNORE INTO reminder_recipients (reminder_id, user_id, snoozed_until, sent_at, done_at)
      SELECT id, for_user_id, snoozed_until, email_sent_at, CASE WHEN status = 'done' THEN COALESCE(done_at, updated_at) END
      FROM reminders WHERE for_user_id IS NOT NULL
    `);
    await conn.query('UPDATE reminders SET snoozed_until = NULL, email_sent_at = NULL');
  }],
  // Notification preference becomes any combination of popup / email / desktop; the old
  // popup / email / both choice is kept and desktop is added (it only works once the user
  // turns desktop notifications on in their browser).
  ['notify_channels_v1', async (conn) => {
    await conn.query(`
      UPDATE users SET notify_channels = CASE reminder_channel
        WHEN 'popup' THEN 'popup,desktop' WHEN 'email' THEN 'email,desktop' ELSE 'popup,email,desktop' END
    `);
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
  // "+ Add field" on Old Accounts adds a field for that record only by default.
  ['add_field_default_v1', async (conn) => {
    await conn.query("UPDATE inventory_tabs SET add_field_default = 'record' WHERE kind = 'records' AND LOWER(name) LIKE 'old account%'");
  }],
  // Call Switch One: names that were really the CS1 ID are cleared (shown as "Unknown (ID)"
  // until the customer sync or a person fills in the company).
  ['cs1_clear_id_names', async (conn) => {
    await conn.query("UPDATE cs1_customers SET name = '' WHERE TRIM(name) = identifier OR TRIM(name) REGEXP '^CS1-[0-9]+$'");
    await conn.query("UPDATE cs1_lines SET name_snapshot = NULL WHERE TRIM(name_snapshot) = identifier OR TRIM(name_snapshot) REGEXP '^CS1-[0-9]+$'");
  }],
  // Call Switch One: CS1 IDs in one form (CS1-001234 for 1234 / cs1 1234), and every saved
  // month's lines matched to customers by that form (cs1_lines.customer_key).
  ['cs1_normalise_ids_v1', async (conn) => {
    const { normaliseId } = require('../src/lib/cs1/api'); // eslint-disable-line global-require
    const [customers] = await conn.query('SELECT id, identifier FROM cs1_customers ORDER BY id');
    const taken = new Set(customers.map((c) => c.identifier.toUpperCase()));
    for (const c of customers) {
      const id = normaliseId(c.identifier);
      if (!id || id === c.identifier || taken.has(id.toUpperCase())) continue; // a duplicate keeps its old form
      await conn.query('UPDATE cs1_customers SET identifier = ? WHERE id = ?', [id, c.id]);
      taken.add(id.toUpperCase());
    }
    const [ids] = await conn.query('SELECT DISTINCT identifier FROM cs1_lines');
    for (const row of ids) await conn.query('UPDATE cs1_lines SET customer_key = ? WHERE identifier = ?', [normaliseId(row.identifier) || null, row.identifier]);
    const [[idx]] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cs1_lines' AND INDEX_NAME = 'idx_cs1_lines_customer_key'");
    if (!Number(idx.n)) await conn.query('ALTER TABLE cs1_lines ADD KEY idx_cs1_lines_customer_key (customer_key)');
  }],
  // Call Switch One: synced customers can wait for their CS1 ID (identifier NULL = "Needs
  // CS1 ID"), found by uuid.
  ['cs1_uuid_v1', async (conn) => {
    await conn.query('ALTER TABLE cs1_customers MODIFY identifier VARCHAR(191) NULL');
    const [[idx]] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'cs1_customers' AND INDEX_NAME = 'idx_cs1_customers_uuid'");
    if (!Number(idx.n)) await conn.query('ALTER TABLE cs1_customers ADD KEY idx_cs1_customers_uuid (uuid)');
  }],
  // Call Switch One: values that earlier API syncs wrote but the API cannot give correctly
  // (store_front uuids as Store, "Status 2", the API users count): cleared once; the next
  // Refresh from CallSwitch fills them from the dashboard list.
  ['cs1_clean_api_values_v1', async (conn) => {
    await conn.query("UPDATE cs1_customers SET store = NULL WHERE store REGEXP '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'");
    await conn.query("UPDATE cs1_customers SET status = NULL WHERE status REGEXP '^Status [0-9]+$'");
    await conn.query("UPDATE cs1_customers SET users_count = NULL, numbers_count = NULL WHERE source = 'api' AND refreshed_at IS NULL");
  }],
  // Ticket assignment: every existing ticket is assigned to whoever opened it.
  ['ticket_assigned_to_v1', async (conn) => {
    await conn.query('UPDATE tickets SET assigned_to = created_by WHERE assigned_to IS NULL AND created_by IS NOT NULL');
    const [[idx]] = await conn.query("SELECT COUNT(*) AS n FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tickets' AND INDEX_NAME = 'idx_tickets_assigned'");
    if (!Number(idx.n)) await conn.query('ALTER TABLE tickets ADD KEY idx_tickets_assigned (assigned_to, status)');
  }],
  // Email Services: one test domain to start with (checked at the next run or Check now).
  ['m365_test_domain_v1', async (conn) => {
    await conn.query("INSERT IGNORE INTO m365_domains (domain, notes) VALUES ('foreversundays.com', 'Test domain')");
  }],
  // Email Services: every domain so far was added by hand, so it uses Microsoft 365 ('yes';
  // auto is only for domains added automatically later). Forgetting last_run makes the app
  // check them all again as soon as it starts, so they show Issues instead of Not Microsoft.
  ['m365_manual_yes_v1', async (conn) => {
    await conn.query("UPDATE m365_domains SET uses_m365 = 'yes' WHERE uses_m365 = 'auto'");
    await conn.query("DELETE FROM m365_settings WHERE name = 'last_run'");
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
