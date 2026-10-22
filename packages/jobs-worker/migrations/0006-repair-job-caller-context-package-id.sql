-- Restore package storage context on job rows that lost
-- storageContext.packageId (Run now used to persist the clicker's interactive
-- caller context onto the job row). Package id comes from the job id
-- (`package-job:{packageId}:{name}`), matching createPackageJobCallerContext
-- / publish. Soft-deleted rows are left alone.

CREATE TABLE IF NOT EXISTS job_caller_context_package_id_repair (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	repaired_count INTEGER NOT NULL,
	repaired_at TEXT NOT NULL
);

INSERT INTO job_caller_context_package_id_repair (singleton, repaired_count, repaired_at)
SELECT
	1,
	(
		SELECT COUNT(*)
		FROM jobs
		WHERE deleted_at IS NULL
			AND substr(id, 1, 12) = 'package-job:'
			AND instr(substr(id, 13), ':') > 0
			AND trim(substr(id, 13, instr(substr(id, 13), ':') - 1)) <> ''
			AND (
				json_extract(caller_context_json, '$.storageContext.packageId') IS NULL
				OR trim(
					coalesce(
						json_extract(caller_context_json, '$.storageContext.packageId'),
						''
					)
				) = ''
			)
	),
	strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
ON CONFLICT(singleton) DO UPDATE SET
	repaired_count = excluded.repaired_count,
	repaired_at = excluded.repaired_at;

UPDATE jobs
SET caller_context_json = json_set(
	json_set(
		CASE
			WHEN json_type(json_extract(caller_context_json, '$.storageContext')) = 'object'
				THEN caller_context_json
			ELSE json_set(
				caller_context_json,
				'$.storageContext',
				json_object(
					'sessionId', null,
					'appId', null,
					'packageId', null,
					'storageId', null
				)
			)
		END,
		'$.storageContext.packageId',
		substr(id, 13, instr(substr(id, 13), ':') - 1)
	),
	'$.storageContext.appId',
	substr(id, 13, instr(substr(id, 13), ':') - 1),
	'$.executionOrigin',
	'background'
)
WHERE deleted_at IS NULL
	AND substr(id, 1, 12) = 'package-job:'
	AND instr(substr(id, 13), ':') > 0
	AND trim(substr(id, 13, instr(substr(id, 13), ':') - 1)) <> ''
	AND (
		json_extract(caller_context_json, '$.storageContext.packageId') IS NULL
		OR trim(
			coalesce(
				json_extract(caller_context_json, '$.storageContext.packageId'),
				''
			)
		) = ''
	);

DROP TABLE IF EXISTS __migration_assertions;
CREATE TABLE __migration_assertions (
	message TEXT NOT NULL CHECK (0)
);

INSERT INTO __migration_assertions (message)
SELECT 'package job still missing storageContext.packageId after 0006 repair - aborting.'
WHERE EXISTS (
	SELECT 1
	FROM jobs
	WHERE deleted_at IS NULL
		AND substr(id, 1, 12) = 'package-job:'
		AND instr(substr(id, 13), ':') > 0
		AND trim(substr(id, 13, instr(substr(id, 13), ':') - 1)) <> ''
		AND (
			json_extract(caller_context_json, '$.storageContext.packageId') IS NULL
			OR trim(
				coalesce(
					json_extract(caller_context_json, '$.storageContext.packageId'),
					''
				)
			) = ''
		)
);

DROP TABLE __migration_assertions;
