-- P1: a direct stock adjustment resent under its Idempotency-Key is replayed only when the body
-- matches the first one, so the first body is kept beside the key. Nullable: other scopes compare
-- against their resource, and existing rows have nothing to keep.
ALTER TABLE "idempotency_record" ADD COLUMN "request_body" JSONB;
