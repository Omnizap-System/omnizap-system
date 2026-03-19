-- D0 rollback
-- Run with mysql client:
--   mysql -u$DB_USER -p$DB_PASSWORD -h$DB_HOST $DB_NAME < database/migrations/20260307_d0_hardening_down.sql

SET @migration_key := '20260307_d0_hardening';

DROP PROCEDURE IF EXISTS __ensure_index;
DROP PROCEDURE IF EXISTS __drop_index_if_exists;

DELIMITER $$
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

CREATE PROCEDURE __drop_index_if_exists(IN p_table_name VARCHAR(64), IN p_index_name VARCHAR(64))
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = p_table_name
       AND index_name = p_index_name
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table_name, '` DROP INDEX `', p_index_name, '`');
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

-- Restore redundant indexes removed in D0
CALL __ensure_index('sticker_pack_item', 'idx_sticker_pack_item_pack_position', 'CREATE INDEX idx_sticker_pack_item_pack_position ON sticker_pack_item (pack_id, position)');
CALL __ensure_index('domain_event_outbox_dlq', 'idx_domain_event_outbox_dlq_outbox_event_id', 'CREATE INDEX idx_domain_event_outbox_dlq_outbox_event_id ON domain_event_outbox_dlq (outbox_event_id)');
CALL __ensure_index('sticker_worker_task_dlq', 'idx_sticker_worker_task_dlq_task_id', 'CREATE INDEX idx_sticker_worker_task_dlq_task_id ON sticker_worker_task_dlq (task_id)');

-- Drop indexes added in D0
CALL __drop_index_if_exists('messages', 'idx_messages_sender_timestamp');
CALL __drop_index_if_exists('messages', 'idx_messages_chat_sender_timestamp');
CALL __drop_index_if_exists('domain_event_outbox', 'idx_domain_event_outbox_status_locked');
CALL __drop_index_if_exists('email_outbox', 'idx_email_outbox_status_locked');
CALL __drop_index_if_exists('sticker_worker_task_queue', 'idx_sticker_worker_task_queue_status_locked');
CALL __drop_index_if_exists('sticker_asset_reprocess_queue', 'idx_sticker_asset_reprocess_queue_status_locked');

UPDATE schema_change_log
   SET status = 'rolled_back',
       notes = 'D0 rollback executed',
       updated_at = CURRENT_TIMESTAMP
 WHERE migration_key = CONVERT(@migration_key USING utf8mb4) COLLATE utf8mb4_unicode_ci;

DROP PROCEDURE IF EXISTS __ensure_index;
DROP PROCEDURE IF EXISTS __drop_index_if_exists;
