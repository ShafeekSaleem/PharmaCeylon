-- #179: a counter's name must be unique within its branch (trimmed, case-insensitive), so staff can
-- tell two counters apart in the enrollment picker, reports and at the till.
--
-- Existing duplicates are handled first and nothing is deleted: within each group of counters that
-- share a name at a branch, the oldest-created row (lowest id) keeps its name and every later one is
-- renamed "<name> (2)", "<name> (3)", ... picking the first suffix not already used at that branch.
-- Ids, till ids, enrollments, shifts and history are untouched; only the label text changes.
DO $$
DECLARE
  r RECORD;
  base text;
  n int;
  candidate text;
BEGIN
  FOR r IN
    SELECT id, tenant_id, branch_id, btrim(label) AS clean
    FROM (
      SELECT id, tenant_id, branch_id, label,
             row_number() OVER (
               PARTITION BY tenant_id, branch_id, lower(btrim(label))
               ORDER BY id
             ) AS rn
      FROM terminal_counter
    ) ranked
    WHERE rn > 1
    ORDER BY tenant_id, branch_id, id
  LOOP
    base := left(r.clean, 110);
    n := 2;
    LOOP
      candidate := base || ' (' || n || ')';
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM terminal_counter
        WHERE tenant_id = r.tenant_id AND branch_id = r.branch_id
          AND lower(btrim(label)) = lower(candidate)
      );
      n := n + 1;
    END LOOP;
    UPDATE terminal_counter SET label = candidate WHERE id = r.id;
  END LOOP;
END $$;

CREATE UNIQUE INDEX terminal_counter_branch_label_key
  ON terminal_counter (tenant_id, branch_id, lower(btrim(label)));
