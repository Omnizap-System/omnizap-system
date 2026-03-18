-- D+37 (2026-04-13) - Group moderation warnings
-- Scope: track warnings per participant inside each group

SET @migration_key := '20260413_d37_group_user_warnings';

CREATE TABLE IF NOT EXISTS `group_user_warnings` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `group_id` varchar(255) NOT NULL,
  `participant_jid` varchar(255) NOT NULL,
  `warned_by_jid` varchar(255) DEFAULT NULL,
  `reason` text DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_group_user_warnings_lookup` (`group_id`,`participant_jid`,`created_at`),
  KEY `idx_group_user_warnings_prune` (`group_id`,`participant_jid`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO schema_change_log (migration_key, phase, status, notes)
VALUES (@migration_key, 'D+37', 'applied', 'created group_user_warnings table for moderation warnings')
ON DUPLICATE KEY UPDATE
  phase = VALUES(phase),
  status = 'applied',
  notes = VALUES(notes),
  updated_at = CURRENT_TIMESTAMP;
