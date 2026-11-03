-- D-W5 hardening: PIN locks escalate. A PIN now opens a login at a counter, so 5 guesses per
-- 15-minute lock, forever, was too many for whoever holds a counter's key. The third lock since the
-- person last proved their password switches the PIN off until they sign in with it again.
ALTER TABLE "app_user" ADD COLUMN "pos_pin_lockouts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "app_user" ADD CONSTRAINT app_user_pos_pin_lockouts_check CHECK (pos_pin_lockouts >= 0);
