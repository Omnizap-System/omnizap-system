-- D+38 (2026-04-14) - Multi-session foundation
-- Scope:
-- 1) add group ownership/session registry tables
-- 2) add session_id scoping columns to high-traffic WhatsApp tables
-- 3) add session-aware composite indexes

SET @migration_key := '20260414_d38_multi_session_foundation';

DROP PROCEDURE IF EXISTS __ensure_column;
DROP PROCEDURE IF EXISTS __ensure_index;

DELIMITER $$
CREATE PROCEDURE __ensure_column(IN p_table_name VARCHAR(64), IN p_column_name VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = p_table_name
       AND column_name = p_column_name
  ) THEN
    SET @ddl = p_ddl;
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$

CREATE PROCEDURE __ensure_index(IN p_table_name VARCHAR(64), IN p_index_name VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = p_table_name
       AND index_name = p_index_name
  ) THEN
    SET @ddl = p_ddl;
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

CREATE TABLE IF NOT EXISTS `wa_session_registry` (
  `session_id` varchar(64) NOT NULL,
  `bot_jid` varchar(255) DEFAULT NULL,
  `status` varchar(24) NOT NULL DEFAULT 'offline',
  `capacity_weight` int(10) unsigned NOT NULL DEFAULT 1,
  `current_score` decimal(12,4) NOT NULL DEFAULT 0.0000,
  `last_heartbeat_at` datetime DEFAULT NULL,
  `last_connected_at` datetime DEFAULT NULL,
  `last_disconnected_at` datetime DEFAULT NULL,
  `metadata` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`metadata`)),
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`session_id`),
  KEY `idx_wa_session_registry_status_updated` (`status`,`updated_at`),
  KEY `idx_wa_session_registry_heartbeat` (`last_heartbeat_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `group_assignment` (
  `group_jid` varchar(255) NOT NULL,
  `owner_session_id` varchar(64) NOT NULL,
  `lease_expires_at` datetime NOT NULL,
  `cooldown_until` datetime DEFAULT NULL,
  `assignment_version` bigint(20) unsigned NOT NULL DEFAULT 1,
  `pinned` tinyint(1) NOT NULL DEFAULT 0,
  `last_reason` varchar(64) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`group_jid`),
  KEY `idx_group_assignment_owner_lease` (`owner_session_id`,`lease_expires_at`),
  KEY `idx_group_assignment_lease` (`lease_expires_at`),
  KEY `idx_group_assignment_cooldown` (`cooldown_until`),
  KEY `idx_group_assignment_pinned_updated` (`pinned`,`updated_at`),
  CONSTRAINT `fk_group_assignment_owner_session` FOREIGN KEY (`owner_session_id`) REFERENCES `wa_session_registry` (`session_id`) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `group_assignment_history` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `group_jid` varchar(255) NOT NULL,
  `previous_session_id` varchar(64) DEFAULT NULL,
  `new_session_id` varchar(64) NOT NULL,
  `change_reason` varchar(64) DEFAULT NULL,
  `changed_by` varchar(64) NOT NULL DEFAULT 'system',
  `assignment_version` bigint(20) unsigned NOT NULL,
  `metadata` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`metadata`)),
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_group_assignment_history_group_created` (`group_jid`,`created_at`),
  KEY `idx_group_assignment_history_new_session_created` (`new_session_id`,`created_at`),
  KEY `idx_group_assignment_history_prev_session_created` (`previous_session_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CALL __ensure_column('messages', 'session_id', 'ALTER TABLE messages ADD COLUMN session_id VARCHAR(64) NOT NULL DEFAULT ''default'' AFTER message_id');
CALL __ensure_column('baileys_event_journal', 'session_id', 'ALTER TABLE baileys_event_journal ADD COLUMN session_id VARCHAR(64) NOT NULL DEFAULT ''default'' AFTER id');
CALL __ensure_column('message_analysis_event', 'session_id', 'ALTER TABLE message_analysis_event ADD COLUMN session_id VARCHAR(64) NOT NULL DEFAULT ''default'' AFTER id');

CALL __ensure_index('messages', 'idx_messages_session_message_id', 'CREATE INDEX idx_messages_session_message_id ON messages (session_id, message_id)');
CALL __ensure_index('messages', 'idx_messages_session_chat_timestamp', 'CREATE INDEX idx_messages_session_chat_timestamp ON messages (session_id, chat_id, timestamp)');
CALL __ensure_index('messages', 'idx_messages_session_sender_timestamp', 'CREATE INDEX idx_messages_session_sender_timestamp ON messages (session_id, sender_id, timestamp)');
CALL __ensure_index('messages', 'idx_messages_session_canonical_sender_timestamp', 'CREATE INDEX idx_messages_session_canonical_sender_timestamp ON messages (session_id, canonical_sender_id, timestamp)');

CALL __ensure_index('baileys_event_journal', 'idx_baileys_event_session_created', 'CREATE INDEX idx_baileys_event_session_created ON baileys_event_journal (session_id, created_at)');
CALL __ensure_index('baileys_event_journal', 'idx_baileys_event_session_name_created', 'CREATE INDEX idx_baileys_event_session_name_created ON baileys_event_journal (session_id, event_name, created_at)');
CALL __ensure_index('baileys_event_journal', 'idx_baileys_event_session_chat_created', 'CREATE INDEX idx_baileys_event_session_chat_created ON baileys_event_journal (session_id, chat_id, created_at)');
CALL __ensure_index('baileys_event_journal', 'idx_baileys_event_session_message_created', 'CREATE INDEX idx_baileys_event_session_message_created ON baileys_event_journal (session_id, message_id, created_at)');

CALL __ensure_index('message_analysis_event', 'idx_message_analysis_session_created', 'CREATE INDEX idx_message_analysis_session_created ON message_analysis_event (session_id, created_at)');
CALL __ensure_index('message_analysis_event', 'idx_message_analysis_session_chat_created', 'CREATE INDEX idx_message_analysis_session_chat_created ON message_analysis_event (session_id, chat_id, created_at)');
CALL __ensure_index('message_analysis_event', 'idx_message_analysis_session_sender_created', 'CREATE INDEX idx_message_analysis_session_sender_created ON message_analysis_event (session_id, sender_id, created_at)');
CALL __ensure_index('message_analysis_event', 'idx_message_analysis_session_command_created', 'CREATE INDEX idx_message_analysis_session_command_created ON message_analysis_event (session_id, command_name, created_at)');

INSERT INTO schema_change_log (migration_key, phase, status, notes)
VALUES (@migration_key, 'D+38', 'applied', 'multi-session foundation tables and session-scoped indexes')
ON DUPLICATE KEY UPDATE
  phase = VALUES(phase),
  status = 'applied',
  notes = VALUES(notes),
  updated_at = CURRENT_TIMESTAMP;

DROP PROCEDURE IF EXISTS __ensure_column;
DROP PROCEDURE IF EXISTS __ensure_index;
