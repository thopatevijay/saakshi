-- Reverse of 0022.
--
-- The descriptors go. Any `identity_sightings` rows a re-ID bridge wrote from them do **not** go:
-- they carry `link_method = 'reid_bridge'` and their own `link_confidence`, they are what an
-- exported trace was built from, and deleting evidence because the thing that derived it was rolled
-- back would break the chain of custody D3-04 exists to protect.
--
-- To withdraw the links themselves, delete them explicitly and audit the deletion:
--   DELETE FROM identity_sightings WHERE link_method = 'reid_bridge';

DROP TABLE IF EXISTS sighting_appearance;
