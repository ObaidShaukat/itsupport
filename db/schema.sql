-- Cleartwo IT Support portal schema.
-- Safe to run repeatedly: every table is created only if it does not exist.
-- The sessions table is created automatically by express-mysql-session.

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(100) NOT NULL,
  -- Shown everywhere a user appears; empty means the username is shown.
  display_name VARCHAR(100) NULL,
  -- Last Daily Report "View" choice: 'me', 'all' or a user id.
  report_view VARCHAR(20) NULL,
  -- Sanitised HTML signature added to Daily Reports this user emails.
  email_signature MEDIUMTEXT NULL,
  -- Last recipients of the emailed Daily Report (comma-separated), pre-filled next time.
  report_to VARCHAR(1000) NULL,
  report_cc VARCHAR(1000) NULL,
  -- "Send me a copy" (BCC to themselves) in the Send report popup, remembered.
  report_copy TINYINT(1) NOT NULL DEFAULT 0,
  -- My profile: optional job title ({job_title} in signatures), profile picture file
  -- (uploads/avatars), how ticket reminders reach them, and how dates are shown.
  job_title VARCHAR(100) NULL,
  avatar_file VARCHAR(64) NULL,
  reminder_channel ENUM('popup', 'email', 'both') NOT NULL DEFAULT 'both',
  date_format ENUM('d_mon_yyyy', 'dd_mm_yyyy') NOT NULL DEFAULT 'd_mon_yyyy',
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'admin',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_categories (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(150) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_service_categories_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS services (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  category_id INT UNSIGNED NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT NULL,
  report_phrase VARCHAR(255) NULL,
  position INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_services_category_name (category_id, name),
  CONSTRAINT fk_services_category FOREIGN KEY (category_id)
    REFERENCES service_categories (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_steps (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_id INT UNSIGNED NOT NULL,
  title VARCHAR(500) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_service_steps_order (service_id, position),
  CONSTRAINT fk_service_steps_service FOREIGN KEY (service_id)
    REFERENCES services (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS clients (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(200) NOT NULL,
  contact_name VARCHAR(200) NULL,
  email VARCHAR(254) NULL,
  phone VARCHAR(50) NULL,
  notes TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_clients_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A service assigned to a client. service_name is a snapshot so the record
-- survives the service being renamed or deleted.
CREATE TABLE IF NOT EXISTS client_services (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id INT UNSIGNED NOT NULL,
  service_id INT UNSIGNED NULL,
  service_name VARCHAR(200) NOT NULL,
  status ENUM('open', 'closed') NOT NULL DEFAULT 'open',
  assigned_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_client_services_status (status),
  CONSTRAINT fk_client_services_client FOREIGN KEY (client_id)
    REFERENCES clients (id) ON DELETE CASCADE,
  CONSTRAINT fk_client_services_service FOREIGN KEY (service_id)
    REFERENCES services (id) ON DELETE SET NULL,
  CONSTRAINT fk_client_services_user FOREIGN KEY (assigned_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Steps copied from the service when it was assigned.
CREATE TABLE IF NOT EXISTS client_service_steps (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_service_id INT UNSIGNED NOT NULL,
  title VARCHAR(500) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  done TINYINT(1) NOT NULL DEFAULT 0,
  done_by INT UNSIGNED NULL,
  done_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_client_service_steps_order (client_service_id, position),
  CONSTRAINT fk_client_service_steps_cs FOREIGN KEY (client_service_id)
    REFERENCES client_services (id) ON DELETE CASCADE,
  CONSTRAINT fk_client_service_steps_user FOREIGN KEY (done_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Notes log on an assigned service, e.g. one entry per laptop configured.
CREATE TABLE IF NOT EXISTS client_service_notes (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_service_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NULL,
  body TEXT NOT NULL,
  action_id INT UNSIGNED NULL,
  issue_id INT UNSIGNED NULL,
  report_detail VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by INT UNSIGNED NULL,
  updated_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_client_service_notes_cs (client_service_id, created_at),
  CONSTRAINT fk_client_service_notes_cs FOREIGN KEY (client_service_id)
    REFERENCES client_services (id) ON DELETE CASCADE,
  CONSTRAINT fk_client_service_notes_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_client_service_notes_editor FOREIGN KEY (updated_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS tickets (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  client_id INT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  status ENUM('open', 'customer_waiting', 'closed') NOT NULL DEFAULT 'open',
  priority ENUM('low', 'normal', 'high', 'urgent') NOT NULL DEFAULT 'normal',
  created_by INT UNSIGNED NULL,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tickets_status (status),
  KEY idx_tickets_client (client_id, status),
  CONSTRAINT fk_tickets_client FOREIGN KEY (client_id)
    REFERENCES clients (id) ON DELETE CASCADE,
  CONSTRAINT fk_tickets_user FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ticket_comments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NULL,
  body TEXT NOT NULL,
  action_id INT UNSIGNED NULL,
  issue_id INT UNSIGNED NULL,
  report_detail VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ticket_comments_ticket (ticket_id, created_at),
  CONSTRAINT fk_ticket_comments_ticket FOREIGN KEY (ticket_id)
    REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_comments_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Status and priority changes. A status row has old_status/new_status (old_status is
-- NULL for the entry recorded when a ticket is created); a priority row has
-- old_priority/new_priority and no status.
CREATE TABLE IF NOT EXISTS ticket_history (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NULL,
  old_status ENUM('open', 'customer_waiting', 'closed') NULL,
  new_status ENUM('open', 'customer_waiting', 'closed') NULL,
  old_priority ENUM('low', 'normal', 'high', 'urgent') NULL,
  new_priority ENUM('low', 'normal', 'high', 'urgent') NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ticket_history_ticket (ticket_id, created_at),
  CONSTRAINT fk_ticket_history_ticket FOREIGN KEY (ticket_id)
    REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_history_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tutorial files on a service (images, videos, PDFs, other files).
-- file_name is the random name on disk; original_name is what the user uploaded.
CREATE TABLE IF NOT EXISTS service_tutorials (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  service_id INT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  file_name VARCHAR(64) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL,
  kind ENUM('image', 'video', 'pdf', 'file') NOT NULL,
  uploaded_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_service_tutorials_file (file_name),
  KEY idx_service_tutorials_service (service_id, created_at),
  CONSTRAINT fk_service_tutorials_service FOREIGN KEY (service_id)
    REFERENCES services (id) ON DELETE CASCADE,
  CONSTRAINT fk_service_tutorials_user FOREIGN KEY (uploaded_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- General IT Support knowledge base.
CREATE TABLE IF NOT EXISTS kb_articles (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL DEFAULT 'General',
  tags VARCHAR(500) NULL,
  issue MEDIUMTEXT NULL,
  solution MEDIUMTEXT NULL,
  created_by INT UNSIGNED NULL,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_kb_articles_category (category),
  KEY idx_kb_articles_title (title),
  CONSTRAINT fk_kb_articles_creator FOREIGN KEY (created_by)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_kb_articles_editor FOREIGN KEY (updated_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS kb_attachments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  article_id INT UNSIGNED NOT NULL,
  file_name VARCHAR(64) NOT NULL,
  original_name VARCHAR(255) NOT NULL,
  size_bytes BIGINT UNSIGNED NOT NULL,
  kind ENUM('image', 'video', 'pdf', 'file') NOT NULL,
  uploaded_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_kb_attachments_file (file_name),
  KEY idx_kb_attachments_article (article_id),
  CONSTRAINT fk_kb_attachments_article FOREIGN KEY (article_id)
    REFERENCES kb_articles (id) ON DELETE CASCADE,
  CONSTRAINT fk_kb_attachments_user FOREIGN KEY (uploaded_by)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Activity log (audit trail) and manual "Log work" entries; feeds the Daily Report.
-- entity_id is the record whose History panel shows the entry (see src/lib/activity.js).
-- client_name and subject are snapshots so entries still read correctly after renames
-- or deletes. activity_date is the report day (UK date, or the date chosen for manual work).
CREATE TABLE IF NOT EXISTS activity_log (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NULL,
  client_id INT UNSIGNED NULL,
  client_name VARCHAR(200) NULL,
  entity_type ENUM('ticket', 'ticket_comment', 'client_service', 'step', 'note', 'service',
                   'kb_article', 'tutorial', 'client', 'user', 'setting', 'task', 'reminder', 'report', 'inv_person', 'inv_asset', 'inv_stock',
                   'inv_access', 'inv_shared', 'inv_setting', 'inv_record', 'inv_item', 'inv_config', 'inv_secret', 'manual') NOT NULL,
  entity_id INT UNSIGNED NULL,
  action ENUM('created', 'updated', 'status_changed', 'commented', 'step_done', 'closed',
              'reopened', 'deleted', 'uploaded', 'completed', 'sent', 'assigned', 'returned', 'viewed', 'copied', 'exported') NOT NULL,
  subject VARCHAR(255) NULL,
  summary TEXT NOT NULL,
  changes VARCHAR(255) NULL,
  related_person_id INT UNSIGNED NULL,
  action_id INT UNSIGNED NULL,
  issue_id INT UNSIGNED NULL,
  report_detail VARCHAR(255) NULL,
  activity_date DATE NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_activity_log_date_user (activity_date, user_id),
  KEY idx_activity_log_entity (entity_type, entity_id),
  KEY idx_activity_log_client (client_id, created_at),
  CONSTRAINT fk_activity_log_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_activity_log_client FOREIGN KEY (client_id)
    REFERENCES clients (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===================== Inventory (Cleartwo's own staff, accounts and kit) =====================
-- Rebuilt in October 2026. The old inv_* and custom_field* tables are dropped once by
-- scripts/migrate.js (one-time step "inventory_v2_reset"); the default tabs, fields and
-- stock categories are installed once by "inventory_v2_defaults" (src/lib/inventory/defaults.js).
-- Password and PIN fields are stored only encrypted (AES-256-GCM, ENCRYPTION_KEY in .env)
-- in inventory_values.value_enc; never in plain text.

-- One-time migration steps that must never run twice (e.g. dropping old tables).
CREATE TABLE IF NOT EXISTS schema_migrations (
  name VARCHAR(100) NOT NULL,
  ran_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Inventory sub-tabs, in sidebar order. kind: employees (active employees), ex_employees
-- (inactive employees), stock, records (Writers, Old Accounts and tabs added later).
CREATE TABLE IF NOT EXISTS inventory_tabs (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind ENUM('employees', 'ex_employees', 'stock', 'records') NOT NULL DEFAULT 'records',
  name VARCHAR(60) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Stock categories. group_by: how the breakdown report groups items before brand
-- ('platform' = Windows / Apple, 'field' = by the value of group_field_id, e.g. Mouse
-- connection type).
CREATE TABLE IF NOT EXISTS stock_categories (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  group_by ENUM('none', 'platform', 'field') NOT NULL DEFAULT 'none',
  group_field_id INT UNSIGNED NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_stock_categories_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Field definitions for a records tab (tab_id) or a stock category's extra fields
-- (category_id). role marks special fields: 'title' (the record's name), 'user_id', 'email'.
-- width is the default column width in px (each user can resize, see inventory_widths).
CREATE TABLE IF NOT EXISTS inventory_fields (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tab_id INT UNSIGNED NULL,
  category_id INT UNSIGNED NULL,
  label VARCHAR(100) NOT NULL,
  field_type ENUM('text', 'longtext', 'email', 'phone', 'number', 'date', 'link', 'dropdown',
                  'password', 'pin', 'access') NOT NULL DEFAULT 'text',
  options TEXT NULL,
  role VARCHAR(20) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  visible TINYINT(1) NOT NULL DEFAULT 1,
  required TINYINT(1) NOT NULL DEFAULT 0,
  width SMALLINT UNSIGNED NOT NULL DEFAULT 160,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inventory_fields_tab (tab_id, sort_order),
  KEY idx_inventory_fields_category (category_id, sort_order),
  CONSTRAINT fk_inventory_fields_tab FOREIGN KEY (tab_id) REFERENCES inventory_tabs (id) ON DELETE CASCADE,
  CONSTRAINT fk_inventory_fields_category FOREIGN KEY (category_id) REFERENCES stock_categories (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per employee / writer / account / custom-tab entry. status and leaving_date
-- are used by employees (inactive = Ex Employees).
CREATE TABLE IF NOT EXISTS inventory_records (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  tab_id INT UNSIGNED NOT NULL,
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  leaving_date DATE NULL,
  created_by INT UNSIGNED NULL,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inventory_records_tab (tab_id, status),
  CONSTRAINT fk_inventory_records_tab FOREIGN KEY (tab_id) REFERENCES inventory_tabs (id) ON DELETE CASCADE,
  CONSTRAINT fk_inventory_records_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_inventory_records_editor FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Field values. Password / PIN fields use value_enc only ("v1:" + base64 of IV, tag and
-- ciphertext); every other type uses value. Access toggles store 'granted' or nothing.
CREATE TABLE IF NOT EXISTS inventory_values (
  record_id INT UNSIGNED NOT NULL,
  field_id INT UNSIGNED NOT NULL,
  value TEXT NULL,
  value_enc TEXT NULL,
  PRIMARY KEY (record_id, field_id),
  KEY idx_inventory_values_field (field_id),
  CONSTRAINT fk_inventory_values_record FOREIGN KEY (record_id) REFERENCES inventory_records (id) ON DELETE CASCADE,
  CONSTRAINT fk_inventory_values_field FOREIGN KEY (field_id) REFERENCES inventory_fields (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every physical item (laptops included). employee_id is set while it is assigned.
CREATE TABLE IF NOT EXISTS stock_items (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  category_id INT UNSIGNED NOT NULL,
  brand VARCHAR(100) NULL,
  model VARCHAR(150) NULL,
  serial VARCHAR(150) NULL,
  status ENUM('available', 'assigned', 'repair', 'damaged', 'sold', 'disposed') NOT NULL DEFAULT 'available',
  employee_id INT UNSIGNED NULL,
  notes TEXT NULL,
  created_by INT UNSIGNED NULL,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_stock_items_category (category_id, status),
  KEY idx_stock_items_employee (employee_id),
  CONSTRAINT fk_stock_items_category FOREIGN KEY (category_id) REFERENCES stock_categories (id),
  CONSTRAINT fk_stock_items_employee FOREIGN KEY (employee_id) REFERENCES inventory_records (id) ON DELETE SET NULL,
  CONSTRAINT fk_stock_items_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_stock_items_editor FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Values of a stock category's extra fields for one item.
CREATE TABLE IF NOT EXISTS stock_values (
  item_id INT UNSIGNED NOT NULL,
  field_id INT UNSIGNED NOT NULL,
  value TEXT NULL,
  PRIMARY KEY (item_id, field_id),
  KEY idx_stock_values_field (field_id),
  CONSTRAINT fk_stock_values_item FOREIGN KEY (item_id) REFERENCES stock_items (id) ON DELETE CASCADE,
  CONSTRAINT fk_stock_values_field FOREIGN KEY (field_id) REFERENCES inventory_fields (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Assignment history ("Equipment held"). The item details are snapshots, so the record
-- still reads correctly after the item is edited or deleted. Dates are UK dates.
CREATE TABLE IF NOT EXISTS stock_assignments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_id INT UNSIGNED NULL,
  employee_id INT UNSIGNED NOT NULL,
  category_name VARCHAR(100) NULL,
  brand VARCHAR(100) NULL,
  model VARCHAR(150) NULL,
  serial VARCHAR(150) NULL,
  assigned_on DATE NOT NULL,
  returned_on DATE NULL,
  assigned_by INT UNSIGNED NULL,
  returned_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_stock_assignments_employee (employee_id, returned_on),
  KEY idx_stock_assignments_item (item_id, returned_on),
  CONSTRAINT fk_stock_assignments_item FOREIGN KEY (item_id) REFERENCES stock_items (id) ON DELETE SET NULL,
  CONSTRAINT fk_stock_assignments_employee FOREIGN KEY (employee_id) REFERENCES inventory_records (id) ON DELETE CASCADE,
  CONSTRAINT fk_stock_assignments_assigner FOREIGN KEY (assigned_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_stock_assignments_returner FOREIGN KEY (returned_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Inventory settings, e.g. user_id_prefix (employee User-IDs PREFIX-001; default MDP).
CREATE TABLE IF NOT EXISTS inventory_settings (
  name VARCHAR(50) NOT NULL,
  value VARCHAR(255) NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Column widths each user dragged in inventory tables (col_key e.g. "f12", "stock:brand").
CREATE TABLE IF NOT EXISTS inventory_widths (
  user_id INT UNSIGNED NOT NULL,
  col_key VARCHAR(64) NOT NULL,
  width SMALLINT UNSIGNED NOT NULL,
  PRIMARY KEY (user_id, col_key),
  CONSTRAINT fk_inventory_widths_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tasks: no longer used (replaced by ticket reminders). Kept so existing installs and
-- old notifications keep working; nothing reads or writes it any more.
CREATE TABLE IF NOT EXISTS tasks (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  title VARCHAR(255) NOT NULL,
  notes TEXT NULL,
  assigned_to INT UNSIGNED NULL,
  due_at DATETIME NULL,
  remind_at DATETIME NULL,
  reminder_sent_at DATETIME NULL,
  status ENUM('todo', 'done') NOT NULL DEFAULT 'todo',
  important TINYINT(1) NOT NULL DEFAULT 0,
  client_id INT UNSIGNED NULL,
  ticket_id INT UNSIGNED NULL,
  created_by INT UNSIGNED NULL,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_tasks_assignee (assigned_to, status, due_at),
  KEY idx_tasks_reminder (status, remind_at, reminder_sent_at),
  KEY idx_tasks_client (client_id),
  KEY idx_tasks_ticket (ticket_id),
  CONSTRAINT fk_tasks_assignee FOREIGN KEY (assigned_to) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_tasks_client FOREIGN KEY (client_id) REFERENCES clients (id) ON DELETE SET NULL,
  CONSTRAINT fk_tasks_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE SET NULL,
  CONSTRAINT fk_tasks_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_tasks_editor FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Ticket reminders. remind_at is chosen in UK time and stored in UTC; snoozed_until
-- (also UTC) overrides it until the reminder is edited or done. A reminder is due when
-- COALESCE(snoozed_until, remind_at) <= NOW() and it is still pending.
CREATE TABLE IF NOT EXISTS reminders (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id INT UNSIGNED NOT NULL,
  note VARCHAR(500) NULL,
  remind_at DATETIME NOT NULL,
  for_user_id INT UNSIGNED NOT NULL,
  status ENUM('pending', 'done') NOT NULL DEFAULT 'pending',
  snoozed_until DATETIME NULL,
  -- When the reminder email went out for the current due time; cleared by snooze / edit.
  email_sent_at DATETIME NULL,
  created_by INT UNSIGNED NULL,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  done_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_reminders_ticket (ticket_id, status),
  KEY idx_reminders_user (for_user_id, status, remind_at),
  CONSTRAINT fk_reminders_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_reminders_user FOREIGN KEY (for_user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_reminders_creator FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_reminders_editor FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Notifications. Only the 'portal' channel (bell + toast) is delivered today;
-- 'email' and 'teams' are reserved for later. delivered_at is when the toast was first
-- shown (the sound plays then). A due reminder gets one unread 'ticket_reminder' row;
-- done, snooze, edit and delete mark it read, so a snoozed reminder notifies again.
-- task_id is from the old Tasks feature and is no longer set.
CREATE TABLE IF NOT EXISTS notifications (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  channel ENUM('portal', 'email', 'teams') NOT NULL DEFAULT 'portal',
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  body VARCHAR(500) NULL,
  link VARCHAR(500) NULL,
  task_id INT UNSIGNED NULL,
  reminder_id INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at DATETIME NULL,
  read_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_notifications_user (user_id, read_at, created_at),
  KEY idx_notifications_reminder (reminder_id),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_notifications_task FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Signed-in sessions, for "Active sessions" on My profile. The session itself lives in
-- the express-mysql-session "sessions" table; this row records who, which device and
-- when. Signing a session out destroys it in the store and deletes this row.
CREATE TABLE IF NOT EXISTS user_sessions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id VARCHAR(128) NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  user_agent VARCHAR(500) NULL,
  ip VARCHAR(64) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_active DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_user_sessions_session (session_id),
  KEY idx_user_sessions_user (user_id, last_active),
  CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every email the portal tries to send (src/lib/mailer.js): reminders and Daily Reports.
CREATE TABLE IF NOT EXISTS email_log (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NULL,
  kind VARCHAR(30) NOT NULL,
  to_addresses VARCHAR(1000) NOT NULL,
  cc_addresses VARCHAR(1000) NULL,
  subject VARCHAR(255) NOT NULL,
  status ENUM('sent', 'failed') NOT NULL,
  error VARCHAR(1000) NULL,
  message_id VARCHAR(255) NULL,
  reminder_id INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_email_log_user (user_id, kind, created_at),
  KEY idx_email_log_reminder (reminder_id),
  CONSTRAINT fk_email_log_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Daily Report wording, edited on the Settings page.
-- Actions: template uses {client} and {subjects}; phrase_type picks which issue phrase fills {subjects}.
CREATE TABLE IF NOT EXISTS report_actions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  template VARCHAR(255) NOT NULL,
  phrase_type ENUM('problem', 'config') NOT NULL DEFAULT 'problem',
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uq_report_actions_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Issues: problem_phrase for problem actions ("Outlook connectivity and mailbox"),
-- config_phrase for config actions ("Outlook profiles and mailboxes").
CREATE TABLE IF NOT EXISTS report_issues (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  problem_phrase VARCHAR(255) NOT NULL,
  config_phrase VARCHAR(255) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_report_issues_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Upgrades for databases created before a column/value was added (safe to re-run).
-- Missing columns are added by scripts/migrate.js (MySQL has no ADD COLUMN IF NOT EXISTS).
-- Priority rows in ticket_history have no status.
ALTER TABLE ticket_history
  MODIFY new_status ENUM('open', 'customer_waiting', 'closed') NULL;

ALTER TABLE activity_log
  MODIFY entity_type ENUM('ticket', 'ticket_comment', 'client_service', 'step', 'note', 'service',
                          'kb_article', 'tutorial', 'client', 'user', 'setting', 'task', 'reminder', 'report', 'inv_person', 'inv_asset', 'inv_stock',
                   'inv_access', 'inv_shared', 'inv_setting', 'inv_record', 'inv_item', 'inv_config', 'inv_secret', 'manual') NOT NULL;

ALTER TABLE activity_log
  MODIFY action ENUM('created', 'updated', 'status_changed', 'commented', 'step_done', 'closed',
              'reopened', 'deleted', 'uploaded', 'completed', 'sent', 'assigned', 'returned', 'viewed', 'copied', 'exported') NOT NULL;
