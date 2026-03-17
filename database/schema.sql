-- Schema consolidado para bootstrap sem migrations.
-- Gerado a partir do estado atual do banco.
SET FOREIGN_KEY_CHECKS = 0;
CREATE TABLE IF NOT EXISTS `admin_action_audit` (
  `id` char(36) NOT NULL,
  `admin_role` varchar(32) NOT NULL DEFAULT 'owner',
  `admin_google_sub` varchar(255) DEFAULT NULL,
  `admin_email` varchar(255) DEFAULT NULL,
  `admin_owner_jid` varchar(255) DEFAULT NULL,
  `action` varchar(96) NOT NULL,
  `target_type` varchar(64) DEFAULT NULL,
  `target_id` varchar(255) DEFAULT NULL,
  `status` varchar(32) NOT NULL DEFAULT 'success',
  `details` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`details`)),
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_admin_action_audit_created` (`created_at`),
  KEY `idx_admin_action_audit_action_created` (`action`,`created_at`),
  KEY `idx_admin_action_audit_admin_created` (`admin_google_sub`,`admin_email`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `chats` (
  `id` varchar(255) NOT NULL,
  `name` varchar(255) DEFAULT NULL,
  `raw_chat` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`raw_chat`)),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `schema_change_log` (
  `migration_key` varchar(128) NOT NULL,
  `phase` varchar(32) NOT NULL,
  `status` enum('applied','rolled_back') NOT NULL DEFAULT 'applied',
  `notes` varchar(255) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`migration_key`),
  KEY `idx_schema_change_log_phase_status` (`phase`,`status`,`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `domain_event_outbox` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `event_type` varchar(96) NOT NULL,
  `aggregate_type` varchar(96) NOT NULL,
  `aggregate_id` varchar(128) NOT NULL,
  `payload` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`payload`)),
  `status` enum('pending','processing','completed','failed') NOT NULL DEFAULT 'pending',
  `priority` tinyint(3) unsigned NOT NULL DEFAULT 50,
  `idempotency_key` varchar(180) DEFAULT NULL,
  `available_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `attempts` tinyint(3) unsigned NOT NULL DEFAULT 0,
  `max_attempts` tinyint(3) unsigned NOT NULL DEFAULT 10,
  `worker_token` char(36) DEFAULT NULL,
  `last_error` varchar(255) DEFAULT NULL,
  `locked_at` timestamp NULL DEFAULT NULL,
  `processed_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_domain_event_outbox_idempotency_key` (`idempotency_key`),
  KEY `idx_domain_event_outbox_status_sched` (`status`,`available_at`,`priority`),
  KEY `idx_domain_event_outbox_event_type` (`event_type`,`status`,`available_at`),
  KEY `idx_domain_event_outbox_aggregate` (`aggregate_type`,`aggregate_id`,`created_at`),
  KEY `idx_domain_event_outbox_worker_token` (`worker_token`),
  KEY `idx_domain_event_outbox_status_locked` (`status`,`locked_at`),
  CONSTRAINT `chk_domain_event_outbox_attempts` CHECK (`attempts` <= `max_attempts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `domain_event_outbox_dlq` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `outbox_event_id` bigint(20) unsigned DEFAULT NULL,
  `event_type` varchar(96) NOT NULL,
  `aggregate_type` varchar(96) NOT NULL,
  `aggregate_id` varchar(128) NOT NULL,
  `payload` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`payload`)),
  `attempts` tinyint(3) unsigned NOT NULL DEFAULT 0,
  `max_attempts` tinyint(3) unsigned NOT NULL DEFAULT 0,
  `last_error` varchar(255) DEFAULT NULL,
  `failed_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_domain_event_outbox_dlq_outbox_event` (`outbox_event_id`),
  KEY `idx_domain_event_outbox_dlq_event` (`event_type`,`failed_at`),
  KEY `idx_domain_event_outbox_dlq_aggregate` (`aggregate_type`,`aggregate_id`,`failed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `email_outbox` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `recipient_email` varchar(255) NOT NULL,
  `recipient_name` varchar(120) DEFAULT NULL,
  `subject` varchar(180) NOT NULL,
  `text_body` text DEFAULT NULL,
  `html_body` mediumtext DEFAULT NULL,
  `template_key` varchar(64) DEFAULT NULL,
  `template_payload` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`template_payload`)),
  `metadata` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`metadata`)),
  `status` enum('pending','processing','sent','failed') NOT NULL DEFAULT 'pending',
  `priority` tinyint(3) unsigned NOT NULL DEFAULT 50,
  `idempotency_key` varchar(180) DEFAULT NULL,
  `available_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `attempts` tinyint(3) unsigned NOT NULL DEFAULT 0,
  `max_attempts` tinyint(3) unsigned NOT NULL DEFAULT 5,
  `worker_token` char(36) DEFAULT NULL,
  `provider_message_id` varchar(255) DEFAULT NULL,
  `last_error` varchar(255) DEFAULT NULL,
  `locked_at` timestamp NULL DEFAULT NULL,
  `sent_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_email_outbox_idempotency` (`idempotency_key`),
  KEY `idx_email_outbox_status_available_priority` (`status`,`available_at`,`priority`),
  KEY `idx_email_outbox_recipient_created` (`recipient_email`,`created_at`),
  KEY `idx_email_outbox_worker_token` (`worker_token`),
  KEY `idx_email_outbox_status_locked` (`status`,`locked_at`),
  CONSTRAINT `chk_email_outbox_attempts` CHECK (`attempts` <= `max_attempts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `feature_flag` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `flag_name` varchar(120) NOT NULL,
  `is_enabled` tinyint(1) NOT NULL DEFAULT 0,
  `rollout_percent` tinyint(3) unsigned NOT NULL DEFAULT 100,
  `description` varchar(255) DEFAULT NULL,
  `updated_by` varchar(120) DEFAULT NULL,
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_feature_flag_name` (`flag_name`),
  KEY `idx_feature_flag_enabled` (`is_enabled`,`rollout_percent`),
  CONSTRAINT `chk_feature_flag_rollout_percent` CHECK (`rollout_percent` between 0 and 100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `group_configs` (
  `id` varchar(255) NOT NULL,
  `config` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`config`)),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `groups_metadata` (
  `id` varchar(255) NOT NULL,
  `subject` varchar(255) DEFAULT NULL,
  `description` text DEFAULT NULL,
  `owner_jid` varchar(255) DEFAULT NULL,
  `creation` bigint(20) DEFAULT NULL,
  `linked_parent_jid` varchar(255) DEFAULT NULL,
  `is_community` tinyint(1) DEFAULT NULL,
  `is_community_announce` tinyint(1) DEFAULT NULL,
  `member_add_mode` tinyint(1) DEFAULT NULL,
  `join_approval_mode` tinyint(1) DEFAULT NULL,
  `addressing_mode` varchar(8) DEFAULT NULL,
  `participants` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`participants`)),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_groups_metadata_linked_parent_jid` (`linked_parent_jid`),
  KEY `idx_groups_metadata_is_community_parent` (`is_community`,`linked_parent_jid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `lid_map` (
  `lid` varchar(64) NOT NULL,
  `jid` varchar(64) DEFAULT NULL,
  `first_seen` timestamp NULL DEFAULT current_timestamp(),
  `last_seen` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `source` varchar(32) DEFAULT NULL,
  PRIMARY KEY (`lid`),
  KEY `idx_lid_map_jid` (`jid`),
  KEY `idx_lid_map_last_seen` (`last_seen`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `message_analysis_event` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `message_id` varchar(255) DEFAULT NULL,
  `chat_id` varchar(255) DEFAULT NULL,
  `sender_id` varchar(255) DEFAULT NULL,
  `sender_name` varchar(120) DEFAULT NULL,
  `upsert_type` varchar(32) DEFAULT NULL,
  `source` varchar(32) NOT NULL DEFAULT 'whatsapp',
  `is_group` tinyint(1) NOT NULL DEFAULT 0,
  `is_from_bot` tinyint(1) NOT NULL DEFAULT 0,
  `is_command` tinyint(1) NOT NULL DEFAULT 0,
  `command_name` varchar(64) DEFAULT NULL,
  `command_args_count` smallint(5) unsigned NOT NULL DEFAULT 0,
  `command_known` tinyint(1) DEFAULT NULL,
  `command_prefix` varchar(8) DEFAULT NULL,
  `message_kind` varchar(48) NOT NULL DEFAULT 'other',
  `has_media` tinyint(1) NOT NULL DEFAULT 0,
  `media_count` smallint(5) unsigned NOT NULL DEFAULT 0,
  `text_length` int(10) unsigned NOT NULL DEFAULT 0,
  `processing_result` varchar(64) NOT NULL DEFAULT 'processed',
  `error_code` varchar(96) DEFAULT NULL,
  `metadata` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`metadata`)),
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_message_analysis_created` (`created_at`),
  KEY `idx_message_analysis_chat_created` (`chat_id`,`created_at`),
  KEY `idx_message_analysis_sender_created` (`sender_id`,`created_at`),
  KEY `idx_message_analysis_command_created` (`command_name`,`created_at`),
  KEY `idx_message_analysis_kind_created` (`message_kind`,`created_at`),
  KEY `idx_message_analysis_result_created` (`processing_result`,`created_at`),
  KEY `idx_message_analysis_is_command_created` (`is_command`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `baileys_event_journal` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `event_name` varchar(64) NOT NULL,
  `socket_generation` int(10) unsigned DEFAULT NULL,
  `chat_id` varchar(255) DEFAULT NULL,
  `message_id` varchar(255) DEFAULT NULL,
  `participant_id` varchar(255) DEFAULT NULL,
  `payload_summary` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`payload_summary`)),
  `event_timestamp` timestamp NULL DEFAULT current_timestamp(),
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_baileys_event_created` (`created_at`),
  KEY `idx_baileys_event_name_created` (`event_name`,`created_at`),
  KEY `idx_baileys_event_chat_created` (`chat_id`,`created_at`),
  KEY `idx_baileys_event_message_created` (`message_id`,`created_at`),
  KEY `idx_baileys_event_participant_created` (`participant_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `baileys_auth_state` (
  `session_id` varchar(64) NOT NULL,
  `category` varchar(64) NOT NULL,
  `item_id` varchar(191) NOT NULL,
  `payload` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`payload`)),
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`session_id`,`category`,`item_id`),
  KEY `idx_baileys_auth_state_category_updated` (`category`,`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `messages` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `message_id` varchar(255) NOT NULL,
  `chat_id` varchar(255) NOT NULL,
  `sender_id` varchar(255) DEFAULT NULL,
  `canonical_sender_id` varchar(255) DEFAULT NULL,
  `content` text DEFAULT NULL,
  `raw_message` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`raw_message`)),
  `timestamp` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `message_id` (`message_id`),
  KEY `idx_chat_timestamp` (`chat_id`,`timestamp`),
  KEY `idx_sender` (`sender_id`),
  KEY `idx_timestamp` (`timestamp`),
  KEY `idx_messages_sender_timestamp` (`sender_id`,`timestamp`),
  KEY `idx_messages_chat_sender_timestamp` (`chat_id`,`sender_id`,`timestamp`),
  KEY `idx_messages_canonical_sender_timestamp` (`canonical_sender_id`,`timestamp`),
  KEY `idx_messages_chat_canonical_sender_timestamp` (`chat_id`,`canonical_sender_id`,`timestamp`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `message_activity_daily` (
  `day_ref_date` date NOT NULL,
  `chat_id` varchar(255) NOT NULL,
  `canonical_sender_id` varchar(255) NOT NULL,
  `total_messages` int(10) unsigned NOT NULL DEFAULT 0,
  `first_message_at` datetime DEFAULT NULL,
  `last_message_at` datetime DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`day_ref_date`,`chat_id`,`canonical_sender_id`),
  KEY `idx_message_activity_daily_sender_day` (`canonical_sender_id`,`day_ref_date`),
  KEY `idx_message_activity_daily_chat_day` (`chat_id`,`day_ref_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_battle_state` (
  `chat_jid` varchar(255) NOT NULL,
  `owner_jid` varchar(255) NOT NULL,
  `my_pokemon_id` bigint(20) unsigned NOT NULL,
  `enemy_snapshot_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`enemy_snapshot_json`)),
  `turn` int(10) unsigned NOT NULL DEFAULT 1,
  `expires_at` datetime NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`chat_jid`),
  UNIQUE KEY `uq_rpg_battle_owner` (`owner_jid`),
  KEY `idx_rpg_battle_expires_at` (`expires_at`),
  KEY `fk_rpg_battle_my_pokemon` (`my_pokemon_id`),
  CONSTRAINT `fk_rpg_battle_my_pokemon` FOREIGN KEY (`my_pokemon_id`) REFERENCES `rpg_player_pokemon` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_rpg_battle_owner` FOREIGN KEY (`owner_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_group_activity_daily` (
  `day_ref_date` date NOT NULL,
  `chat_jid` varchar(255) NOT NULL,
  `owner_jid` varchar(255) NOT NULL,
  `actions_count` int(10) unsigned NOT NULL DEFAULT 0,
  `pvp_created_count` int(10) unsigned NOT NULL DEFAULT 0,
  `pvp_completed_count` int(10) unsigned NOT NULL DEFAULT 0,
  `coop_completed_count` int(10) unsigned NOT NULL DEFAULT 0,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`day_ref_date`,`chat_jid`,`owner_jid`),
  KEY `idx_rpg_activity_chat_day` (`chat_jid`,`day_ref_date`),
  KEY `idx_rpg_activity_owner_day` (`owner_jid`,`day_ref_date`),
  CONSTRAINT `fk_rpg_activity_owner` FOREIGN KEY (`owner_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_group_biome` (
  `group_jid` varchar(255) NOT NULL,
  `biome_key` varchar(64) NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`group_jid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_group_coop_member` (
  `chat_jid` varchar(255) NOT NULL,
  `week_ref_date` date NOT NULL,
  `owner_jid` varchar(255) NOT NULL,
  `capture_contribution` int(10) unsigned NOT NULL DEFAULT 0,
  `raid_contribution` int(10) unsigned NOT NULL DEFAULT 0,
  `reward_claimed_at` datetime DEFAULT NULL,
  `last_contribution_at` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`chat_jid`,`week_ref_date`,`owner_jid`),
  KEY `idx_rpg_coop_member_owner` (`owner_jid`,`week_ref_date`),
  CONSTRAINT `fk_rpg_coop_member_owner` FOREIGN KEY (`owner_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_rpg_coop_member_weekly` FOREIGN KEY (`chat_jid`, `week_ref_date`) REFERENCES `rpg_group_coop_weekly` (`chat_jid`, `week_ref_date`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_group_coop_weekly` (
  `chat_jid` varchar(255) NOT NULL,
  `week_ref_date` date NOT NULL,
  `capture_target` int(10) unsigned NOT NULL DEFAULT 20,
  `raid_target` int(10) unsigned NOT NULL DEFAULT 3,
  `capture_progress` int(10) unsigned NOT NULL DEFAULT 0,
  `raid_progress` int(10) unsigned NOT NULL DEFAULT 0,
  `status` varchar(24) NOT NULL DEFAULT 'active',
  `completed_at` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`chat_jid`,`week_ref_date`),
  KEY `idx_rpg_coop_weekly_status` (`status`,`week_ref_date`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_group_event_member` (
  `chat_jid` varchar(255) NOT NULL,
  `week_ref_date` date NOT NULL,
  `owner_jid` varchar(255) NOT NULL,
  `contribution` bigint(20) unsigned NOT NULL DEFAULT 0,
  `reward_claimed_at` datetime DEFAULT NULL,
  `last_contribution_at` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`chat_jid`,`week_ref_date`,`owner_jid`),
  KEY `idx_rpg_event_member_owner` (`owner_jid`,`week_ref_date`),
  CONSTRAINT `fk_rpg_event_member_owner` FOREIGN KEY (`owner_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_rpg_event_member_weekly` FOREIGN KEY (`chat_jid`, `week_ref_date`) REFERENCES `rpg_group_event_weekly` (`chat_jid`, `week_ref_date`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_group_event_weekly` (
  `chat_jid` varchar(255) NOT NULL,
  `week_ref_date` date NOT NULL,
  `event_key` varchar(64) NOT NULL,
  `target_value` bigint(20) unsigned NOT NULL,
  `progress_value` bigint(20) unsigned NOT NULL DEFAULT 0,
  `status` varchar(24) NOT NULL DEFAULT 'active',
  `expires_at` datetime NOT NULL,
  `completed_at` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`chat_jid`,`week_ref_date`),
  KEY `idx_rpg_event_weekly_status_expires` (`status`,`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_karma_profile` (
  `owner_jid` varchar(255) NOT NULL,
  `karma_score` int(11) NOT NULL DEFAULT 0,
  `positive_votes` int(10) unsigned NOT NULL DEFAULT 0,
  `negative_votes` int(10) unsigned NOT NULL DEFAULT 0,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`owner_jid`),
  CONSTRAINT `fk_rpg_karma_profile_owner` FOREIGN KEY (`owner_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_karma_vote_history` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `week_ref_date` date NOT NULL,
  `voter_jid` varchar(255) NOT NULL,
  `target_jid` varchar(255) NOT NULL,
  `vote_value` tinyint(4) NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rpg_karma_week_vote` (`week_ref_date`,`voter_jid`,`target_jid`),
  KEY `idx_rpg_karma_target_week` (`target_jid`,`week_ref_date`),
  KEY `fk_rpg_karma_vote_voter` (`voter_jid`),
  CONSTRAINT `fk_rpg_karma_vote_target` FOREIGN KEY (`target_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_rpg_karma_vote_voter` FOREIGN KEY (`voter_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `chk_rpg_karma_vote_value` CHECK (`vote_value` in (-1,1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_player` (
  `jid` varchar(255) NOT NULL,
  `level` int(10) unsigned NOT NULL DEFAULT 1,
  `xp` bigint(20) unsigned NOT NULL DEFAULT 0,
  `xp_pool_social` bigint(20) unsigned NOT NULL DEFAULT 0,
  `gold` bigint(20) unsigned NOT NULL DEFAULT 200,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`jid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_player_inventory` (
  `owner_jid` varchar(255) NOT NULL,
  `item_key` varchar(64) NOT NULL,
  `quantity` int(10) unsigned NOT NULL DEFAULT 0,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`owner_jid`,`item_key`),
  CONSTRAINT `fk_rpg_inventory_owner` FOREIGN KEY (`owner_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_player_mission_progress` (
  `owner_jid` varchar(255) NOT NULL,
  `daily_ref_date` date NOT NULL,
  `daily_progress_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`daily_progress_json`)),
  `daily_claimed_at` datetime DEFAULT NULL,
  `weekly_ref_date` date NOT NULL,
  `weekly_progress_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`weekly_progress_json`)),
  `weekly_claimed_at` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`owner_jid`),
  CONSTRAINT `fk_rpg_mission_owner` FOREIGN KEY (`owner_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_player_pokedex` (
  `owner_jid` varchar(255) NOT NULL,
  `poke_id` int(10) unsigned NOT NULL,
  `first_captured_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`owner_jid`,`poke_id`),
  KEY `idx_rpg_pokedex_owner` (`owner_jid`),
  CONSTRAINT `fk_rpg_pokedex_owner` FOREIGN KEY (`owner_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_player_pokemon` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `owner_jid` varchar(255) NOT NULL,
  `poke_id` int(10) unsigned NOT NULL,
  `nickname` varchar(120) DEFAULT NULL,
  `level` int(10) unsigned NOT NULL DEFAULT 5,
  `xp` bigint(20) unsigned NOT NULL DEFAULT 0,
  `current_hp` int(10) unsigned NOT NULL,
  `ivs_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`ivs_json`)),
  `moves_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`moves_json`)),
  `nature_key` varchar(64) DEFAULT NULL,
  `ability_key` varchar(64) DEFAULT NULL,
  `ability_name` varchar(120) DEFAULT NULL,
  `is_shiny` tinyint(1) NOT NULL DEFAULT 0,
  `is_active` tinyint(1) NOT NULL DEFAULT 0,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_rpg_player_pokemon_owner` (`owner_jid`),
  KEY `idx_rpg_player_pokemon_owner_active` (`owner_jid`,`is_active`),
  CONSTRAINT `fk_rpg_player_pokemon_owner` FOREIGN KEY (`owner_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_player_travel` (
  `owner_jid` varchar(255) NOT NULL,
  `region_key` varchar(120) DEFAULT NULL,
  `location_key` varchar(120) DEFAULT NULL,
  `location_area_key` varchar(120) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`owner_jid`),
  CONSTRAINT `fk_rpg_travel_owner` FOREIGN KEY (`owner_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_pvp_challenge` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `chat_jid` varchar(255) DEFAULT NULL,
  `challenger_jid` varchar(255) NOT NULL,
  `opponent_jid` varchar(255) NOT NULL,
  `status` varchar(24) NOT NULL DEFAULT 'pending',
  `turn_jid` varchar(255) DEFAULT NULL,
  `winner_jid` varchar(255) DEFAULT NULL,
  `battle_snapshot_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`battle_snapshot_json`)),
  `started_at` datetime DEFAULT NULL,
  `expires_at` datetime NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_rpg_pvp_status_expires` (`status`,`expires_at`),
  KEY `idx_rpg_pvp_challenger` (`challenger_jid`),
  KEY `idx_rpg_pvp_opponent` (`opponent_jid`),
  CONSTRAINT `fk_rpg_pvp_challenger` FOREIGN KEY (`challenger_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_rpg_pvp_opponent` FOREIGN KEY (`opponent_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_pvp_queue` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `chat_jid` varchar(255) NOT NULL,
  `owner_jid` varchar(255) NOT NULL,
  `status` varchar(24) NOT NULL DEFAULT 'queued',
  `matched_challenge_id` bigint(20) unsigned DEFAULT NULL,
  `expires_at` datetime NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_rpg_pvp_queue_chat_owner_status` (`chat_jid`,`owner_jid`,`status`),
  KEY `idx_rpg_pvp_queue_chat_status_expires` (`chat_jid`,`status`,`expires_at`),
  KEY `idx_rpg_pvp_queue_owner_status` (`owner_jid`,`status`),
  KEY `fk_rpg_pvp_queue_challenge` (`matched_challenge_id`),
  CONSTRAINT `fk_rpg_pvp_queue_challenge` FOREIGN KEY (`matched_challenge_id`) REFERENCES `rpg_pvp_challenge` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `fk_rpg_pvp_queue_owner` FOREIGN KEY (`owner_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_pvp_weekly_stats` (
  `week_ref_date` date NOT NULL,
  `owner_jid` varchar(255) NOT NULL,
  `matches_played` int(10) unsigned NOT NULL DEFAULT 0,
  `wins` int(10) unsigned NOT NULL DEFAULT 0,
  `losses` int(10) unsigned NOT NULL DEFAULT 0,
  `points` int(10) unsigned NOT NULL DEFAULT 0,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`week_ref_date`,`owner_jid`),
  KEY `idx_rpg_pvp_weekly_points` (`week_ref_date`,`points` DESC,`wins` DESC),
  KEY `fk_rpg_pvp_weekly_owner` (`owner_jid`),
  CONSTRAINT `fk_rpg_pvp_weekly_owner` FOREIGN KEY (`owner_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_raid_participant` (
  `chat_jid` varchar(255) NOT NULL,
  `owner_jid` varchar(255) NOT NULL,
  `total_damage` int(10) unsigned NOT NULL DEFAULT 0,
  `joined_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`chat_jid`,`owner_jid`),
  KEY `idx_rpg_raid_part_owner` (`owner_jid`),
  CONSTRAINT `fk_rpg_raid_part_chat` FOREIGN KEY (`chat_jid`) REFERENCES `rpg_raid_state` (`chat_jid`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_rpg_raid_part_owner` FOREIGN KEY (`owner_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_raid_state` (
  `chat_jid` varchar(255) NOT NULL,
  `created_by_jid` varchar(255) NOT NULL,
  `biome_key` varchar(64) DEFAULT NULL,
  `boss_snapshot_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`boss_snapshot_json`)),
  `max_hp` int(10) unsigned NOT NULL,
  `current_hp` int(10) unsigned NOT NULL,
  `started_at` datetime NOT NULL,
  `ends_at` datetime NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`chat_jid`),
  KEY `idx_rpg_raid_ends_at` (`ends_at`),
  KEY `fk_rpg_raid_creator` (`created_by_jid`),
  CONSTRAINT `fk_rpg_raid_creator` FOREIGN KEY (`created_by_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_social_link` (
  `pair_key` varchar(600) NOT NULL,
  `user_a_jid` varchar(255) NOT NULL,
  `user_b_jid` varchar(255) NOT NULL,
  `friendship_score` int(11) NOT NULL DEFAULT 0,
  `rivalry_score` int(11) NOT NULL DEFAULT 0,
  `interactions_count` int(10) unsigned NOT NULL DEFAULT 0,
  `last_interaction_at` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`pair_key`),
  UNIQUE KEY `uq_rpg_social_link_pair_users` (`user_a_jid`,`user_b_jid`),
  KEY `idx_rpg_social_link_user_a` (`user_a_jid`),
  KEY `idx_rpg_social_link_user_b` (`user_b_jid`),
  CONSTRAINT `fk_rpg_social_link_user_a` FOREIGN KEY (`user_a_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_rpg_social_link_user_b` FOREIGN KEY (`user_b_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_social_xp_daily` (
  `day_ref_date` date NOT NULL,
  `owner_jid` varchar(255) NOT NULL,
  `chat_jid` varchar(255) NOT NULL,
  `earned_xp` int(10) unsigned NOT NULL DEFAULT 0,
  `converted_xp` int(10) unsigned NOT NULL DEFAULT 0,
  `cap_hits` int(10) unsigned NOT NULL DEFAULT 0,
  `last_message_hash` char(40) DEFAULT NULL,
  `last_earned_at` datetime DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`day_ref_date`,`owner_jid`,`chat_jid`),
  KEY `idx_rpg_social_xp_owner_day` (`owner_jid`,`day_ref_date`),
  KEY `idx_rpg_social_xp_chat_day` (`chat_jid`,`day_ref_date`),
  CONSTRAINT `fk_rpg_social_xp_owner` FOREIGN KEY (`owner_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rpg_trade_offer` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `chat_jid` varchar(255) DEFAULT NULL,
  `proposer_jid` varchar(255) NOT NULL,
  `receiver_jid` varchar(255) NOT NULL,
  `proposer_offer_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`proposer_offer_json`)),
  `receiver_offer_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`receiver_offer_json`)),
  `status` varchar(24) NOT NULL DEFAULT 'pending',
  `accepted_at` datetime DEFAULT NULL,
  `expires_at` datetime NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_rpg_trade_status_expires` (`status`,`expires_at`),
  KEY `idx_rpg_trade_proposer` (`proposer_jid`),
  KEY `idx_rpg_trade_receiver` (`receiver_jid`),
  CONSTRAINT `fk_rpg_trade_proposer` FOREIGN KEY (`proposer_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_rpg_trade_receiver` FOREIGN KEY (`receiver_jid`) REFERENCES `rpg_player` (`jid`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `semantic_theme_clusters` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `canonical_slug` varchar(255) NOT NULL,
  `embedding_dim` smallint(5) unsigned NOT NULL,
  `embedding` mediumblob NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_semantic_theme_clusters_slug` (`canonical_slug`),
  KEY `idx_semantic_theme_clusters_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `semantic_theme_suggestion_cache` (
  `suggestion_hash` char(64) NOT NULL,
  `suggestion_text` varchar(512) NOT NULL,
  `normalized_text` varchar(512) NOT NULL,
  `semantic_cluster_id` bigint(20) unsigned NOT NULL,
  `canonical_slug` varchar(255) NOT NULL,
  `embedding_dim` smallint(5) unsigned NOT NULL,
  `embedding` mediumblob NOT NULL,
  `last_similarity` decimal(8,6) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`suggestion_hash`),
  UNIQUE KEY `uq_semantic_theme_cache_normalized` (`normalized_text`),
  KEY `idx_semantic_theme_cache_cluster` (`semantic_cluster_id`),
  CONSTRAINT `fk_semantic_theme_cache_cluster` FOREIGN KEY (`semantic_cluster_id`) REFERENCES `semantic_theme_clusters` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sticker_asset` (
  `id` char(36) NOT NULL,
  `owner_jid` varchar(255) NOT NULL,
  `sha256` char(64) NOT NULL,
  `mimetype` varchar(64) NOT NULL,
  `is_animated` tinyint(1) NOT NULL DEFAULT 0,
  `width` int(10) unsigned DEFAULT NULL,
  `height` int(10) unsigned DEFAULT NULL,
  `size_bytes` int(10) unsigned NOT NULL,
  `storage_path` varchar(1024) NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sticker_asset_sha256` (`sha256`),
  KEY `idx_sticker_asset_owner_created` (`owner_jid`,`created_at`),
  KEY `idx_sticker_asset_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sticker_asset_classification` (
  `asset_id` char(36) NOT NULL,
  `provider` varchar(64) NOT NULL DEFAULT 'clip',
  `model_name` varchar(120) DEFAULT NULL,
  `classification_version` varchar(32) NOT NULL DEFAULT 'v1',
  `category` varchar(120) DEFAULT NULL,
  `confidence` decimal(6,5) DEFAULT NULL,
  `entropy` decimal(8,6) DEFAULT NULL,
  `confidence_margin` decimal(8,6) DEFAULT NULL,
  `nsfw_score` decimal(6,5) DEFAULT NULL,
  `is_nsfw` tinyint(1) NOT NULL DEFAULT 0,
  `all_scores` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`all_scores`)),
  `top_labels` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`top_labels`)),
  `affinity_weight` decimal(8,6) DEFAULT NULL,
  `image_hash` char(64) DEFAULT NULL,
  `ambiguous` tinyint(1) NOT NULL DEFAULT 0,
  `llm_subtags` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`llm_subtags`)),
  `llm_style_traits` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`llm_style_traits`)),
  `llm_emotions` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`llm_emotions`)),
  `llm_pack_suggestions` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`llm_pack_suggestions`)),
  `semantic_cluster_id` bigint(20) unsigned DEFAULT NULL,
  `semantic_cluster_slug` varchar(255) DEFAULT NULL,
  `similar_images` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`similar_images`)),
  `classified_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`asset_id`),
  KEY `idx_sticker_asset_classification_category` (`category`),
  KEY `idx_sticker_asset_classification_nsfw` (`is_nsfw`),
  KEY `idx_sticker_asset_classification_semantic_cluster` (`semantic_cluster_id`),
  KEY `idx_sticker_asset_classification_confidence` (`confidence`),
  KEY `idx_sticker_asset_classification_updated_at` (`updated_at`),
  KEY `idx_sticker_asset_classification_version_updated` (`classification_version`,`updated_at`),
  CONSTRAINT `fk_sticker_asset_classification_asset` FOREIGN KEY (`asset_id`) REFERENCES `sticker_asset` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sticker_asset_reprocess_queue` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `asset_id` char(36) NOT NULL,
  `reason` enum('MODEL_UPGRADE','LOW_CONFIDENCE','TREND_SHIFT','NSFW_REVIEW') NOT NULL,
  `priority` tinyint(3) unsigned NOT NULL DEFAULT 50,
  `scheduled_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `status` enum('pending','processing','completed','failed') NOT NULL DEFAULT 'pending',
  `attempts` tinyint(3) unsigned NOT NULL DEFAULT 0,
  `max_attempts` tinyint(3) unsigned NOT NULL DEFAULT 5,
  `worker_token` char(36) DEFAULT NULL,
  `last_error` varchar(255) DEFAULT NULL,
  `locked_at` timestamp NULL DEFAULT NULL,
  `processed_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_sticker_reprocess_status_schedule` (`status`,`scheduled_at`,`priority`),
  KEY `idx_sticker_reprocess_asset_reason` (`asset_id`,`reason`),
  KEY `idx_sticker_reprocess_worker_token` (`worker_token`),
  KEY `idx_sticker_asset_reprocess_queue_status_locked` (`status`,`locked_at`),
  CONSTRAINT `fk_sticker_reprocess_asset` FOREIGN KEY (`asset_id`) REFERENCES `sticker_asset` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `chk_sticker_asset_reprocess_queue_attempts` CHECK (`attempts` <= `max_attempts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sticker_pack` (
  `id` char(36) NOT NULL,
  `owner_jid` varchar(255) NOT NULL,
  `name` varchar(120) NOT NULL,
  `publisher` varchar(120) NOT NULL,
  `description` text DEFAULT NULL,
  `pack_key` varchar(160) NOT NULL,
  `cover_sticker_id` char(36) DEFAULT NULL,
  `visibility` enum('private','public','unlisted') NOT NULL DEFAULT 'private',
  `status` enum('draft','uploading','processing','published','failed') NOT NULL DEFAULT 'published',
  `pack_status` enum('building','ready','archived') NOT NULL DEFAULT 'ready',
  `pack_theme_key` varchar(96) DEFAULT NULL,
  `pack_volume` int(10) unsigned DEFAULT NULL,
  `is_auto_pack` tinyint(1) NOT NULL DEFAULT 0,
  `last_rebalanced_at` timestamp NULL DEFAULT NULL,
  `version` int(10) unsigned NOT NULL DEFAULT 1,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `deleted_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sticker_pack_pack_key` (`pack_key`),
  KEY `idx_sticker_pack_owner_deleted` (`owner_jid`,`deleted_at`),
  KEY `idx_sticker_pack_owner_updated` (`owner_jid`,`updated_at`),
  KEY `fk_sticker_pack_cover` (`cover_sticker_id`),
  KEY `idx_sticker_pack_auto_theme_status` (`is_auto_pack`,`pack_theme_key`,`pack_status`,`pack_volume`),
  KEY `idx_sticker_pack_auto_owner_status` (`owner_jid`,`is_auto_pack`,`pack_status`,`updated_at`),
  KEY `idx_sticker_pack_catalog_lookup` (`deleted_at`,`status`,`pack_status`,`visibility`,`updated_at`),
  CONSTRAINT `fk_sticker_pack_cover` FOREIGN KEY (`cover_sticker_id`) REFERENCES `sticker_asset` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sticker_pack_engagement` (
  `pack_id` char(36) NOT NULL,
  `open_count` bigint(20) unsigned NOT NULL DEFAULT 0,
  `like_count` bigint(20) unsigned NOT NULL DEFAULT 0,
  `dislike_count` bigint(20) unsigned NOT NULL DEFAULT 0,
  `last_opened_at` timestamp NULL DEFAULT NULL,
  `last_interacted_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`pack_id`),
  KEY `idx_sticker_pack_engagement_updated` (`updated_at`),
  KEY `idx_sticker_pack_engagement_like` (`like_count`),
  KEY `idx_sticker_pack_engagement_open` (`open_count`),
  CONSTRAINT `fk_sticker_pack_engagement_pack` FOREIGN KEY (`pack_id`) REFERENCES `sticker_pack` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sticker_pack_interaction_event` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `pack_id` char(36) NOT NULL,
  `interaction` enum('open','like','dislike') NOT NULL,
  `actor_key` varchar(120) DEFAULT NULL,
  `session_key` varchar(120) DEFAULT NULL,
  `source` varchar(32) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_sticker_pack_interaction_pack_created` (`pack_id`,`created_at`),
  KEY `idx_sticker_pack_interaction_actor_created` (`actor_key`,`created_at`),
  KEY `idx_sticker_pack_interaction_session_created` (`session_key`,`created_at`),
  KEY `idx_sticker_pack_interaction_type_created` (`interaction`,`created_at`),
  KEY `idx_sticker_pack_interaction_created_at` (`created_at`),
  CONSTRAINT `fk_sticker_pack_interaction_pack` FOREIGN KEY (`pack_id`) REFERENCES `sticker_pack` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sticker_pack_item` (
  `id` char(36) NOT NULL,
  `pack_id` char(36) NOT NULL,
  `sticker_id` char(36) NOT NULL,
  `position` int(10) unsigned NOT NULL,
  `emojis` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`emojis`)),
  `accessibility_label` varchar(255) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sticker_pack_item_pack_sticker` (`pack_id`,`sticker_id`),
  UNIQUE KEY `uq_sticker_pack_item_pack_position` (`pack_id`,`position`),
  KEY `fk_sticker_pack_item_asset` (`sticker_id`),
  KEY `idx_sticker_pack_item_sticker_id` (`sticker_id`),
  CONSTRAINT `fk_sticker_pack_item_asset` FOREIGN KEY (`sticker_id`) REFERENCES `sticker_asset` (`id`) ON UPDATE CASCADE,
  CONSTRAINT `fk_sticker_pack_item_pack` FOREIGN KEY (`pack_id`) REFERENCES `sticker_pack` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sticker_pack_score_snapshot` (
  `pack_id` char(36) NOT NULL,
  `ranking_score` decimal(10,6) NOT NULL DEFAULT 0.000000,
  `pack_score` decimal(10,6) NOT NULL DEFAULT 0.000000,
  `trend_score` decimal(10,6) NOT NULL DEFAULT 0.000000,
  `quality_score` decimal(10,6) NOT NULL DEFAULT 0.000000,
  `engagement_score` decimal(10,6) NOT NULL DEFAULT 0.000000,
  `diversity_score` decimal(10,6) NOT NULL DEFAULT 0.000000,
  `cohesion_score` decimal(10,6) NOT NULL DEFAULT 0.000000,
  `sensitive_content` tinyint(1) NOT NULL DEFAULT 0,
  `nsfw_level` enum('safe','suggestive','explicit') NOT NULL DEFAULT 'safe',
  `sticker_count` int(10) unsigned NOT NULL DEFAULT 0,
  `tags` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`tags`)),
  `scores_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`scores_json`)),
  `source_version` varchar(32) NOT NULL DEFAULT 'v1',
  `refreshed_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`pack_id`),
  KEY `idx_sticker_pack_score_snapshot_ranking` (`ranking_score`),
  KEY `idx_sticker_pack_score_snapshot_trend` (`trend_score`),
  KEY `idx_sticker_pack_score_snapshot_refresh` (`refreshed_at`),
  CONSTRAINT `fk_sticker_pack_score_snapshot_pack` FOREIGN KEY (`pack_id`) REFERENCES `sticker_pack` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sticker_pack_web_upload` (
  `id` char(36) NOT NULL,
  `pack_id` char(36) NOT NULL,
  `upload_id` varchar(120) NOT NULL,
  `sticker_hash` char(64) NOT NULL,
  `source_mimetype` varchar(64) DEFAULT NULL,
  `upload_status` enum('pending','processing','done','failed') NOT NULL DEFAULT 'pending',
  `sticker_id` char(36) DEFAULT NULL,
  `error_code` varchar(64) DEFAULT NULL,
  `error_message` varchar(255) DEFAULT NULL,
  `attempt_count` int(10) unsigned NOT NULL DEFAULT 0,
  `last_attempt_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sticker_pack_web_upload_pack_upload_id` (`pack_id`,`upload_id`),
  UNIQUE KEY `uq_sticker_pack_web_upload_pack_hash` (`pack_id`,`sticker_hash`),
  KEY `idx_sticker_pack_web_upload_pack_status` (`pack_id`,`upload_status`),
  KEY `idx_sticker_pack_web_upload_pack_updated` (`pack_id`,`updated_at`),
  KEY `fk_sticker_pack_web_upload_sticker` (`sticker_id`),
  CONSTRAINT `fk_sticker_pack_web_upload_pack` FOREIGN KEY (`pack_id`) REFERENCES `sticker_pack` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `fk_sticker_pack_web_upload_sticker` FOREIGN KEY (`sticker_id`) REFERENCES `sticker_asset` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sticker_worker_task_dlq` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `task_id` bigint(20) unsigned DEFAULT NULL,
  `task_type` enum('classification_cycle','curation_cycle','rebuild_cycle') NOT NULL,
  `payload` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`payload`)),
  `idempotency_key` varchar(180) DEFAULT NULL,
  `attempts` tinyint(3) unsigned NOT NULL DEFAULT 0,
  `max_attempts` tinyint(3) unsigned NOT NULL DEFAULT 0,
  `priority` tinyint(3) unsigned NOT NULL DEFAULT 0,
  `last_error` varchar(255) DEFAULT NULL,
  `failed_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sticker_worker_task_dlq_task_id` (`task_id`),
  KEY `idx_sticker_worker_task_dlq_type_failed_at` (`task_type`,`failed_at`),
  KEY `idx_sticker_worker_task_dlq_idempotency_key` (`idempotency_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `sticker_worker_task_queue` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `task_type` enum('classification_cycle','curation_cycle','rebuild_cycle') NOT NULL,
  `idempotency_key` varchar(180) DEFAULT NULL,
  `payload` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`payload`)),
  `priority` tinyint(3) unsigned NOT NULL DEFAULT 50,
  `scheduled_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `status` enum('pending','processing','completed','failed') NOT NULL DEFAULT 'pending',
  `attempts` tinyint(3) unsigned NOT NULL DEFAULT 0,
  `max_attempts` tinyint(3) unsigned NOT NULL DEFAULT 5,
  `worker_token` char(36) DEFAULT NULL,
  `last_error` varchar(255) DEFAULT NULL,
  `locked_at` timestamp NULL DEFAULT NULL,
  `processed_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sticker_worker_task_idempotency_key` (`idempotency_key`),
  KEY `idx_sticker_worker_task_type_status_schedule` (`task_type`,`status`,`scheduled_at`,`priority`),
  KEY `idx_sticker_worker_task_status_schedule` (`status`,`scheduled_at`,`priority`),
  KEY `idx_sticker_worker_task_worker_token` (`worker_token`),
  KEY `idx_sticker_worker_task_queue_status_locked` (`status`,`locked_at`),
  CONSTRAINT `chk_sticker_worker_task_queue_attempts` CHECK (`attempts` <= `max_attempts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `web_admin_ban` (
  `id` char(36) NOT NULL,
  `google_sub` varchar(80) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `owner_jid` varchar(255) DEFAULT NULL,
  `reason` varchar(255) DEFAULT NULL,
  `created_by_google_sub` varchar(80) DEFAULT NULL,
  `created_by_email` varchar(255) DEFAULT NULL,
  `revoked_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_web_admin_ban_google_sub` (`google_sub`,`revoked_at`,`created_at`),
  KEY `idx_web_admin_ban_email` (`email`,`revoked_at`,`created_at`),
  KEY `idx_web_admin_ban_owner_jid` (`owner_jid`,`revoked_at`,`created_at`),
  KEY `idx_web_admin_ban_revoked_created` (`revoked_at`,`created_at`),
  CONSTRAINT `chk_web_admin_ban_identity` CHECK (`google_sub` is not null or `email` is not null or `owner_jid` is not null)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `web_admin_moderator` (
  `google_sub` varchar(80) NOT NULL,
  `owner_jid` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `name` varchar(120) DEFAULT NULL,
  `password_hash` varchar(255) NOT NULL,
  `created_by_google_sub` varchar(80) DEFAULT NULL,
  `created_by_email` varchar(255) DEFAULT NULL,
  `updated_by_google_sub` varchar(80) DEFAULT NULL,
  `updated_by_email` varchar(255) DEFAULT NULL,
  `last_login_at` timestamp NULL DEFAULT NULL,
  `revoked_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`google_sub`),
  KEY `idx_web_admin_moderator_email` (`email`),
  KEY `idx_web_admin_moderator_owner_jid` (`owner_jid`),
  KEY `idx_web_admin_moderator_revoked_updated` (`revoked_at`,`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `web_google_session` (
  `session_token` char(36) NOT NULL,
  `session_token_hash` binary(32) NOT NULL,
  `google_sub` varchar(80) NOT NULL,
  `owner_jid` varchar(120) NOT NULL,
  `owner_phone` varchar(20) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `name` varchar(120) DEFAULT NULL,
  `picture_url` varchar(1024) DEFAULT NULL,
  `expires_at` timestamp NOT NULL,
  `revoked_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `last_seen_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`session_token`),
  UNIQUE KEY `uq_web_google_session_token_hash` (`session_token_hash`),
  KEY `idx_web_google_session_google_sub` (`google_sub`),
  KEY `idx_web_google_session_owner_jid` (`owner_jid`),
  KEY `idx_web_google_session_expires_at` (`expires_at`),
  KEY `idx_web_google_session_revoked_expires` (`revoked_at`,`expires_at`),
  KEY `idx_web_google_session_owner_phone` (`owner_phone`),
  CONSTRAINT `fk_web_google_session_user` FOREIGN KEY (`google_sub`) REFERENCES `web_google_user` (`google_sub`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `web_google_user` (
  `google_sub` varchar(80) NOT NULL,
  `owner_jid` varchar(120) NOT NULL,
  `owner_phone` varchar(20) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `name` varchar(120) DEFAULT NULL,
  `picture_url` varchar(1024) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `last_login_at` timestamp NULL DEFAULT NULL,
  `last_seen_at` timestamp NULL DEFAULT NULL,
  PRIMARY KEY (`google_sub`),
  UNIQUE KEY `uq_web_google_user_owner_jid` (`owner_jid`),
  KEY `idx_web_google_user_email` (`email`),
  KEY `idx_web_google_user_owner_phone` (`owner_phone`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `web_user_password` (
  `google_sub` varchar(80) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `password_algo` varchar(24) NOT NULL DEFAULT 'argon2id',
  `password_cost` tinyint(3) unsigned NOT NULL DEFAULT 3,
  `failed_attempts` smallint(5) unsigned NOT NULL DEFAULT 0,
  `last_failed_at` timestamp NULL DEFAULT NULL,
  `last_login_at` timestamp NULL DEFAULT NULL,
  `password_changed_at` timestamp NULL DEFAULT current_timestamp(),
  `revoked_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`google_sub`),
  KEY `idx_web_user_password_revoked_updated` (`revoked_at`,`updated_at`),
  KEY `idx_web_user_password_last_login` (`last_login_at`),
  CONSTRAINT `fk_web_user_password_google_user` FOREIGN KEY (`google_sub`) REFERENCES `web_google_user` (`google_sub`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `web_user_password_login_throttle` (
  `identity_hash` binary(32) NOT NULL,
  `failed_attempts` smallint(5) unsigned NOT NULL DEFAULT 0,
  `last_failed_at` timestamp NULL DEFAULT NULL,
  `locked_until` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`identity_hash`),
  KEY `idx_web_user_password_login_throttle_locked_until` (`locked_until`),
  KEY `idx_web_user_password_login_throttle_failed` (`failed_attempts`,`last_failed_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `web_user_password_recovery_code` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `google_sub` varchar(80) NOT NULL,
  `email` varchar(255) NOT NULL,
  `email_hash` binary(32) DEFAULT NULL,
  `owner_jid` varchar(120) DEFAULT NULL,
  `purpose` varchar(24) NOT NULL DEFAULT 'reset',
  `code_hash` char(64) NOT NULL,
  `attempts` smallint(5) unsigned NOT NULL DEFAULT 0,
  `max_attempts` smallint(5) unsigned NOT NULL DEFAULT 5,
  `requested_ip` varchar(64) DEFAULT NULL,
  `requested_ip_hash` binary(32) DEFAULT NULL,
  `requested_user_agent` varchar(255) DEFAULT NULL,
  `requested_user_agent_hash` binary(32) DEFAULT NULL,
  `last_attempt_at` timestamp NULL DEFAULT NULL,
  `expires_at` timestamp NOT NULL,
  `consumed_at` timestamp NULL DEFAULT NULL,
  `revoked_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_web_user_password_recovery_sub_created` (`google_sub`,`created_at`),
  KEY `idx_web_user_password_recovery_email_created` (`email`,`created_at`),
  KEY `idx_web_user_password_recovery_email_hash_created` (`email_hash`,`created_at`),
  KEY `idx_web_user_password_recovery_status` (`revoked_at`,`consumed_at`,`expires_at`),
  KEY `idx_web_user_password_recovery_purpose` (`purpose`,`created_at`),
  CONSTRAINT `fk_web_user_password_recovery_google_user` FOREIGN KEY (`google_sub`) REFERENCES `web_google_user` (`google_sub`) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `web_terms_acceptance_event` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `event_id` char(36) NOT NULL,
  `document_key` varchar(64) NOT NULL,
  `document_version` varchar(64) NOT NULL,
  `document_version_hash` char(64) NOT NULL,
  `accepted_at` timestamp NOT NULL DEFAULT current_timestamp(),
  `accepted_at_client` timestamp NULL DEFAULT NULL,
  `source` varchar(32) NOT NULL DEFAULT 'web_login',
  `google_sub` varchar(80) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `owner_jid` varchar(120) DEFAULT NULL,
  `session_key` varchar(80) DEFAULT NULL,
  `ip_address` varchar(64) DEFAULT NULL,
  `user_agent` varchar(512) DEFAULT NULL,
  `metadata` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`metadata`)),
  `created_at` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_web_terms_acceptance_event_id` (`event_id`),
  KEY `idx_web_terms_acceptance_doc_version` (`document_key`,`document_version`,`accepted_at`),
  KEY `idx_web_terms_acceptance_identity` (`google_sub`,`email`,`owner_jid`,`accepted_at`),
  KEY `idx_web_terms_acceptance_source_created` (`source`,`created_at`),
  KEY `idx_web_terms_acceptance_session_created` (`session_key`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `web_visit_event` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `visitor_key` varchar(80) NOT NULL,
  `session_key` varchar(80) NOT NULL,
  `page_path` varchar(255) NOT NULL,
  `referrer` varchar(1024) DEFAULT NULL,
  `user_agent` varchar(512) DEFAULT NULL,
  `source` varchar(32) NOT NULL DEFAULT 'web',
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_web_visit_created_at` (`created_at`),
  KEY `idx_web_visit_page_created` (`page_path`,`created_at`),
  KEY `idx_web_visit_visitor_created` (`visitor_key`,`created_at`),
  KEY `idx_web_visit_session_created` (`session_key`,`created_at`),
  KEY `idx_web_visit_source_created` (`source`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ai_help_response_cache` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `module_key` varchar(64) NOT NULL,
  `scope` varchar(32) NOT NULL DEFAULT 'question',
  `question_hash` char(64) NOT NULL,
  `normalized_question` varchar(512) NOT NULL,
  `original_question` varchar(512) DEFAULT NULL,
  `command_name` varchar(64) DEFAULT NULL,
  `answer_text` mediumtext NOT NULL,
  `source` varchar(32) NOT NULL DEFAULT 'deterministic',
  `model_name` varchar(80) DEFAULT NULL,
  `metadata` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`metadata`)),
  `hit_count` int(10) unsigned NOT NULL DEFAULT 1,
  `last_used_at` timestamp NULL DEFAULT current_timestamp(),
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ai_help_response_cache_lookup` (`module_key`,`scope`,`question_hash`),
  KEY `idx_ai_help_response_cache_module_command_used` (`module_key`,`command_name`,`last_used_at`),
  KEY `idx_ai_help_response_cache_used` (`last_used_at`),
  KEY `idx_ai_help_response_cache_source_used` (`source`,`last_used_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ai_learning_events` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `user_question` varchar(512) NOT NULL,
  `normalized_question` varchar(512) NOT NULL,
  `tool_suggested` varchar(64) NOT NULL,
  `tool_executed` varchar(64) NOT NULL,
  `success` tinyint(1) NOT NULL DEFAULT 1,
  `confidence` decimal(5,4) DEFAULT NULL,
  `processed` tinyint(1) NOT NULL DEFAULT 0,
  `processed_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_ai_learning_events_processed_created` (`processed`,`created_at`),
  KEY `idx_ai_learning_events_tool_created` (`tool_executed`,`created_at`),
  KEY `idx_ai_learning_events_norm_question` (`normalized_question`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ai_learned_patterns` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `pattern` varchar(512) NOT NULL,
  `tool` varchar(64) NOT NULL,
  `confidence` decimal(5,4) NOT NULL DEFAULT 0.5000,
  `source_event_id` bigint(20) unsigned NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ai_learned_patterns_event_pattern` (`source_event_id`,`tool`,`pattern`),
  KEY `idx_ai_learned_patterns_tool_created` (`tool`,`created_at`),
  KEY `idx_ai_learned_patterns_tool_confidence` (`tool`,`confidence`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ai_learned_keywords` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `keyword` varchar(128) NOT NULL,
  `tool` varchar(64) NOT NULL,
  `weight` decimal(6,4) NOT NULL DEFAULT 1.0000,
  `source_event_id` bigint(20) unsigned NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ai_learned_keywords_event_keyword` (`source_event_id`,`tool`,`keyword`),
  KEY `idx_ai_learned_keywords_tool_created` (`tool`,`created_at`),
  KEY `idx_ai_learned_keywords_tool_weight` (`tool`,`weight`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ai_question_embeddings` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `question` varchar(512) NOT NULL,
  `embedding` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`embedding`)),
  `tool` varchar(64) NOT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_ai_question_embeddings_tool_created` (`tool`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ai_command_config_enrichment_cursor` (
  `id` tinyint(3) unsigned NOT NULL DEFAULT 1,
  `last_learning_event_id` bigint(20) unsigned NOT NULL DEFAULT 0,
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ai_command_config_enrichment_suggestion` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `module_key` varchar(64) NOT NULL,
  `command_name` varchar(64) NOT NULL,
  `source_tool` varchar(64) DEFAULT NULL,
  `source_event_id` bigint(20) unsigned DEFAULT NULL,
  `user_question` varchar(512) DEFAULT NULL,
  `normalized_question` varchar(512) DEFAULT NULL,
  `suggestion_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`suggestion_json`)),
  `confidence` decimal(5,4) NOT NULL DEFAULT 0.5000,
  `model_name` varchar(80) DEFAULT NULL,
  `source` varchar(32) NOT NULL DEFAULT 'llm',
  `status` enum('pending','applied','rejected') NOT NULL DEFAULT 'pending',
  `suggestion_hash` char(64) NOT NULL,
  `review_notes` varchar(255) DEFAULT NULL,
  `applied_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ai_command_cfg_enrichment_suggestion_hash` (`suggestion_hash`),
  KEY `idx_ai_command_cfg_enrichment_module_command_status` (`module_key`,`command_name`,`status`,`updated_at`),
  KEY `idx_ai_command_cfg_enrichment_source_event` (`source_event_id`,`updated_at`),
  KEY `idx_ai_command_cfg_enrichment_status_updated` (`status`,`updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `ai_command_config_enrichment_state` (
  `id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `module_key` varchar(64) NOT NULL,
  `command_name` varchar(64) NOT NULL,
  `overlay_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`overlay_json`)),
  `version` int(10) unsigned NOT NULL DEFAULT 1,
  `confidence` decimal(5,4) NOT NULL DEFAULT 0.5000,
  `last_suggestion_id` bigint(20) unsigned DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT current_timestamp(),
  `updated_at` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ai_command_cfg_enrichment_state_module_command` (`module_key`,`command_name`),
  KEY `idx_ai_command_cfg_enrichment_state_updated` (`updated_at`),
  KEY `idx_ai_command_cfg_enrichment_state_last_suggestion` (`last_suggestion_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
SET FOREIGN_KEY_CHECKS = 1;
