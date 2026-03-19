-- D+30 rollback

SET @migration_key := '20260406_d30_security_analytics';

DROP EVENT IF EXISTS ev_rollup_message_activity_daily;
DROP EVENT IF EXISTS ev_purge_baileys_event_journal;
DROP EVENT IF EXISTS ev_purge_message_analysis_event;
DROP EVENT IF EXISTS ev_purge_web_visit_event;
DROP EVENT IF EXISTS ev_purge_sticker_pack_interaction_event;

DROP PROCEDURE IF EXISTS __drop_check_if_exists;
DROP PROCEDURE IF EXISTS __drop_index_if_exists;
DROP PROCEDURE IF EXISTS __drop_column_if_exists;

DELIMITER $$
CREATE PROCEDURE __drop_check_if_exists(IN p_table_name VARCHAR(64), IN p_constraint_name VARCHAR(128))
BEGIN
  DECLARE v_is_mariadb TINYINT DEFAULT 0;

  SET v_is_mariadb = IF(VERSION() LIKE '%MariaDB%', 1, 0);

  IF EXISTS (
    SELECT 1
      FROM information_schema.table_constraints
     WHERE table_schema = DATABASE()
       AND table_name = p_table_name
       AND constraint_name = p_constraint_name
       AND constraint_type = 'CHECK'
  ) THEN
    IF v_is_mariadb = 1 THEN
      SET @ddl = CONCAT('ALTER TABLE `', p_table_name, '` DROP CONSTRAINT `', p_constraint_name, '`');
    ELSE
      SET @ddl = CONCAT('ALTER TABLE `', p_table_name, '` DROP CHECK `', p_constraint_name, '`');
    END IF;
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
DELIMITER ;

CALL __drop_check_if_exists('feature_flag', 'chk_feature_flag_rollout_percent');
CALL __drop_check_if_exists('domain_event_outbox', 'chk_domain_event_outbox_attempts');
CALL __drop_check_if_exists('email_outbox', 'chk_email_outbox_attempts');
CALL __drop_check_if_exists('sticker_worker_task_queue', 'chk_sticker_worker_task_queue_attempts');
CALL __drop_check_if_exists('sticker_asset_reprocess_queue', 'chk_sticker_asset_reprocess_queue_attempts');
CALL __drop_check_if_exists('rpg_karma_vote_history', 'chk_rpg_karma_vote_value');
CALL __drop_check_if_exists('rpg_social_link', 'chk_rpg_social_link_distinct_users');

DROP TABLE IF EXISTS message_activity_daily;

CALL __drop_index_if_exists('web_google_session', 'uq_web_google_session_token_hash');
CALL __drop_column_if_exists('web_google_session', 'session_token_hash');

UPDATE schema_change_log
   SET status = 'rolled_back',
       notes = 'D+30 rollback executed',
       updated_at = CURRENT_TIMESTAMP
 WHERE migration_key = CONVERT(@migration_key USING utf8mb4) COLLATE utf8mb4_unicode_ci;

DROP PROCEDURE IF EXISTS __drop_check_if_exists;
DROP PROCEDURE IF EXISTS __drop_index_if_exists;
DROP PROCEDURE IF EXISTS __drop_column_if_exists;
