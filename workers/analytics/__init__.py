"""The analytics worker: camera frames in, `sightings` rows out.

Day 1's vertical slice. Decode with PyAV (PTS, never arrival time), gate on motion, detect with
YOLO11, track with ByteTrack, publish to the Valkey `sightings` stream. `packages/api/src/consumers/
sightings.ts` drains that stream into Postgres.

No ANPR and no vehicle attributes — D2-01 and D2-02 own those, and they extend the same payload.
"""
