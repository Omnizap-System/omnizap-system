-- D+36 rollback

SET @migration_key := '20260412_d36_system_config_tables';

INSERT INTO `group_configs` (`id`, `config`, `updated_at`)
SELECT
  'system:premium_users' AS `id`,
  JSON_OBJECT('premiumUsers', COALESCE(JSON_ARRAYAGG(`id`), JSON_ARRAY())) AS `config`,
  CURRENT_TIMESTAMP AS `updated_at`
FROM `system_premium_users`
ON DUPLICATE KEY UPDATE
  `config` = VALUES(`config`),
  `updated_at` = CURRENT_TIMESTAMP;

INSERT INTO `group_configs` (`id`, `config`, `updated_at`)
SELECT
  'system:ai_prompts' AS `id`,
  JSON_OBJECT('prompts', COALESCE(JSON_OBJECTAGG(`id`, `prompt`), JSON_OBJECT())) AS `config`,
  CURRENT_TIMESTAMP AS `updated_at`
FROM `system_ai_prompts`
ON DUPLICATE KEY UPDATE
  `config` = VALUES(`config`),
  `updated_at` = CURRENT_TIMESTAMP;

DROP TABLE IF EXISTS `system_ai_prompts`;
DROP TABLE IF EXISTS `system_premium_users`;

UPDATE schema_change_log
   SET status = 'rolled_back',
       notes = 'D+36 rollback executed',
       updated_at = CURRENT_TIMESTAMP
 WHERE migration_key = @migration_key;
