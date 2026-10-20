import { expect, test } from 'vitest'
import { buildSelfPublishBlockerDetail } from './self-publish-blocker-detail.ts'

test('blocker detail names storage matches with file and line and approval URL', () => {
	const detail = buildSelfPublishBlockerDetail({
		blocker: 'declares_capabilities',
		approvalUrl: 'https://kody.codes/@kent/deck/approve-capabilities',
		reasons: [
			{
				kind: 'storage_entry',
				storageId: 'pkg-1',
				via: ['deck'],
				matches: [
					{
						path: 'app/assets.generated.ts',
						line: 12,
						column: 4,
						pattern: 'packageStorage',
						snippet: 'packageStorage().get',
					},
				],
			},
		],
	})
	expect(detail.message).toContain('app/assets.generated.ts:12')
	expect(detail.message).toContain('packageStorage')
	expect(detail.message).toContain(
		'https://kody.codes/@kent/deck/approve-capabilities',
	)
	expect(detail.message.includes('\u2014')).toBe(false)
	expect(detail.message.includes('\u2013')).toBe(false)
})

test('manifest field reasons name jobs and webhooks', () => {
	const detail = buildSelfPublishBlockerDetail({
		blocker: 'declares_capabilities',
		reasons: [
			{ kind: 'manifest_field', field: 'jobs', sourceId: 'source-1' },
			{ kind: 'manifest_field', field: 'webhooks', sourceId: 'source-1' },
		],
	})
	expect(detail.message).toContain('kody.jobs')
	expect(detail.message).toContain('kody.webhooks')
})
