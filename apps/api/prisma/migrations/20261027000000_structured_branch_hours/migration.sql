-- W7 / D-W6: structured branch hours. Additive: the free-text "opening_hours" column stays
-- exactly as it was (the API stops writing it), and the structured document sits beside it.

-- AlterTable
ALTER TABLE "branch" ADD COLUMN     "operating_hours" JSONB,
ADD COLUMN     "operating_hours_origin" VARCHAR(20),
ADD COLUMN     "operating_hours_updated_at" TIMESTAMP(3),
ADD COLUMN     "operating_hours_updated_by" UUID,
ADD COLUMN     "operating_hours_version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "branch_hours_extension" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "reason" VARCHAR(500) NOT NULL,
    "approved_by_user_id" UUID NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoked_by_user_id" UUID,
    "revocation_reason" VARCHAR(500),

    CONSTRAINT "branch_hours_extension_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "branch_hours_extension_tenant_id_branch_id_ends_at_idx" ON "branch_hours_extension"("tenant_id", "branch_id", "ends_at");

-- AddForeignKey
ALTER TABLE "branch_hours_extension" ADD CONSTRAINT "branch_hours_extension_tenant_id_branch_id_fkey" FOREIGN KEY ("tenant_id", "branch_id") REFERENCES "branch"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The document's full shape is checked by validateBranchHours in @pharmaceylon/shared. The
-- database holds the two rules that must never slip: D8's mandatory value is null or a list,
-- and text from before W7 is never read as a mandatory restriction.
ALTER TABLE branch ADD CONSTRAINT branch_operating_hours_shape CHECK ((
  operating_hours_version > 0
  AND ((operating_hours IS NULL AND operating_hours_origin IS NULL)
    OR (jsonb_typeof(operating_hours) = 'object'
      AND operating_hours->'schemaVersion' = '1'::jsonb
      AND jsonb_typeof(operating_hours->'weekly') = 'object'
      AND jsonb_typeof(operating_hours->'exceptions') = 'array'
      AND jsonb_typeof(operating_hours->'mandatory') IN ('null', 'array')
      AND operating_hours_origin IN ('legacy_text', 'editor')))
  AND (operating_hours_origin IS DISTINCT FROM 'legacy_text'
    OR operating_hours->'mandatory' = 'null'::jsonb)
) IS TRUE);

