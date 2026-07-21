-- Baseline migration.
-- This is a no-op marker recording the state of the database
-- at the time the incremental migration system was introduced.
--
-- Any schema present BEFORE this file was created is considered
-- baseline and managed via sql/schema.sql (which remains
-- authoritative for fresh environments).
--
-- New changes should be added as new migration files with a later
-- timestamp in the filename (e.g. 20260722_1000_add_column_foo.sql).

SELECT 1 AS baseline_marker;
