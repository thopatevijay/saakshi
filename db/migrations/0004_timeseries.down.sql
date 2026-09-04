-- Dropping a hypertable drops its chunks and its timescaledb_information row with it.
DROP TABLE IF EXISTS sightings;
DROP TABLE IF EXISTS camera_health_checks;
