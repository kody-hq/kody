import { mkdtemp, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from 'vitest'
import { reportStartupBundleOverages } from './startup-bundle-overage-report.ts'

test('overages become check annotations and a job summary table', async () => {
	const dir = await mkdtemp(path.join(tmpdir(), 'startup-overage-'))
	try {
		const summary = path.join(dir, 'summary.md')
		const logs: Array<string> = []
		reportStartupBundleOverages(
			[
				{
					name: 'platform',
					size: 7_645_542,
					maxEntryBytes: 6_790_000,
					overage: 855_542,
				},
			],
			{
				env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summary },
				log: (message) => logs.push(message),
			},
		)
		expect(logs).toEqual([
			'::warning title=Startup budget overage: platform::platform startup entry is 7_645_542 bytes, 855_542 over its 6_790_000-byte reviewed budget (warning only; does not fail CI).',
		])
		expect(await readFile(summary, 'utf8')).toContain(
			'| platform | 7_645_542 | 6_790_000 | 855_542 |',
		)
	} finally {
		await rm(dir, { recursive: true, force: true })
	}
})
