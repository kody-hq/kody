import { createElement } from 'react'
import { expect, test } from 'vitest'
import { ApprovalBundleRoute } from './pages/approval-bundle.tsx'
import { renderStartPage } from './test-support/render-start-page.ts'
import {
	type ApprovalBundleLoaderData,
	type ApprovalBundleView,
	type ApprovalItemView,
} from '#universal/approval-bundles.ts'

const item: ApprovalItemView = {
	key: 'publish:request-1',
	type: 'publish',
	title: 'Publish changed credentials',
	summary: 'Publish the reviewed changes.',
	package: {
		id: 'package-1',
		name: '@acme/tool',
		kodyId: 'tool',
		href: '/@acme/tool',
	},
	status: 'pending',
	statusMessage: null,
	canApprove: true,
	canDeny: true,
	fingerprint: 'reviewed-fingerprint',
	detailLabel: null,
	grants: [],
	reviewHref: '/@acme/tool/approve-publish',
	decision: null,
}
function render(payload: ApprovalBundleLoaderData) {
	return renderStartPage(
		createElement(ApprovalBundleRoute, {
			payload,
			orgSlug: 'acme',
			bundleId: 'bundle-1',
			queryKey: [
				'page',
				null,
				'loadApprovalBundle',
				{ orgSlug: 'acme', bundleId: 'bundle-1' },
			],
		}),
		'/@acme/-/approvals/bundle-1',
		null,
		undefined,
		{ mode: 'focused' },
	)
}
function data(items: ApprovalItemView[]): ApprovalBundleLoaderData {
	return {
		ok: true,
		view: {
			ok: true,
			bundle: {
				id: 'bundle-1',
				orgSlug: 'acme',
				createdAt: '2026-10-14',
				expiresAt: '2026-11-14',
				note: '<script>untrusted note</script>',
				createdVia: 'CLI',
			},
			groups: [{ package: item.package, items }],
		},
	}
}
test('bundle shows reviewed package decisions, bounded approve all, and untrusted note as text', async () => {
	const html = await render(
		data([
			item,
			{
				...item,
				key: 'credential-picks:request-2',
				type: 'credential-picks',
				title: 'Choose a credential',
				canApprove: false,
				canDeny: false,
				statusMessage: 'Choose a credential on its own approval page.',
			},
		]),
	)
	expect(html).toContain('2 changes wait for you')
	expect(html).toContain('Publish changed credentials')
	expect(html).toContain('Choose a credential on its own approval page.')
	expect(html).toContain('data-testid="approval-bundle-approve-all"')
	expect(html.match(/data-testid="approval-bundle-approve"/g)).toHaveLength(1)
	expect(html.match(/data-testid="approval-bundle-deny"/g)).toHaveLength(1)
	expect(html).toContain('&lt;script&gt;untrusted note&lt;/script&gt;')
	expect(html).not.toContain('<script>untrusted note</script>')
	expect(html).toContain('href="/@acme/tool/approve-publish"')
	expect(html).not.toContain('reviewed-fingerprint')
})
test('decided items cannot be resubmitted and expired links retain their clear status', async () => {
	const html = await render(
		data([
			{
				...item,
				status: 'approved',
				decision: { decision: 'approved', decidedAt: '2026-10-14' },
			},
		]),
	)
	expect(html).toContain('All 1 change is decided')
	expect(html).not.toContain('data-testid="approval-bundle-approve"')
	expect(html).not.toContain('data-testid="approval-bundle-deny"')
	expect(html).toMatch(
		/<button[^>]*data-testid="approval-bundle-approve-all"[^>]*disabled/,
	)
	const expired = await render({ ok: false, reason: 'expired' })
	expect(expired).toContain('This link expired')
	expect(expired).not.toContain('data-testid="approval-bundle-approve-all"')
})

