CREATE TABLE IF NOT EXISTS accounts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  username VARCHAR(32) NOT NULL,
  display_name VARCHAR(32) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY accounts_username_unique (username)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS ledger_groups (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(80) NOT NULL,
  invite_code CHAR(16) NOT NULL,
  created_by INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY ledger_groups_invite_unique (invite_code),
  CONSTRAINT ledger_groups_creator_fk FOREIGN KEY (created_by) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS group_members (
  group_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  role ENUM('owner', 'admin', 'member') NOT NULL DEFAULT 'member',
  joined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, user_id),
  CONSTRAINT group_members_group_fk FOREIGN KEY (group_id) REFERENCES ledger_groups(id) ON DELETE CASCADE,
  CONSTRAINT group_members_account_fk FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS group_join_requests (
  group_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  status ENUM('pending', 'rejected') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES ledger_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS group_invitations (
  group_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  invited_by INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES ledger_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64) NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (token_hash),
  INDEX sessions_expiry_idx (expires_at),
  CONSTRAINT sessions_account_fk FOREIGN KEY (user_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS expenses (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  entry_type ENUM('expense', 'income', 'transfer') NOT NULL DEFAULT 'expense',
  transfer_direction ENUM('to_savings','from_savings') NULL,
  group_id INT UNSIGNED NOT NULL,
  date DATE NOT NULL,
  transaction_time TIME NULL,
  merchant VARCHAR(100) NOT NULL,
  product_name VARCHAR(100) NOT NULL DEFAULT '',
  note VARCHAR(250) NOT NULL DEFAULT '',
  category VARCHAR(20) NOT NULL,
  amount_cents BIGINT UNSIGNED NOT NULL,
  payer_user_id INT UNSIGNED NULL,
  payer VARCHAR(80) NOT NULL DEFAULT '',
  created_by INT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX expenses_group_date_idx (group_id, date DESC, id DESC),
  CONSTRAINT expenses_amount_positive CHECK (amount_cents > 0),
  CONSTRAINT expenses_group_fk FOREIGN KEY (group_id) REFERENCES ledger_groups(id) ON DELETE CASCADE,
  CONSTRAINT expenses_payer_fk FOREIGN KEY (payer_user_id) REFERENCES accounts(id),
  CONSTRAINT expenses_creator_fk FOREIGN KEY (created_by) REFERENCES accounts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS tasks (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, group_id INT UNSIGNED NOT NULL,
    created_by INT UNSIGNED NOT NULL, assignee_id INT UNSIGNED NOT NULL,
    title VARCHAR(160) NOT NULL, details TEXT NOT NULL,
    kind ENUM('reminder','generate_text','ledger_summary') NOT NULL DEFAULT 'reminder',
    status ENUM('pending','running','waiting','completed','failed','cancelled') NOT NULL DEFAULT 'pending',
    due_at DATETIME NULL, target ENUM('group','private') NOT NULL DEFAULT 'group', target_openid VARCHAR(128) NOT NULL DEFAULT '',
    result TEXT NULL, error VARCHAR(500) NULL, request_id VARCHAR(80) NOT NULL,
    delivery_status ENUM('none','pending','sending','sent','failed') NOT NULL DEFAULT 'none',
    delivery_error VARCHAR(500) NULL, delivery_attempts INT UNSIGNED NOT NULL DEFAULT 0,
    delivery_after DATETIME NULL, delivered_at DATETIME NULL,
    lease_token VARCHAR(36) NULL, lease_until DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    completed_at DATETIME NULL,
    recurrence JSON NULL, series_id INT UNSIGNED NULL,
    UNIQUE KEY task_request_idx (group_id, created_by, request_id),
    INDEX task_due_idx (status, due_at), INDEX task_delivery_idx (delivery_status, delivery_after),
    FOREIGN KEY (group_id) REFERENCES ledger_groups(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES accounts(id), FOREIGN KEY (assignee_id) REFERENCES accounts(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
