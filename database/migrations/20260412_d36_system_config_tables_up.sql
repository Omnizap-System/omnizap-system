-- D+36 (2026-04-12) - Split system config records from group_configs
-- Scope: move `system:premium_users` and `system:ai_prompts` to dedicated tables

SET @migration_key := '20260412_d36_system_config_tables';

CREATE TABLE IF NOT EXISTS `system_premium_users` (
  `id` varchar(255) NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `system_ai_prompts` (
  `id` varchar(255) NOT NULL,
  `prompt` longtext NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `system_premium_users` (`id`)
SELECT DISTINCT jt.premium_jid
  FROM `group_configs` gc
  JOIN JSON_TABLE(
    COALESCE(JSON_EXTRACT(gc.config, '$.premiumUsers'), JSON_ARRAY()),
    '$[*]' COLUMNS (`premium_jid` VARCHAR(255) PATH '$')
  ) jt
 WHERE gc.id = 'system:premium_users'
   AND jt.premium_jid IS NOT NULL
   AND TRIM(jt.premium_jid) <> ''
ON DUPLICATE KEY UPDATE
  `updated_at` = CURRENT_TIMESTAMP;

INSERT INTO `system_ai_prompts` (`id`, `prompt`)
SELECT jt.prompt_jid,
       COALESCE(
         JSON_UNQUOTE(
           JSON_EXTRACT(
             JSON_EXTRACT(gc.config, '$.prompts'),
             CONCAT('$."', REPLACE(jt.prompt_jid, '"', '\\"'), '"')
           )
         ),
         ''
       ) AS prompt_text
  FROM `group_configs` gc
  JOIN JSON_TABLE(
    JSON_KEYS(COALESCE(JSON_EXTRACT(gc.config, '$.prompts'), JSON_OBJECT())),
    '$[*]' COLUMNS (`prompt_jid` VARCHAR(255) PATH '$')
  ) jt
 WHERE gc.id = 'system:ai_prompts'
   AND jt.prompt_jid IS NOT NULL
   AND TRIM(jt.prompt_jid) <> ''
ON DUPLICATE KEY UPDATE
  `prompt` = VALUES(`prompt`),
  `updated_at` = CURRENT_TIMESTAMP;

DELETE FROM `group_configs`
 WHERE id IN ('system:premium_users', 'system:ai_prompts');

INSERT INTO schema_change_log (migration_key, phase, status, notes)
VALUES (@migration_key, 'D+36', 'applied', 'split system:premium_users and system:ai_prompts into dedicated tables')
ON DUPLICATE KEY UPDATE
  phase = VALUES(phase),
  status = 'applied',
  notes = VALUES(notes),
  updated_at = CURRENT_TIMESTAMP;
