# Monitoring source references

The PostgreSQL exporter’s `stat_database` collector is enabled by default and the exporter defaults its metric prefix to `pg`; its dynamic mapping convention exports `pg_stat_database_<column>`. PostgreSQL defines `pg_stat_database.deadlocks` as the number of deadlocks detected in that database. Consequently this stack alerts on `pg_stat_database_deadlocks`.

- [prometheus-community/postgres_exporter README](https://github.com/prometheus-community/postgres_exporter)
- [PostgreSQL: Monitoring Database Activity](https://www.postgresql.org/docs/current/monitoring-stats.html)
