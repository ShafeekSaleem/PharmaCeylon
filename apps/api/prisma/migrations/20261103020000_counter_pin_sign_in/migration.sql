-- D-W5 PIN sign-in at an enrolled counter (P2b #103). A login opened by a PIN remembers the
-- counter staff session it belongs to; its tokens work only there and only while it is open.
ALTER TABLE "session" ADD COLUMN "counter_session_id" UUID;

-- The PIN sign-in has its own challenge and attendance purpose, so a proof or challenge for one
-- kind of session can never stand in for the other.
ALTER TABLE terminal_challenge DROP CONSTRAINT terminal_challenge_shape_check;
ALTER TABLE terminal_challenge ADD CONSTRAINT terminal_challenge_shape_check CHECK (
  purpose IN ('enrollment', 'session', 'command', 'pin_session') AND nonce_hash ~ '^[0-9a-f]{64}$'
  AND payload_digest ~ '^[0-9a-f]{64}$' AND jsonb_typeof(payload) = 'object'
  AND expires_at > created_at AND (consumed_at IS NULL OR consumed_at >= created_at)
);

ALTER TABLE terminal_attendance_proof DROP CONSTRAINT terminal_attendance_proof_shape_check;
ALTER TABLE terminal_attendance_proof ADD CONSTRAINT terminal_attendance_proof_shape_check CHECK (
  purpose IN ('enrollment', 'session', 'command', 'pin_session') AND session_protocol = 'console'
  AND windows_session_id >= 0 AND payload_digest ~ '^[0-9a-f]{64}$'
  AND attestation_digest ~ '^[0-9a-f]{64}$' AND jsonb_typeof(attestation) = 'object'
  AND length(trim(app_version)) > 0
  AND expires_at > created_at AND (consumed_at IS NULL OR consumed_at >= created_at)
);
