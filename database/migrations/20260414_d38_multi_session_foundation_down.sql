-- D+38 rollback

SET @migration_key := '20260414_d38_multi_session_foundation';

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

CALL __drop_index_if_exists('message_analysis_event', 'idx_message_analysis_session_command_created');
CALL __drop_index_if_exists('message_analysis_event', 'idx_message_analysis_session_sender_created');
CALL __drop_index_if_exists('message_analysis_event', 'idx_message_analysis_session_chat_created');
CALL __drop_index_if_exists('message_analysis_event', 'idx_message_analysis_session_created');

CALL __drop_index_if_exists('baileys_event_journal', 'idx_baileys_event_session_message_created');
CALL __drop_index_if_exists('baileys_event_journal', 'idx_baileys_event_session_chat_created');
CALL __drop_index_if_exists('baileys_event_journal', 'idx_baileys_event_session_name_created');
CALL __drop_index_if_exists('baileys_event_journal', 'idx_baileys_event_session_created');

CALL __drop_index_if_exists('messages', 'idx_messages_session_canonical_sender_timestamp');
CALL __drop_index_if_exists('messages', 'idx_messages_session_sender_timestamp');
CALL __drop_index_if_exists('messages', 'idx_messages_session_chat_timestamp');
CALL __drop_index_if_exists('messages', 'idx_messages_session_message_id');

CALL __drop_column_if_exists('message_analysis_event', 'session_id');
CALL __drop_column_if_exists('baileys_event_journal', 'session_id');
CALL __drop_column_if_exists('messages', 'session_id');

DROP TABLE IF EXISTS `group_assignment_history`;
DROP TABLE IF EXISTS `group_assignment`;
DROP TABLE IF EXISTS `wa_session_registry`;

UPDATE schema_change_log
   SET status = 'rolled_back',
       notes = 'D+38 rollback executed',
       updated_at = CURRENT_TIMESTAMP
 WHERE migration_key = @migration_key;

DROP PROCEDURE IF EXISTS __drop_column_if_exists;
DROP PROCEDURE IF EXISTS __drop_index_if_exists;
