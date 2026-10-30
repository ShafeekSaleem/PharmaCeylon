ALTER TABLE branch ADD COLUMN planned_counter_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE branch ADD CONSTRAINT branch_planned_counter_count_range CHECK (planned_counter_count BETWEEN 1 AND 100);