ALTER TABLE branch_hours_extension ADD CONSTRAINT branch_hours_extension_shape CHECK (
  ends_at > starts_at AND ends_at - starts_at <= interval '24 hours'
  AND length(trim(reason)) > 0
  AND ((revoked_at IS NULL AND revoked_by_user_id IS NULL AND revocation_reason IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by_user_id IS NOT NULL AND revocation_reason IS NOT NULL
      AND revoked_at >= approved_at AND length(trim(revocation_reason)) > 0))
);
-- An extension is approval evidence a grant may cite: keep it, and record a revocation once.
CREATE FUNCTION pc_preserve_branch_hours_extension() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE revocation text[] := ARRAY['revoked_at', 'revoked_by_user_id', 'revocation_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Business-hours extensions must be retained'; END IF;
  IF (to_jsonb(NEW) - revocation) IS DISTINCT FROM (to_jsonb(OLD) - revocation)
     OR (OLD.revoked_at IS NOT NULL AND ROW(NEW.revoked_at, NEW.revoked_by_user_id, NEW.revocation_reason)
       IS DISTINCT FROM ROW(OLD.revoked_at, OLD.revoked_by_user_id, OLD.revocation_reason)) THEN
    RAISE EXCEPTION 'Extension content and revocation history are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER preserve_branch_hours_extension BEFORE UPDATE OR DELETE ON branch_hours_extension
  FOR EACH ROW EXECUTE FUNCTION pc_preserve_branch_hours_extension();
CREATE POLICY pc_tenant_isolation ON branch_hours_extension
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
-- RLS remains disabled, consistent with the staged inventory.

-- Reading the old free text. Only text that can be read in full and without guessing becomes
-- structured hours; anything else stays NULL for the owner to enter, with the text shown beside
-- the editor. A bare "8 - 5" could mean morning or evening, so it is left alone. Days the text
-- doesn't mention are closed ("Mon-Sat 8am-9pm" says nothing about Sunday opening). Nothing here
-- produces a mandatory restriction. The functions stay so tests run the same code the backfill did.

-- One time of day: {minutes after midnight, kind}. kind 1 = had am/pm, 2 = 24-hour clock
-- ("08:00", "20", "2030"), 3 = noon/midnight, 0 = bare and ambiguous ("8", "8:30", "10").
CREATE FUNCTION pc_legacy_hours_time(tok text) RETURNS integer[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE m text[]; h integer; mi integer;
BEGIN
  tok := btrim(tok);
  IF tok IN ('noon', 'midday', '12 noon') THEN RETURN ARRAY[720, 3]; END IF;
  IF tok IN ('midnight', '12 midnight') THEN RETURN ARRAY[0, 3]; END IF;
  m := regexp_match(tok, '^(\d{1,2})(?:[:.](\d{2}))? ?(am|pm)$');
  IF m IS NOT NULL THEN
    h := m[1]::integer; mi := coalesce(m[2], '0')::integer;
    IF h < 1 OR h > 12 OR mi > 59 THEN RETURN NULL; END IF;
    IF m[3] = 'am' AND h = 12 THEN h := 0; END IF;
    IF m[3] = 'pm' AND h < 12 THEN h := h + 12; END IF;
    RETURN ARRAY[h * 60 + mi, 1];
  END IF;
  m := regexp_match(tok, '^(\d{2})(\d{2})$');
  IF m IS NOT NULL THEN
    h := m[1]::integer; mi := m[2]::integer;
    IF h > 24 OR mi > 59 OR (h = 24 AND mi > 0) THEN RETURN NULL; END IF;
    RETURN ARRAY[h * 60 + mi, 2];
  END IF;
  m := regexp_match(tok, '^(\d{1,2})(?:[:.](\d{2}))?$');
  IF m IS NULL THEN RETURN NULL; END IF;
  h := m[1]::integer; mi := coalesce(m[2], '0')::integer;
  IF h > 24 OR mi > 59 OR (h = 24 AND mi > 0) THEN RETURN NULL; END IF;
  RETURN ARRAY[h * 60 + mi,
    CASE WHEN h >= 13 OR (m[2] IS NOT NULL AND length(m[1]) = 2) THEN 2 ELSE 0 END];
END;
$$;

-- "mon - fri", "sat & sun", "weekdays", "daily" → day indexes 0 (Monday) to 6, or NULL.
CREATE FUNCTION pc_legacy_hours_days(part text) RETURNS integer[] LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  day_name CONSTANT text := '^(mon(day)?|tue(s|sday)?|wed(nesday)?|thu(r|rs|rsday)?|fri(day)?|sat(urday)?|sun(day)?)$';
  names CONSTANT text[] := ARRAY['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  tok text; m text[]; a integer; b integer; result integer[] := '{}';
BEGIN
  FOREACH tok IN ARRAY regexp_split_to_array(btrim(part), '\s*(?:,|&|/| and )\s*') LOOP
    IF tok ~ '^(daily|every ?day|all days|7 days( a week)?)$' THEN
      result := result || ARRAY[0, 1, 2, 3, 4, 5, 6];
    ELSIF tok ~ '^weekdays?$' THEN
      result := result || ARRAY[0, 1, 2, 3, 4];
    ELSIF tok ~ '^weekends?$' THEN
      result := result || ARRAY[5, 6];
    ELSE
      m := regexp_match(tok, '^([a-z]+)(?: - ([a-z]+))?$');
      IF m IS NULL OR m[1] !~ day_name OR (m[2] IS NOT NULL AND m[2] !~ day_name) THEN RETURN NULL; END IF;
      a := array_position(names, left(m[1], 3)) - 1;
      b := coalesce(array_position(names, left(m[2], 3)) - 1, a);
      LOOP
        result := result || a;
        EXIT WHEN a = b;
        a := (a + 1) % 7;
      END LOOP;
    END IF;
  END LOOP;
  RETURN result;
END;
$$;

-- "08:00 - 20:00", "8am - 1pm, 2pm - 6pm", "closed", "24 hours" → DayHours JSON, or NULL.
CREATE FUNCTION pc_legacy_hours_day(part text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  piece text; m text[]; a integer[]; b integer[]; opens integer; closes integer;
  starts integer[] := '{}'; ends integer[] := '{}'; i integer; ranges jsonb;
BEGIN
  part := btrim(regexp_replace(btrim(part), '^(open|opens|from|hours)\s*:?\s*', ''));
  IF part ~ '^(closed|close|shut|off|holiday)$' THEN RETURN '{"mode": "closed"}'::jsonb; END IF;
  IF part ~ '^(open )?(24 ?(hours|hrs|hr|h)( open)?|24 ?/ ?7|all day)$' THEN
    RETURN '{"mode": "open_24h"}'::jsonb;
  END IF;
  part := regexp_replace(part, '\s*(hrs|hr|hours|h)\.?$', '');
  FOREACH piece IN ARRAY regexp_split_to_array(part, '\s*(?:,|&|/| and )\s*') LOOP
    m := regexp_match(piece, '^([^-]+) - ([^-]+)$');
    IF m IS NULL THEN RETURN NULL; END IF;
    a := pc_legacy_hours_time(m[1]);
    b := pc_legacy_hours_time(m[2]);
    IF a IS NULL OR b IS NULL THEN RETURN NULL; END IF;
    -- A bare hour is only read when the other end is on a 24-hour clock ("8 - 20").
    IF (a[2] = 0 AND b[2] <> 2) OR (b[2] = 0 AND a[2] <> 2) THEN RETURN NULL; END IF;
    opens := a[1];
    closes := CASE WHEN b[1] = 0 THEN 1440 ELSE b[1] END;
    IF opens >= 1440 OR closes = opens THEN RETURN NULL; END IF;
    IF closes < opens THEN
      -- Past midnight only from an evening opening, written without ambiguity ("18:00 - 02:00").
      IF opens < 720 OR a[2] = 0 OR b[2] = 0 THEN RETURN NULL; END IF;
      closes := closes + 1440;
    END IF;
    FOR i IN 1 .. coalesce(array_length(starts, 1), 0) LOOP
      IF opens < ends[i] AND starts[i] < closes THEN RETURN NULL; END IF;
    END LOOP;
    starts := starts || opens;
    ends := ends || closes;
  END LOOP;
  IF coalesce(array_length(starts, 1), 0) NOT BETWEEN 1 AND 4 THEN RETURN NULL; END IF;
  SELECT jsonb_agg(jsonb_build_object(
      'opens', lpad((s / 60)::text, 2, '0') || ':' || lpad((s % 60)::text, 2, '0'),
      'closes', CASE WHEN e = 1440 THEN '24:00'
        ELSE lpad(((e % 1440) / 60)::text, 2, '0') || ':' || lpad((e % 60)::text, 2, '0') END)
    ORDER BY s)
    INTO ranges FROM unnest(starts, ends) AS r(s, e);
  RETURN jsonb_build_object('mode', 'hours', 'ranges', ranges);
END;
$$;

CREATE FUNCTION pc_parse_legacy_opening_hours(raw text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  day_word CONSTANT text := '(?:mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|daily|every ?day|weekdays?|weekends?|all days|7 days(?: a week)?)';
  names CONSTANT text[] := ARRAY['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  t text; seg text; chunk text; cur text; piece text; pieces text[] := '{}';
  m text[]; days integer[]; day_hours jsonb; d integer;
  week jsonb[] := ARRAY[NULL, NULL, NULL, NULL, NULL, NULL, NULL]::jsonb[];
  weekly jsonb;
BEGIN
  IF raw IS NULL OR btrim(raw) = '' THEN RETURN NULL; END IF;
  t := lower(raw);
  t := regexp_replace(t, '[\r\n]+', ';', 'g');
  t := translate(t, E'‒–—―−', '-----');
  t := regexp_replace(t, 'a\.\s*m\.?', 'am', 'g');
  t := regexp_replace(t, 'p\.\s*m\.?', 'pm', 'g');
  t := regexp_replace(t, '\s+(?:to|till|until)\s+', ' - ', 'g');
  t := regexp_replace(t, '\s*-\s*', ' - ', 'g');
  t := regexp_replace(t, '\s+', ' ', 'g');
  t := btrim(t, ' .;,');
  IF t = '' THEN RETURN NULL; END IF;

  IF t ~ '^(?:open )?(?:24 ?/ ?7|24 ?(?:hours|hrs|hr|h)(?: a day)?(?: open)?(?:,? (?:daily|every ?day|7 days(?: a week)?))?|always open)$' THEN
    RETURN jsonb_build_object('schemaVersion', 1,
      'weekly', (SELECT jsonb_object_agg(n, '{"mode": "open_24h"}'::jsonb) FROM unnest(names) AS n),
      'exceptions', '[]'::jsonb, 'mandatory', 'null'::jsonb);
  END IF;

  -- Segments split on ";" and new lines. A comma starts a new segment only when what came
  -- before already had its hours and a day name follows ("Mon-Fri 8am-6pm, Sat 9am-1pm"), not
  -- inside a list of days ("Mon, Wed 9am-1pm") or of times ("8am-1pm, 2pm-6pm").
  FOREACH seg IN ARRAY regexp_split_to_array(t, '\s*[;|]\s*') LOOP
    CONTINUE WHEN seg = '';
    cur := NULL;
    FOREACH chunk IN ARRAY regexp_split_to_array(seg, '\s*,\s*') LOOP
      IF cur IS NOT NULL AND cur ~ '\d|closed' AND chunk ~ ('^' || day_word || '(?:$|[^a-z])') THEN
        pieces := pieces || cur;
        cur := chunk;
      ELSE
        cur := CASE WHEN cur IS NULL THEN chunk ELSE cur || ', ' || chunk END;
      END IF;
    END LOOP;
    pieces := pieces || cur;
  END LOOP;

  FOREACH piece IN ARRAY pieces LOOP
    m := regexp_match(piece,
      '^(' || day_word || '(?:\s*(?:,|&|/| and | - )\s*' || day_word || ')*)\s*:?\s*(.*)$');
    IF m IS NULL THEN
      -- Hours with no day in front: "8am - 10pm daily", or the whole text being just hours.
      m := regexp_match(piece, '^([^a-z].*[^,\s])\s*,?\s*(daily|every ?day|all days|7 days a week|7 days)$');
      IF m IS NOT NULL THEN
        m := ARRAY['daily', m[1]];
      ELSIF array_length(pieces, 1) = 1 THEN
        m := ARRAY['daily', piece];
      ELSE
        RETURN NULL;
      END IF;
    END IF;
    days := pc_legacy_hours_days(m[1]);
    day_hours := pc_legacy_hours_day(m[2]);
    IF days IS NULL OR day_hours IS NULL THEN RETURN NULL; END IF;
    -- A later segment wins for its days ("Daily 8am-10pm; Sunday 9am-1pm").
    FOREACH d IN ARRAY days LOOP
      week[d + 1] := day_hours;
    END LOOP;
  END LOOP;

  SELECT jsonb_object_agg(names[i], coalesce(week[i], '{"mode": "closed"}'::jsonb))
    INTO weekly FROM generate_series(1, 7) AS i;
  RETURN jsonb_build_object('schemaVersion', 1, 'weekly', weekly,
    'exceptions', '[]'::jsonb, 'mandatory', 'null'::jsonb);
EXCEPTION WHEN others THEN
  -- Unreadable text is left for a person; it must never stop the migration.
  RETURN NULL;
END;
$$;

-- Backfill. Only branches without structured hours, so running it again can't overwrite hours
-- a person has saved since.
UPDATE branch
   SET operating_hours = parsed.hours,
       operating_hours_origin = 'legacy_text',
       operating_hours_updated_at = CURRENT_TIMESTAMP
  FROM (SELECT id, pc_parse_legacy_opening_hours(opening_hours) AS hours
          FROM branch WHERE opening_hours IS NOT NULL AND operating_hours IS NULL) AS parsed
 WHERE branch.id = parsed.id AND parsed.hours IS NOT NULL AND branch.operating_hours IS NULL;
