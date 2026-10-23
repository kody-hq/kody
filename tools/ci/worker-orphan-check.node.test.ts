import { expect, test } from 'vitest'
import {
	checkForOrphanVersion,
	formatOrphanReport,
	normalizeVersions,
} from './worker-orphan-check.ts'

const versions = [
	{
		id: 'bcf9b83d-8666-4b40-8d46-6199a9bc1146',
		metadata: {
			created_on: '2026-10-23T15:16:49Z',
			source: 'wrangler',
			author_email: 'someone@example.com',
		},
		annotations: { 'workers/triggered_by': 'version_upload' },
	},
	{
		id: '3a6da96b-6da8-4393-b906-8ede58c99374',
		metadata: { created_on: '2026-10-23T15:25:24Z', source: 'wrangler' },
		annotations: {
			'workers/triggered_by': 'version_upload',
			'workers/tag': 'gh-39976970841-1',
			'workers/message': 'f5effa8dc3',
		},
	},
]

test('reports ok when the newest version is deployed', () => {
	const result = checkForOrphanVersion(versions, {
		versions: [
			{ version_id: '3a6da96b-6da8-4393-b906-8ede58c99374', percentage: 100 },
		],
	})
	expect(result.status).toBe('ok')
})

test('reports the undeployed stack above the active deployment', () => {
	const result = checkForOrphanVersion(versions, {
		versions: [
			{ version_id: 'bcf9b83d-8666-4b40-8d46-6199a9bc1146', percentage: 100 },
		],
	})
	expect(result.status).toBe('orphan')
	if (result.status !== 'orphan') return
	expect(result.undeployed.map((record) => record.id)).toEqual([
		'3a6da96b-6da8-4393-b906-8ede58c99374',
	])
	const report = formatOrphanReport({
		workerName: 'kody-production',
		phase: 'preflight',
		result,
	})
	expect(report.annotation).toMatch(
		/^::error title=Undeployed Worker version \(kody-production\)::/,
	)
	expect(report.annotation).toContain('gh-39976970841-1')
	expect(report.summary).toContain('`3a6da96b-6da8-4393-b906-8ede58c99374`')
	expect(report.summary).toContain('2026-10-23T15:25:24Z')
})

test('author fields never reach the report', () => {
	const records = normalizeVersions(versions)
	expect(JSON.stringify(records)).not.toContain('example.com')
})
