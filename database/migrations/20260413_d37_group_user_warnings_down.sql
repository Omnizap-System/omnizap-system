-- D+37 rollback

SET @migration_key := '20260413_d37_group_user_warnings';

DROP TABLE IF EXISTS `group_user_warnings`;

UPDATE schema_change_log
   SET status = 'rolled_back',
       notes = 'D+37 rollback executed',
       updated_at = CURRENT_TIMESTAMP
 WHERE migration_key = @migration_key;
