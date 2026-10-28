import {
	type SkillReadEvent,
	type SkillReadSummary,
} from '#universal/skill-metrics.ts'

export function initializeSkillReads(sql: SqlStorage) {
	sql.exec(`CREATE TABLE IF NOT EXISTS skill_reads (
  id TEXT PRIMARY KEY NOT NULL,
  occurred_at TEXT NOT NULL,
  package_id TEXT NOT NULL,
  skill_uri TEXT NOT NULL,
  actor_id TEXT,
  read_kind TEXT NOT NULL,
  event_json TEXT NOT NULL
 )`)
	sql.exec(
		'CREATE INDEX IF NOT EXISTS skill_reads_package_time ON skill_reads(package_id, occurred_at)',
	)
}

export function insertSkillRead(sql: SqlStorage, event: SkillReadEvent) {
	sql.exec(
		`INSERT OR IGNORE INTO skill_reads
 (id, occurred_at, package_id, skill_uri, actor_id, read_kind, event_json)
 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		event.id,
		event.occurredAt,
		event.packageId,
		event.skillUri,
		event.actorId,
		event.kind,
		JSON.stringify(event),
	)
}

export function summarizeSkillReads(
	sql: SqlStorage,
	input: { since: string; packageIds: Array<string> },
): SkillReadSummary {
	const where =
		'occurred_at >= ? AND package_id IN (SELECT value FROM json_each(?))'
	const params = [input.since, JSON.stringify(input.packageIds)]
	const total = sql
		.exec<{ instructions: number; supporting: number; readers: number }>(
			`SELECT
  COALESCE(SUM(read_kind = 'instructions'), 0) AS instructions,
  COALESCE(SUM(read_kind = 'supporting-file'), 0) AS supporting,
  COUNT(DISTINCT actor_id) AS readers FROM skill_reads WHERE ${where}`,
			...params,
		)
		.one()
	const topSkills = sql
		.exec<{ uri: string; name: string; packageName: string; reads: number }>(
			`SELECT skill_uri AS uri,
  MAX(json_extract(event_json, '$.skillName')) AS name,
  MAX(json_extract(event_json, '$.packageName')) AS packageName,
  COUNT(*) AS reads FROM skill_reads WHERE ${where} AND read_kind = 'instructions'
  GROUP BY skill_uri ORDER BY reads DESC, skill_uri ASC LIMIT 5`,
			...params,
		)
		.toArray()
	const skillActivity = sql
		.exec<{ uri: string; reads: number; lastRead: string }>(
			`SELECT skill_uri AS uri, COUNT(*) AS reads, MAX(occurred_at) AS lastRead
		FROM skill_reads WHERE ${where} AND read_kind = 'instructions' GROUP BY skill_uri`,
			...params,
		)
		.toArray()
	const dailyReads = sql
		.exec<{ day: string; skillUri: string | null; reads: number }>(
			`SELECT substr(occurred_at, 1, 10) AS day,
		CASE WHEN skill_uri IN (SELECT value FROM json_each(?)) THEN skill_uri ELSE NULL END AS skillUri,
		COUNT(*) AS reads
		FROM skill_reads WHERE ${where} AND read_kind = 'instructions'
		GROUP BY day, skillUri ORDER BY day, skillUri`,
			JSON.stringify(topSkills.map((skill) => skill.uri)),
			...params,
		)
		.toArray()
	const recentReads = sql
		.exec<{ event_json: string }>(
			`SELECT event_json FROM skill_reads WHERE ${where}
 ORDER BY occurred_at DESC, id DESC LIMIT 20`,
			...params,
		)
		.toArray()
		.map((row) => JSON.parse(row.event_json) as SkillReadEvent)
	return {
		since: input.since,
		instructionReads: total.instructions,
		supportingFileReads: total.supporting,
		readers: total.readers,
		topSkills,
		dailyReads,
		skillActivity,
		recentReads,
	}
}

export function exportSkillReads(
	sql: SqlStorage,
	startAfter: string,
	limit: number,
) {
	const rows = sql
		.exec<{ id: string; event_json: string }>(
			'SELECT id, event_json FROM skill_reads WHERE id > ? ORDER BY id LIMIT ?',
			startAfter,
			limit + 1,
		)
		.toArray()
	const events = rows
		.slice(0, limit)
		.map((row) => JSON.parse(row.event_json) as SkillReadEvent)
	return {
		events,
		truncated: rows.length > limit,
		nextId: events.at(-1)?.id ?? startAfter,
	}
}
