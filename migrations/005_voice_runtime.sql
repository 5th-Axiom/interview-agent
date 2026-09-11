-- Existing sessions retain protocol 1. New sessions explicitly freeze their runtime profile.
ALTER TABLE sessions ADD COLUMN runtime_config jsonb NOT NULL DEFAULT '{"protocol":1,"turnCoordinator":true,"audioPipeline":false,"conversationView":false,"contextBudget":false,"promptVersion":"interview-legacy"}';
ALTER TABLE role_versions ADD COLUMN platform_prompt_version text NOT NULL DEFAULT 'legacy';
ALTER TABLE snapshots ADD COLUMN prompt_version text NOT NULL DEFAULT 'legacy';
ALTER TABLE snapshots ADD COLUMN model_profile jsonb NOT NULL DEFAULT '{}';
ALTER TABLE snapshots ADD COLUMN token_estimate integer NOT NULL DEFAULT 0;

ALTER TABLE otp_codes ADD COLUMN delivery_state text NOT NULL DEFAULT 'sent'
  CHECK(delivery_state IN ('pending','sent','failed'));
ALTER TABLE otp_codes ADD COLUMN delivery_token uuid;
ALTER TABLE otp_codes ADD COLUMN delivery_until timestamptz;

CREATE TABLE rate_limits (
  scope text NOT NULL, identity_hash text NOT NULL, window_start timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 1, expires_at timestamptz NOT NULL,
  PRIMARY KEY(scope,identity_hash)
);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);

CREATE TABLE voice_connections (
  session_id uuid NOT NULL REFERENCES sessions(id), epoch integer NOT NULL,
  client_id uuid, created_at timestamptz NOT NULL DEFAULT now(), retired_at timestamptz,
  PRIMARY KEY(session_id,epoch)
);
CREATE TABLE response_runs (
  id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES sessions(id), epoch integer NOT NULL,
  generation integer NOT NULL, input_turn_id uuid, input_revision integer NOT NULL DEFAULT 0,
  trigger text NOT NULL, state text NOT NULL, cancellation_reason text,
  prompt_version text NOT NULL, model_profile jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE INDEX response_runs_session ON response_runs(session_id,created_at);

ALTER TABLE chunks ADD COLUMN byte_length integer;
ALTER TABLE chunks ADD COLUMN frame_seq bigint;
ALTER TABLE chunks ADD COLUMN input_turn_id uuid;
ALTER TABLE chunks ADD COLUMN object_offset bigint NOT NULL DEFAULT 0;
ALTER TABLE chunks ADD COLUMN storage_state text NOT NULL DEFAULT 'archived'
  CHECK(storage_state IN ('staged','archived'));
ALTER TABLE chunks DROP CONSTRAINT chunks_object_key_key;
CREATE INDEX chunks_object_key ON chunks(object_key);
CREATE UNIQUE INDEX chunks_frame_identity ON chunks(session_id,epoch,track,frame_seq)
  WHERE frame_seq IS NOT NULL;
CREATE TABLE audio_outbox (
  chunk_id uuid PRIMARY KEY REFERENCES chunks(id), pcm bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(octet_length(pcm)>0 AND octet_length(pcm)<=2880000)
);
CREATE INDEX audio_outbox_created ON audio_outbox(created_at);
CREATE TABLE audio_coverage (
  session_id uuid NOT NULL REFERENCES sessions(id), chunk_no text NOT NULL,
  event_id uuid NOT NULL, PRIMARY KEY(session_id,chunk_no,event_id),
  FOREIGN KEY(session_id,event_id) REFERENCES events(session_id,event_id)
);
ALTER TABLE feedback ADD COLUMN audio_ids uuid[] NOT NULL DEFAULT '{}';

CREATE TABLE utterance_summaries (
  session_id uuid NOT NULL, event_id uuid NOT NULL, content_hash text NOT NULL,
  prompt_version text NOT NULL, model_profile text NOT NULL, content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id,event_id,content_hash,prompt_version,model_profile),
  FOREIGN KEY(session_id,event_id) REFERENCES events(session_id,event_id)
);
CREATE TABLE voice_telemetry (
  id bigserial PRIMARY KEY, session_id uuid NOT NULL REFERENCES sessions(id),
  epoch integer NOT NULL, response_id uuid, input_turn_id uuid,
  stage text NOT NULL, elapsed_ms double precision, detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voice_telemetry_session ON voice_telemetry(session_id,id);