const pausedCommit = 'e650a38bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
function credentialNeedsItem(
	overrides: Partial<ApprovalItemView> = {},
): ApprovalItemView {
	return {
		key: 'publish:req-1',
		type: 'publish',
		title: 'Publish with changed credential needs',
		summary:
			'Approving publishes this version, which asks for the credentials below. The previously published version keeps serving until you approve. Denying drops this paused publish.',
		package: {
			id: 'pkg-1',
			kodyId: 'nextdns',
			name: '@kentcdodds/nextdns',
			href: '/@kentcdodds/nextdns',
		},
		status: 'pending',
		statusMessage: null,
		canApprove: true,
		canDeny: true,
		fingerprint: pausedCommit,
		detailLabel: 'Paused commit',
		grants: [
			{
				change: 'added',
				label: 'NEXTDNS_API_KEY',
				where: null,
				kind: 'Key',
				provider: 'nextdns',
				hosts: ['api.nextdns.io'],
				before: null,
				after: 'Key from provider "nextdns"',
				match:
					'No credential of yours matches yet; runs fail until you add one.',
			},
		],
		reviewHref: '/@kentcdodds/nextdns/approve-capabilities',
		decision: null,
		...overrides,
	}
}

function bundleLoaderData(
	item: ApprovalItemView = credentialNeedsItem(),
): ApprovalBundleLoaderData {
	const view: ApprovalBundleView = {
		ok: true,
		bundle: {
			id: 'bundle-1',
			orgSlug: 'acme',
			createdAt: '2026-10-14T00:00:00.000Z',
			expiresAt: '2026-11-13T00:00:00.000Z',
			note: null,
			createdVia: 'CLI',
		},
		groups: [
			{
				package: item.package,
				items: [item],
			},
		],
	}
	return { ok: true, view }
}

test('a credential-needs-only bundle item states the credential change and hides the commit behind Details', async () => {
	const html = await render(bundleLoaderData())

	expect(html).toContain('1 change waits for you')
	expect(html).toContain('Publish with changed credential needs')
	expect(html).toContain(
		'Approving publishes this version, which asks for the credentials below.',
	)
	expect(html).toContain('NEXTDNS_API_KEY')
	expect(html).toContain('provider nextdns')
	expect(html).toContain('Credential values are never shown.')

	const item = html.slice(html.indexOf('data-testid="approval-bundle-item"'))
	const detailsIndex = item.indexOf(
		'data-testid="approval-bundle-item-details"',
	)
	expect(detailsIndex).toBeGreaterThan(-1)
	const beforeDetails = item.slice(0, detailsIndex)
	expect(beforeDetails).not.toContain(pausedCommit)
	expect(beforeDetails).not.toContain(pausedCommit.slice(0, 7))
	const details = item.slice(detailsIndex)
	expect(details).toContain(pausedCommit)
	expect(details).toContain('<summary>Details</summary>')
	expect(details.slice(0, details.indexOf('>'))).not.toContain(' open')
})

test('a went_public bundle item still mentions public internet visibility', async () => {
	const html = await render(
		bundleLoaderData(
			credentialNeedsItem({
				title: 'Serve on the public internet',
				detailLabel: 'Published commit',
				summary:
					'Serve this package on the public internet. Approving turns on internet-visible serving for this version. Denying leaves it off.',
				grants: [
					{
						change: 'added',
						label: 'Public internet',
						where: null,
						kind: null,
						provider: null,
						hosts: [],
						before: 'Not internet-visible',
						after: 'Anyone on the internet can reach this package’s app',
						match: null,
					},
				],
			}),
		),
	)

	expect(html).toContain('Serve on the public internet')
	expect(html).toContain('internet-visible serving')
	expect(html).toContain('Public internet')
	expect(html).toContain('Published commit')
	expect(html).not.toContain('Paused commit')
})

test('credential-picks Details label the approval fingerprint, not a proposal id', async () => {
	const html = await render(
		bundleLoaderData(
			credentialNeedsItem({
				key: 'credential-picks:prop-1',
				type: 'credential-picks',
				title: 'Choose credentials',
				summary: 'Approving saves these credential mappings.',
				fingerprint: 'fp-decision-abc',
				detailLabel: 'Approval fingerprint',
				grants: [],
			}),
		),
	)

	expect(html).toContain('Approval fingerprint')
	expect(html).toContain('fp-decision-abc')
	expect(html).not.toContain('Proposal id')
})
