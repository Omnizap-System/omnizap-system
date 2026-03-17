-- D+35 rollback

SET @migration_key := '20260411_d35_group_community_metadata';

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

CALL __drop_index_if_exists('groups_metadata', 'idx_groups_metadata_is_community_parent');
CALL __drop_index_if_exists('groups_metadata', 'idx_groups_metadata_linked_parent_jid');

CALL __drop_column_if_exists('groups_metadata', 'addressing_mode');
CALL __drop_column_if_exists('groups_metadata', 'join_approval_mode');
CALL __drop_column_if_exists('groups_metadata', 'member_add_mode');
CALL __drop_column_if_exists('groups_metadata', 'is_community_announce');
CALL __drop_column_if_exists('groups_metadata', 'is_community');
CALL __drop_column_if_exists('groups_metadata', 'linked_parent_jid');

UPDATE schema_change_log
   SET status = 'rolled_back',
       notes = 'D+35 rollback executed',
       updated_at = CURRENT_TIMESTAMP
 WHERE migration_key = @migration_key;

DROP PROCEDURE IF EXISTS __drop_column_if_exists;
DROP PROCEDURE IF EXISTS __drop_index_if_exists;
