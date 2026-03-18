-- OmniZap observability setup for MySQL
-- Run as a privileged user (root/admin).
-- This script is idempotent and focused on metrics/logging for mysqld-exporter.

-- 1) Metrics user for mysqld-exporter
-- Matches docker-compose default DSN:
-- exporter:exporter@unix(/run/mysqld/mysqld.sock)/
CREATE USER IF NOT EXISTS 'exporter'@'%' IDENTIFIED BY 'exporter';
ALTER USER 'exporter'@'%' IDENTIFIED BY 'exporter';

GRANT PROCESS, REPLICATION CLIENT, SELECT ON *.* TO 'exporter'@'%';
GRANT SELECT ON performance_schema.* TO 'exporter'@'%';
GRANT SELECT ON information_schema.* TO 'exporter'@'%';
GRANT SELECT ON sys.* TO 'exporter'@'%';
FLUSH PRIVILEGES;

-- 2) Slow query log (runtime values; set in my.cnf for persistence)
SET GLOBAL slow_query_log = ON;
SET GLOBAL long_query_time = 0.5;
SET GLOBAL log_output = 'FILE';
-- This path matches promtail's mysql-slow scrape target in observability/promtail-config.yml.
SET GLOBAL slow_query_log_file = '/var/log/mysql/mysql-slow.log';

-- 3) Performance Schema consumers/instruments
-- NOTE: performance_schema itself cannot be enabled dynamically.
-- If disabled, set performance_schema=ON in my.cnf and restart MySQL.
UPDATE performance_schema.setup_instruments
SET ENABLED = 'YES', TIMED = 'YES'
WHERE NAME LIKE 'statement/%';

UPDATE performance_schema.setup_consumers
SET ENABLED = 'YES'
WHERE NAME IN (
  'events_statements_current',
  'events_statements_history',
  'events_statements_history_long',
  'events_waits_current',
  'events_waits_history',
  'events_waits_history_long'
);

-- 4) InnoDB diagnostics
SET GLOBAL innodb_monitor_enable = 'all';
SET GLOBAL innodb_status_output = ON;
SET GLOBAL innodb_status_output_locks = ON;
SET GLOBAL innodb_print_all_deadlocks = ON;
