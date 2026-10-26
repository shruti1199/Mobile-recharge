CREATE TABLE IF NOT EXISTS wallets (
  id INT PRIMARY KEY,
  balance BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT chk_balance CHECK (balance >= 0)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS orders (
  id CHAR(36) PRIMARY KEY,
  wallet_id INT NOT NULL,
  idempotency_key VARCHAR(100) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  number VARCHAR(15) NOT NULL,
  operator VARCHAR(30) NOT NULL,
  amount BIGINT NOT NULL,
  status ENUM('INITIATED','PENDING','SUCCESS','FAILED','REFUNDED') NOT NULL,
  failure_reason VARCHAR(255) NULL,
  anomaly VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_wallet_idem (wallet_id, idempotency_key),
  KEY idx_status_created (status, created_at),
  FOREIGN KEY (wallet_id) REFERENCES wallets(id)
) ENGINE=InnoDB;

-- Append-only money ledger. DEBIT is negative, REFUND/TOPUP positive.
-- UNIQUE(order_id, entry_type) is the DB-level guarantee: one debit and at most one refund per order.
CREATE TABLE IF NOT EXISTS ledger (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  wallet_id INT NOT NULL,
  order_id CHAR(36) NULL,
  entry_type ENUM('DEBIT','REFUND','TOPUP') NOT NULL,
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_order_entry (order_id, entry_type),
  FOREIGN KEY (wallet_id) REFERENCES wallets(id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS order_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  order_id CHAR(36) NOT NULL,
  from_status VARCHAR(20) NULL,
  to_status VARCHAR(20) NOT NULL,
  source VARCHAR(30) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_order (order_id),
  FOREIGN KEY (order_id) REFERENCES orders(id)
) ENGINE=InnoDB;

-- Raw log of every callback received (audit/debugging only; correctness does NOT depend on it)
CREATE TABLE IF NOT EXISTS webhook_events (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(100) NULL,
  reference VARCHAR(64) NOT NULL,
  status VARCHAR(20) NOT NULL,
  result VARCHAR(30) NOT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_ref (reference)
) ENGINE=InnoDB;
