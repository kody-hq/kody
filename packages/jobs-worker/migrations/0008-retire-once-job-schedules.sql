DELETE FROM jobs
WHERE json_extract(schedule_json, '$.type') = 'once'
  AND (enabled = 0 OR last_run_at IS NOT NULL OR deleted_at IS NOT NULL);

DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'enabled once jobs that have not run remain; move them to workflows before 0008.'
WHERE EXISTS (
	SELECT 1
	FROM jobs
	WHERE json_extract(schedule_json, '$.type') = 'once'
);

DROP TABLE __migration_assertions;
