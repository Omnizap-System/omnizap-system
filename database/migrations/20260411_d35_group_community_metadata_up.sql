-- D+35 (2026-04-11) - Group community metadata
-- Scope: persist parent community relations and community flags in groups_metadata

SET @migration_key := '20260411_d35_group_community_metadata';

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

CALL __ensure_column('groups_metadata', 'linked_parent_jid', 'ALTER TABLE groups_metadata ADD COLUMN linked_parent_jid VARCHAR(255) NULL AFTER creation');
CALL __ensure_column('groups_metadata', 'is_community', 'ALTER TABLE groups_metadata ADD COLUMN is_community TINYINT(1) NULL AFTER linked_parent_jid');
CALL __ensure_column('groups_metadata', 'is_community_announce', 'ALTER TABLE groups_metadata ADD COLUMN is_community_announce TINYINT(1) NULL AFTER is_community');
CALL __ensure_column('groups_metadata', 'member_add_mode', 'ALTER TABLE groups_metadata ADD COLUMN member_add_mode TINYINT(1) NULL AFTER is_community_announce');
CALL __ensure_column('groups_metadata', 'join_approval_mode', 'ALTER TABLE groups_metadata ADD COLUMN join_approval_mode TINYINT(1) NULL AFTER member_add_mode');
CALL __ensure_column('groups_metadata', 'addressing_mode', 'ALTER TABLE groups_metadata ADD COLUMN addressing_mode VARCHAR(8) NULL AFTER join_approval_mode');

CALL __ensure_index('groups_metadata', 'idx_groups_metadata_linked_parent_jid', 'CREATE INDEX idx_groups_metadata_linked_parent_jid ON groups_metadata (linked_parent_jid)');
CALL __ensure_index('groups_metadata', 'idx_groups_metadata_is_community_parent', 'CREATE INDEX idx_groups_metadata_is_community_parent ON groups_metadata (is_community, linked_parent_jid)');

INSERT INTO schema_change_log (migration_key, phase, status, notes)
VALUES (@migration_key, 'D+35', 'applied', 'groups_metadata community columns and indexes')
ON DUPLICATE KEY UPDATE
  phase = VALUES(phase),
  status = 'applied',
  notes = VALUES(notes),
  updated_at = CURRENT_TIMESTAMP;

DROP PROCEDURE IF EXISTS __ensure_column;
DROP PROCEDURE IF EXISTS __ensure_index;
