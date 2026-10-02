-- Cleartwo IT Support portal schema.
-- Safe to run repeatedly: every table is created only if it does not exist.
-- The sessions table is created automatically by express-mysql-session.

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(100) NOT NULL,
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
  created_by INT UNSIGNED NULL,
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
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ticket_comments_ticket (ticket_id, created_at),
  CONSTRAINT fk_ticket_comments_ticket FOREIGN KEY (ticket_id)
    REFERENCES tickets (id) ON DELETE CASCADE,
  CONSTRAINT fk_ticket_comments_user FOREIGN KEY (user_id)
    REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Status changes. old_status is NULL for the entry recorded when a ticket is created.
CREATE TABLE IF NOT EXISTS ticket_history (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NULL,
  old_status ENUM('open', 'customer_waiting', 'closed') NULL,
  new_status ENUM('open', 'customer_waiting', 'closed') NOT NULL,
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
                   'kb_article', 'tutorial', 'client', 'user', 'manual') NOT NULL,
  entity_id INT UNSIGNED NULL,
  action ENUM('created', 'updated', 'status_changed', 'commented', 'step_done', 'closed',
              'reopened', 'deleted', 'uploaded') NOT NULL,
  subject VARCHAR(255) NULL,
  summary TEXT NOT NULL,
  changes VARCHAR(255) NULL,
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

-- Upgrades for databases created before a column/value was added (safe to re-run).
-- Missing columns are added by scripts/migrate.js (MySQL has no ADD COLUMN IF NOT EXISTS).
ALTER TABLE activity_log
  MODIFY entity_type ENUM('ticket', 'ticket_comment', 'client_service', 'step', 'note', 'service',
                          'kb_article', 'tutorial', 'client', 'user', 'manual') NOT NULL;
