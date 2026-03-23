-- D+39 rollback

SET @migration_key := '20260414_d39_multi_session_cutover';

DROP PROCEDURE IF EXISTS __drop_index_if_exists;
DROP PROCEDURE IF EXISTS __ensure_unique_index;
DROP PROCEDURE IF EXISTS __ensure_index;
DROP PROCEDURE IF EXISTS __assert_no_global_message_duplicates;

DELIMITER $$
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

CREATE PROCEDURE __assert_no_global_message_duplicates()
BEGIN
  DECLARE v_dup_exists INT DEFAULT 0;

  SELECT
    CASE
      WHEN EXISTS (
        SELECT 1
          FROM messages
         GROUP BY message_id
        HAVING COUNT(*) > 1
         LIMIT 1
      ) THEN 1
      ELSE 0
    END
    INTO v_dup_exists;

  IF v_dup_exists = 1 THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'Rollback D+39 bloqueado: existem message_id duplicados entre sessoes.';
  END IF;
END$$
DELIMITER ;

CALL __assert_no_global_message_duplicates();

CALL __drop_index_if_exists('messages', 'uq_messages_session_message_id');

-- Retorna ao estado da fase D+38:
-- 1) índice único global em message_id
-- 2) índice não-único de apoio em (session_id, message_id)
CALL __ensure_unique_index('messages', 'message_id', 'CREATE UNIQUE INDEX message_id ON messages (message_id)');
CALL __ensure_index('messages', 'idx_messages_session_message_id', 'CREATE INDEX idx_messages_session_message_id ON messages (session_id, message_id)');

UPDATE schema_change_log
   SET status = 'rolled_back',
       notes = 'D+39 rollback executed',
       updated_at = CURRENT_TIMESTAMP
 WHERE migration_key = @migration_key;

DROP PROCEDURE IF EXISTS __drop_index_if_exists;
DROP PROCEDURE IF EXISTS __ensure_unique_index;
DROP PROCEDURE IF EXISTS __ensure_index;
DROP PROCEDURE IF EXISTS __assert_no_global_message_duplicates;
