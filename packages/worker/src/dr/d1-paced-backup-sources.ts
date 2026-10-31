import { isRecord } from '@kody-internal/shared/is-record.ts'

export type PacedD1SourceBinding = 'APP_DB' | 'AUDIT_DB' | 'JOBS_DB'

export type PacedD1SourceConfig = {
	binding: PacedD1SourceBinding
	name: string
	id: string
}

type EnvWithOptionalJobsDb = Env & { JOBS_DB?: D1Database }

export function parseD1PacedSources(
	raw: string | undefined,
): Array<PacedD1SourceConfig> {
	if (!raw?.trim()) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(raw) as unknown
	} catch {
		throw new Error('DR_D1_PACED_SOURCES must be valid JSON')
	}
	if (!Array.isArray(parsed)) {
		throw new Error('DR_D1_PACED_SOURCES must be a JSON array')
	}
	const sources: Array<PacedD1SourceConfig> = []
	for (const entry of parsed) {
		if (
			!isRecord(entry) ||
			(entry.binding !== 'APP_DB' &&
				entry.binding !== 'AUDIT_DB' &&
				entry.binding !== 'JOBS_DB') ||
			typeof entry.name !== 'string' ||
			entry.name.trim().length === 0 ||
			typeof entry.id !== 'string' ||
			!/^[0-9a-f-]{36}$/i.test(entry.id)
		) {
			throw new Error(
				'DR_D1_PACED_SOURCES entries need binding, name, and UUID id',
			)
		}
		sources.push({
			binding: entry.binding,
			name: entry.name.trim(),
			id: entry.id.toLowerCase(),
		})
	}
	return sources
}

export function resolvePacedD1Binding(
	env: Env,
	binding: PacedD1SourceBinding,
): D1Database | null {
	switch (binding) {
		case 'APP_DB':
			return env.APP_DB
		case 'AUDIT_DB':
			return env.AUDIT_DB
		case 'JOBS_DB':
			return (env as EnvWithOptionalJobsDb).JOBS_DB ?? null
		default: {
			const exhaustive: never = binding
			throw new Error(`Unhandled paced D1 binding: ${String(exhaustive)}`)
		}
	}
}
