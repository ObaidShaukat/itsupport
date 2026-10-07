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
                   'kb_article', 'tutorial', 'client', 'user', 'setting', 'task', 'inv_person', 'inv_asset', 'inv_stock',
                   'inv_access', 'inv_shared', 'inv_setting', 'manual') NOT NULL,
  entity_id INT UNSIGNED NULL,
  action ENUM('created', 'updated', 'status_changed', 'commented', 'step_done', 'closed',
              'reopened', 'deleted', 'uploaded', 'completed') NOT NULL,
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

-- ===================== Internal inventory (Cleartwo's own staff and kit) =====================
-- Never stores passwords, PINs or credentials: accounts only record that they exist,
-- with an "in 1Password" flag and an optional 1Password item link.

-- Editable lists.
CREATE TABLE IF NOT EXISTS inv_companies (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_companies_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inv_teams (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_teams_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- kind: 'asset' = tracked one record per item, 'stock' = counted by quantity.
CREATE TABLE IF NOT EXISTS inv_categories (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  kind ENUM('asset', 'stock') NOT NULL DEFAULT 'asset',
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_categories_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inv_apps (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_apps_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inv_people (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(150) NOT NULL,
  email VARCHAR(254) NULL,
  company_id INT UNSIGNED NULL,
  team_id INT UNSIGNED NULL,
  role VARCHAR(150) NULL,
  phone VARCHAR(50) NULL,
  start_date DATE NULL,
  status ENUM('active', 'left') NOT NULL DEFAULT 'active',
  leaving_date DATE NULL,
  notes TEXT NULL,
  created_by INT UNSIGNED NULL,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inv_people_status (status, name),
  CONSTRAINT fk_inv_people_company FOREIGN KEY (company_id) REFERENCES inv_companies (id) ON DELETE SET NULL,
  CONSTRAINT fk_inv_people_team FOREIGN KEY (team_id) REFERENCES inv_teams (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One record per physical item. asset_tag is issued in order: C2-0001, C2-0002, ...
CREATE TABLE IF NOT EXISTS inv_assets (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  asset_tag VARCHAR(20) NOT NULL,
  category_id INT UNSIGNED NULL,
  brand VARCHAR(100) NULL,
  model VARCHAR(255) NULL,
  serial_number VARCHAR(150) NULL,
  device_name VARCHAR(150) NULL,
  wifi_mac VARCHAR(50) NULL,
  ethernet_mac VARCHAR(50) NULL,
  specifications TEXT NULL,
  purchase_date DATE NULL,
  location VARCHAR(150) NULL,
  status ENUM('in_use', 'spare', 'repair', 'damaged', 'sold', 'disposed') NOT NULL DEFAULT 'spare',
  person_id INT UNSIGNED NULL,
  sold_to VARCHAR(150) NULL,
  sold_date DATE NULL,
  notes TEXT NULL,
  created_by INT UNSIGNED NULL,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_inv_assets_tag (asset_tag),
  KEY idx_inv_assets_serial (serial_number),
  KEY idx_inv_assets_person (person_id),
  CONSTRAINT fk_inv_assets_category FOREIGN KEY (category_id) REFERENCES inv_categories (id) ON DELETE SET NULL,
  CONSTRAINT fk_inv_assets_person FOREIGN KEY (person_id) REFERENCES inv_people (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Who had an asset and when. assigned_until is NULL while they still have it.
CREATE TABLE IF NOT EXISTS inv_asset_assignments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  asset_id INT UNSIGNED NOT NULL,
  person_id INT UNSIGNED NULL,
  person_name VARCHAR(150) NOT NULL,
  assigned_from DATE NULL,
  assigned_until DATE NULL,
  notes VARCHAR(255) NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inv_asset_assignments_asset (asset_id, assigned_until),
  KEY idx_inv_asset_assignments_person (person_id),
  CONSTRAINT fk_inv_asset_assignments_asset FOREIGN KEY (asset_id) REFERENCES inv_assets (id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_asset_assignments_person FOREIGN KEY (person_id) REFERENCES inv_people (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bulk accessories counted by quantity. Available = total - assigned - damaged.
CREATE TABLE IF NOT EXISTS inv_stock (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  category_id INT UNSIGNED NULL,
  brand VARCHAR(100) NULL,
  model VARCHAR(255) NOT NULL,
  connection ENUM('wired', 'wireless', 'na') NOT NULL DEFAULT 'na',
  location VARCHAR(150) NULL,
  total_qty INT UNSIGNED NOT NULL DEFAULT 0,
  damaged_qty INT UNSIGNED NOT NULL DEFAULT 0,
  notes TEXT NULL,
  created_by INT UNSIGNED NULL,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_inv_stock_category FOREIGN KEY (category_id) REFERENCES inv_categories (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Quantities of a stock item held by a person. returned_at is NULL while they have them.
CREATE TABLE IF NOT EXISTS inv_stock_assignments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  stock_id INT UNSIGNED NOT NULL,
  person_id INT UNSIGNED NOT NULL,
  quantity INT UNSIGNED NOT NULL DEFAULT 1,
  assigned_at DATE NULL,
  returned_at DATE NULL,
  notes VARCHAR(255) NULL,
  created_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inv_stock_assignments_stock (stock_id, returned_at),
  KEY idx_inv_stock_assignments_person (person_id, returned_at),
  CONSTRAINT fk_inv_stock_assignments_stock FOREIGN KEY (stock_id) REFERENCES inv_stock (id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_stock_assignments_person FOREIGN KEY (person_id) REFERENCES inv_people (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A person's accounts. Records only that an account exists: NO passwords, PINs or keys.
CREATE TABLE IF NOT EXISTS inv_access (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  person_id INT UNSIGNED NOT NULL,
  app_id INT UNSIGNED NULL,
  username VARCHAR(254) NULL,
  granted_date DATE NULL,
  granted_by VARCHAR(150) NULL,
  status ENUM('active', 'removed') NOT NULL DEFAULT 'active',
  removed_date DATE NULL,
  in_1password TINYINT(1) NOT NULL DEFAULT 0,
  onepassword_link VARCHAR(500) NULL,
  notes TEXT NULL,
  created_by INT UNSIGNED NULL,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inv_access_person (person_id, status),
  CONSTRAINT fk_inv_access_person FOREIGN KEY (person_id) REFERENCES inv_people (id) ON DELETE CASCADE,
  CONSTRAINT fk_inv_access_app FOREIGN KEY (app_id) REFERENCES inv_apps (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Shared / service accounts not tied to one person. Also no credentials.
CREATE TABLE IF NOT EXISTS inv_shared_accounts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(150) NOT NULL,
  app_id INT UNSIGNED NULL,
  account VARCHAR(254) NULL,
  purpose VARCHAR(255) NULL,
  owner_person_id INT UNSIGNED NULL,
  status ENUM('active', 'removed') NOT NULL DEFAULT 'active',
  in_1password TINYINT(1) NOT NULL DEFAULT 0,
  onepassword_link VARCHAR(500) NULL,
  notes TEXT NULL,
  created_by INT UNSIGNED NULL,
  updated_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  CONSTRAINT fk_inv_shared_app FOREIGN KEY (app_id) REFERENCES inv_apps (id) ON DELETE SET NULL,
  CONSTRAINT fk_inv_shared_owner FOREIGN KEY (owner_person_id) REFERENCES inv_people (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Offboarding checklist built when a person is marked as Left.
CREATE TABLE IF NOT EXISTS inv_offboarding_items (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  person_id INT UNSIGNED NOT NULL,
  item_type ENUM('asset', 'stock', 'access') NOT NULL,
  item_id INT UNSIGNED NOT NULL,
  label VARCHAR(255) NOT NULL,
  done TINYINT(1) NOT NULL DEFAULT 0,
  done_by INT UNSIGNED NULL,
  done_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inv_offboarding_person (person_id, done),
  CONSTRAINT fk_inv_offboarding_person FOREIGN KEY (person_id) REFERENCES inv_people (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Custom fields, managed in the portal. entity_type says which records they belong to;
-- category_id limits an asset/stock field to one category. options: one per line (dropdown).
CREATE TABLE IF NOT EXISTS custom_fields (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  label VARCHAR(100) NOT NULL,
  entity_type ENUM('person', 'asset', 'stock', 'access', 'shared') NOT NULL,
  field_type ENUM('text', 'longtext', 'number', 'date', 'select', 'boolean', 'link') NOT NULL DEFAULT 'text',
  options TEXT NULL,
  required TINYINT(1) NOT NULL DEFAULT 0,
  show_in_list TINYINT(1) NOT NULL DEFAULT 0,
  category_id INT UNSIGNED NULL,
  sort_order INT NOT NULL DEFAULT 0,
  hidden TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_custom_fields_entity (entity_type, hidden, sort_order),
  CONSTRAINT fk_custom_fields_category FOREIGN KEY (category_id) REFERENCES inv_categories (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS custom_field_values (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  field_id INT UNSIGNED NOT NULL,
  entity_type ENUM('person', 'asset', 'stock', 'access', 'shared') NOT NULL,
  entity_id INT UNSIGNED NOT NULL,
  value TEXT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_custom_field_values (field_id, entity_id),
  KEY idx_custom_field_values_entity (entity_type, entity_id),
  CONSTRAINT fk_custom_field_values_field FOREIGN KEY (field_id) REFERENCES custom_fields (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tasks (like Microsoft To Do). due_at / remind_at are chosen in UK time and stored
-- in UTC. reminder_sent_at is set once the reminder has become a notification.
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

-- Notifications. Only the 'portal' channel (bell + toast) is delivered today;
-- 'email' and 'teams' are reserved for later. delivered_at is when the toast was shown.
CREATE TABLE IF NOT EXISTS notifications (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  channel ENUM('portal', 'email', 'teams') NOT NULL DEFAULT 'portal',
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  body VARCHAR(500) NULL,
  link VARCHAR(500) NULL,
  task_id INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at DATETIME NULL,
  read_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_notifications_user (user_id, read_at, created_at),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_notifications_task FOREIGN KEY (task_id) REFERENCES tasks (id) ON DELETE SET NULL
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
                          'kb_article', 'tutorial', 'client', 'user', 'setting', 'task', 'inv_person', 'inv_asset', 'inv_stock',
                   'inv_access', 'inv_shared', 'inv_setting', 'manual') NOT NULL;

ALTER TABLE activity_log
  MODIFY action ENUM('created', 'updated', 'status_changed', 'commented', 'step_done', 'closed',
              'reopened', 'deleted', 'uploaded', 'completed') NOT NULL;
