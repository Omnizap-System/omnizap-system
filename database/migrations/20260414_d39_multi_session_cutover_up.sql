-- D+39 (2026-04-14) - Multi-session message uniqueness cutover
-- Scope: replace global unique(message_id) with unique(session_id, message_id)

SET @migration_key := '20260414_d39_multi_session_cutover';

DROP PROCEDURE IF EXISTS __assert_column_exists;
DROP PROCEDURE IF EXISTS __drop_index_if_exists;
DROP PROCEDURE IF EXISTS __ensure_unique_index;

DELIMITER $$
CREATE PROCEDURE __assert_column_exists(IN p_table_name VARCHAR(64), IN p_column_name VARCHAR(64))
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = p_table_name
       AND column_name = p_column_name
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'D+39 requer coluna session_id previamente criada (execute D+38 antes).';
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

CREATE PROCEDURE __ensure_unique_index(IN p_table_name VARCHAR(64), IN p_index_name VARCHAR(64), IN p_ddl TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.statistics
     WHERE table_schema = DATABASE()
       AND table_name = p_table_name
       AND index_name = p_index_name
       AND non_unique = 0
  ) THEN
    SET @ddl = p_ddl;
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END$$
DELIMITER ;

CALL __assert_column_exists('messages', 'session_id');

-- Remove índice legado global e índice não-único redundante da fase D+38.
CALL __drop_index_if_exists('messages', 'message_id');
CALL __drop_index_if_exists('messages', 'uq_messages_message_id');
CALL __drop_index_if_exists('messages', 'uniq_messages_message_id');
CALL __drop_index_if_exists('messages', 'idx_messages_session_message_id');

-- Novo contrato de unicidade por sessão.
CALL __ensure_unique_index(
  'messages',
  'uq_messages_session_message_id',
  'CREATE UNIQUE INDEX uq_messages_session_message_id ON messages (session_id, message_id)'
);

INSERT INTO schema_change_log (migration_key, phase, status, notes)
VALUES (@migration_key, 'D+39', 'applied', 'messages uniqueness changed to (session_id, message_id)')
ON DUPLICATE KEY UPDATE
  phase = VALUES(phase),
  status = 'applied',
  notes = VALUES(notes),
  updated_at = CURRENT_TIMESTAMP;

DROP PROCEDURE IF EXISTS __assert_column_exists;
DROP PROCEDURE IF EXISTS __drop_index_if_exists;
DROP PROCEDURE IF EXISTS __ensure_unique_index;
