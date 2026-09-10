ALTER TABLE jobs ADD COLUMN lease_token uuid;
ALTER TABLE chunks ADD COLUMN event_id uuid;
ALTER TABLE sessions ADD COLUMN test_mode boolean NOT NULL DEFAULT true;
CREATE INDEX session_records_order ON sessions(created_at DESC,id DESC);
CREATE INDEX segment_role_lookup ON role_segments(role_version_id,session_id);
