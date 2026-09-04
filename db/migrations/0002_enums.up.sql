-- 0002 · Enum types.
--
-- Enums, not free text: the ticket is explicit, and a typo in a worker should fail loudly at insert
-- rather than quietly create a new category that never matches a query.
--
-- These values are the contract. Workers and the API must not invent variants — the authoritative
-- list is published on issue #5 and mirrored in packages/shared.

CREATE TYPE camera_type AS ENUM ('analog', 'ip');
CREATE TYPE camera_mount AS ENUM ('static', 'mobile');
CREATE TYPE storage_type AS ENUM ('cloud', 'local');

-- Federation adapters (PROJECT.md §4). `file` is for the recorded-clip path used by the own-feed
-- demonstration (D3-11); `hls` is what the Sentinel sandbox actually serves.
CREATE TYPE adapter_kind AS ENUM ('hls', 'rtsp', 'onvif', 'whep', 'nvr', 'file');

CREATE TYPE camera_status AS ENUM ('unknown', 'online', 'degraded', 'offline');

-- Set by human review during recon (D0-01). Drives which analytics a camera is eligible for:
-- on a wide-area overview a plate is a few pixels tall.
CREATE TYPE camera_geometry AS ENUM ('anpr_viable', 'detection_only', 'unclassified');

CREATE TYPE user_role AS ENUM ('admin', 'supervisor', 'operator', 'auditor');

CREATE TYPE watchlist_category AS ENUM (
  'stolen_vehicle', 'wanted_person', 'missing_person', 'blacklisted_vehicle', 'suspect'
);
CREATE TYPE watchlist_entity_type AS ENUM ('vehicle', 'person');

-- Source systems are *specified* connectors with a mock provider. There is no live VAHAN / SARTHI /
-- eGujCop / AFIS / NAFIS connectivity — this column records which system an entry is modelled on,
-- never a live fetch.
CREATE TYPE source_system AS ENUM ('VAHAN', 'SARTHI', 'eGujCop', 'AFIS', 'NAFIS', 'manual');

CREATE TYPE alert_severity AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE alert_status AS ENUM ('new', 'ack', 'dismissed', 'escalated');
CREATE TYPE match_type AS ENUM ('exact', 'fuzzy');

CREATE TYPE link_method AS ENUM ('plate_exact', 'plate_fuzzy', 'reid_bridge');

CREATE TYPE route_anomaly AS ENUM ('none', 'impossible_transition');

CREATE TYPE vehicle_class AS ENUM (
  'car', 'motorcycle', 'bus', 'truck', 'auto_rickshaw', 'bicycle', 'person', 'unknown'
);
