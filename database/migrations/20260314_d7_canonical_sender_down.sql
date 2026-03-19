-- D+7 rollback

SET @migration_key := '20260314_d7_canonical_sender';

DROP PROCEDURE IF EXISTS __drop_column_if_exists;
DROP PROCEDURE IF EXISTS __drop_index_if_exists;

DELIMITER $$
CREATE PROCEDURE __drop_column_if_exists(IN p_table_name VARCHAR(64), IN p_column_name VARCHAR(64))
BEGIN
  IF EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = DATABASE()
       AND table_name = p_table_name
       AND column_name = p_column_name
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE `', p_table_name, '` DROP COLUMN `', p_column_name, '`');
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

CALL __drop_index_if_exists('messages', 'idx_messages_chat_canonical_sender_timestamp');
CALL __drop_index_if_exists('messages', 'idx_messages_canonical_sender_timestamp');
CALL __drop_column_if_exists('messages', 'canonical_sender_id');

UPDATE schema_change_log
   SET status = 'rolled_back',
       notes = 'D+7 rollback executed',
       updated_at = CURRENT_TIMESTAMP
 WHERE migration_key = CONVERT(@migration_key USING utf8mb4) COLLATE utf8mb4_unicode_ci;

DROP PROCEDURE IF EXISTS __drop_column_if_exists;
DROP PROCEDURE IF EXISTS __drop_index_if_exists;
