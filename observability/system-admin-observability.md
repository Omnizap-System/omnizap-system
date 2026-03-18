# System Admin na Observabilidade

Esta integração publica o snapshot do painel `System Admin` no endpoint `/metrics`, permitindo acompanhar os mesmos dados no Prometheus/Grafana.

## Dashboard

- Grafana: `OmniZap System Admin`
- Arquivo: `observability/grafana/dashboards/omnizap-system-admin.json`

## Métricas adicionadas

- `omnizap_admin_overview_updated_at_seconds`
- `omnizap_admin_overview_requests_total{source}`
- `omnizap_admin_counters{counter}`
- `omnizap_admin_dashboard_quick{metric}`
- `omnizap_admin_system_health{metric}`
- `omnizap_admin_alerts_total{severity}`
- `omnizap_admin_feature_flags_total{state}`
- `omnizap_admin_snapshot_items_total{section}`

## Alertas

Em `observability/alert-rules.yml`:

- `OmniZapAdminSnapshotStale`
- `OmniZapAdminCriticalAlerts`
