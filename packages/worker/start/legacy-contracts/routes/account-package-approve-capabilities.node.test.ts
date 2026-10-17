import { jsx } from 'react/jsx-runtime'
import { renderStartPage as renderToString } from '../../test-support/render-start-page.ts'
import { expect, test } from 'vitest'
import { AccountPackageApproveCapabilitiesRoute } from '../../pages/account-package-approve-capabilities.tsx'
import { type AccountPackageApproveCapabilitiesLoaderData } from '#universal/loader-data.ts'
import { buildPackageSecurityAuditPrompt } from '#universal/package-security-audit-prompt.ts'

const approveHref = '/@kody/mau-chart/approve-capabilities'
const packageId = 'ae81fd4e-7c1b-4b8e-9d0a-6f2b1c3d4e5f'
const dependencyPackageId = '0f1e2d3c-4b5a-4968-8776-655443322110'
const credentialId = 'cred_7d3f9a21b4c8'
const publishedCommit = '34f338c19f91c698c3a28edd2992e0ab87dcb4e0'
const fingerprint =
	'9b2c4e6f8a1d3c5e7f9b2d4f6a8c1e3f5a7b9d2c4e6f8a1b3d5f7a9c2e4b6d8f'

function loaderData(
	overrides: Partial<AccountPackageApproveCapabilitiesLoaderData> = {},
): AccountPackageApproveCapabilitiesLoaderData {
	return {
		ok: true,
		pendingApprovals: [],
		goPublicRequestId: null,
		email: 'kody@example.com',
		package: {
			id: packageId,
			name: '@kody/mau-chart',
			kodyId: 'mau-chart',
			sourceId: 'source-1',
			hasApp: true,
			isInternetVisible: false,
		},
		publishedCommit,
		fingerprint,
		entries: [
			{
				kind: 'credential',
				credentialId,
				name: 'FATHOM_API_KEY',
				credentialKind: 'secret',
				hosts: ['api.usefathom.com'],
				placement: null,
				via: ['mau-chart'],
			},
			{
				kind: 'storage',
				storageId: packageId,
				hosts: [],
				via: ['mau-chart'],
			},
			{
				kind: 'storage',
				storageId: dependencyPackageId,
				hosts: [],
				via: ['mau-chart', 'chart-kit'],
			},
		],
		fingerprintMatchesApproval: false,
		latestApprovedAt: null,
		securityAudit: {
			status: 'not_audited',
			prompt: buildPackageSecurityAuditPrompt({
				packageName: '@kody/mau-chart',
				packageId,
				publishedCommit,
				fingerprint,
				approvalUrl: `https://kody.codes${approveHref}`,
			}),
		},
		settingsHref: '/@kody/mau-chart/settings',
		packageHref: '/@kody/mau-chart',
		approveHref,
		...overrides,
	}
}

async function render(data: AccountPackageApproveCapabilitiesLoaderData) {
	return renderToString(
		jsx(AccountPackageApproveCapabilitiesRoute, {
			payload: data,
			username: 'kody',
			kodyId: 'mau-chart',
		}),
		approveHref,
		null,
		undefined,
		{ mode: 'focused' },
	)
}

/** Visible page text: everything before Details, minus closed dialogs. */
function beforeDetails(html: string) {
	const index = html.indexOf(
		'data-testid="package-approve-capabilities-details"',
	)
	expect(index).toBeGreaterThan(-1)
	return withoutDialogs(html.slice(0, index))
}

function withoutDialogs(html: string) {
	return html.replace(/<dialog[\s\S]*?<\/dialog>/g, '')
}

function securityAuditField(html: string) {
	const start = html.indexOf('data-testid="package-security-audit"')
	expect(start).toBeGreaterThan(-1)
	return html.slice(start, html.indexOf('</section>', start))
}

test('capability approval leads with the package, credentials, and other capabilities in plain language', async () => {
	const html = await render(loaderData())

	expect(html).toContain('Approve internet-visible capabilities')
	expect(html).toContain('data-testid="package-approve-capabilities-package"')
	expect(html).toContain('@kody/mau-chart')
	// No workspace rail on the focused page.
	expect(html).not.toMatch(/<[a-z]+\s[^>]*data-account-nav[\s>=]/)
	expect(html).not.toContain('aria-label="Workspace sections"')

	expect(html).toContain('>Credentials<')
	expect(html).toContain('FATHOM_API_KEY')
	expect(html).toContain('Key · used by this package')
	expect(html).toContain('Can only be sent to api.usefathom.com')

	expect(html).toContain('>Other capabilities<')
	expect(html).toContain('>Package storage<')
	expect(html).toContain('This package can save and read its own data.')
	expect(html).toContain(
		'Its dependency chart-kit can save and read its own data.',
	)

	expect(html).toContain('Approve capability set')
	expect(html).toContain('data-testid="package-approve-capabilities-back"')
	expect(html).toContain('Back to package settings')
})

test('capability approval hides raw ids in a collapsed Details disclosure and drops the slug', async () => {
	const html = await render(loaderData())
	const main = beforeDetails(html)

	for (const id of [
		publishedCommit,
		fingerprint,
		credentialId,
		packageId,
		dependencyPackageId,
	]) {
		expect(main).not.toContain(id)
	}
	expect(html).not.toContain('>Slug<')
	expect(html).not.toContain('package slug')

	const details = html.slice(
		html.indexOf('data-testid="package-approve-capabilities-details"'),
	)
	// Collapsed by default.
	expect(details).toMatch(
		/^data-testid="package-approve-capabilities-details"[^>]*>/,
	)
	expect(details.slice(0, details.indexOf('>'))).not.toContain(' open')
	expect(details).toContain('<summary>Details</summary>')
	for (const id of [
		publishedCommit,
		fingerprint,
		credentialId,
		packageId,
		dependencyPackageId,
	]) {
		expect(details).toContain(id)
	}
	expect(details).toContain('aria-label="Copy published commit"')
	expect(details).toContain('aria-label="Copy fingerprint"')
	expect(details).toContain('aria-label="Copy FATHOM_API_KEY credential ID"')
	expect(details).toContain('aria-label="Copy Package storage ID"')
	expect(details).toContain('aria-label="Copy Package storage ID (chart-kit)"')
})

test('pending approvals keep their commit in a Details disclosure', async () => {
	const pendingCommit = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
	const html = await render(
		loaderData({
			pendingApprovals: [
				{
					id: 'req-1',
					reason: 'went_public',
					reasonLabel: 'Went internet-visible',
					pendingCommit,
					createdAt: '2026-10-14T00:00:00.000Z',
					changes: [],
					approveAction: 'approve-went-public',
				},
			],
		}),
	)

	expect(html).toContain('Waiting for your approval')
	expect(html).toContain('Approve and make internet-visible')
	const card = html.slice(
		html.indexOf('data-testid="package-pending-approval"'),
		html.indexOf('data-testid="package-pending-approval-approve"'),
	)
	const detailsIndex = card.indexOf('<summary>Details</summary>')
	expect(detailsIndex).toBeGreaterThan(-1)
	expect(card.slice(0, detailsIndex)).not.toContain(pendingCommit)
	expect(card.slice(detailsIndex)).toContain(pendingCommit)
})

test('capability approval does not claim a dependency-reached credential is dependency-only', async () => {
	const html = await render(
		loaderData({
			entries: [
				{
					kind: 'credential',
					credentialId,
					name: 'SLACK_WEBHOOK_URL',
					credentialKind: 'url',
					hosts: ['hooks.slack.com'],
					placement: null,
					via: ['mau-chart', 'slack-notify'],
				},
			],
		}),
	)

	expect(html).toContain('URL · reachable through its dependency slack-notify')
	expect(html).not.toContain('used by this package')
})

test('capability approval copy matches an already internet-visible package', async () => {
	const live = await render(
		loaderData({
			package: { ...loaderData().package, isInternetVisible: true },
		}),
	)
	expect(live).toContain(
		'@kody/mau-chart is served on the public internet. Check what it can use before you re-approve.',
	)
	expect(live).toContain(
		'It is internet-visible, so requests from anyone can run code that uses these.',
	)
	expect(live).toContain('Re-approve capability set')
	expect(live).toContain('Credential values never appear here.')
	expect(live).not.toContain('Secret values')
	expect(live).not.toContain('Before @kody/mau-chart is served')
	expect(live).not.toContain('Once it is internet-visible')

	const notLive = await render(loaderData())
	expect(notLive).toContain(
		'Before @kody/mau-chart is served on the public internet',
	)
	expect(notLive).toContain('Once it is internet-visible')
	expect(notLive).toContain('Credential values never appear here.')
	expect(notLive).not.toContain('Secret values')
})

test('a credential-needs-only approval states the change and never claims public visibility', async () => {
	const pendingCommit = 'e650a38aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
	const html = await render(
		loaderData({
			package: {
				...loaderData().package,
				name: '@kentcdodds/nextdns',
				kodyId: 'nextdns',
				hasApp: false,
				isInternetVisible: false,
			},
			pendingApprovals: [
				{
					id: 'req-cred-1',
					reason: 'credential_needs_changed',
					reasonLabel: 'Credential needs changed',
					pendingCommit,
					createdAt: '2026-10-14T00:00:00.000Z',
					changes: [
						'This version adds a credential need: NEXTDNS_API_KEY Key from nextdns',
					],
					approveAction: 'approve-credential-needs',
				},
			],
		}),
	)

	expect(html).toContain('Approve credential needs')
	expect(html).toContain(
		'This version adds a credential need: NEXTDNS_API_KEY Key from nextdns',
	)
	expect(html).toContain(
		'The previously published version keeps running until you approve.',
	)
	expect(html).toContain('Credential values never appear here.')
	expect(html).toContain('Approve and publish')
	expect(html).toContain('The previously published version can use these.')
	expect(html).not.toContain('Approve capability set')
	expect(html).not.toContain('data-testid="package-approve-capabilities"')

	expect(html).not.toContain('Approve internet-visible capabilities')
	expect(html).not.toContain('public internet')
	expect(html).not.toContain('internet-visible')
	expect(html).not.toContain('Once it is internet-visible')
	expect(html).not.toContain('Secret values')
	expect(html).not.toContain('Approve and make internet-visible')

	const card = html.slice(
		html.indexOf('data-testid="package-pending-approval"'),
		html.indexOf('data-testid="package-pending-approval-approve"'),
	)
	const detailsIndex = card.indexOf('<summary>Details</summary>')
	expect(detailsIndex).toBeGreaterThan(-1)
	expect(card.slice(0, detailsIndex)).not.toContain(pendingCommit)
	expect(card.slice(detailsIndex)).toContain(pendingCommit)
})

test('a went_public pending approval still mentions internet visibility', async () => {
	const html = await render(
		loaderData({
			pendingApprovals: [
				{
					id: 'req-1',
					reason: 'went_public',
					reasonLabel: 'Went internet-visible',
					pendingCommit: 'cccccccccccccccccccccccccccccccccccccccc',
					createdAt: '2026-10-14T00:00:00.000Z',
					changes: ['Serve this package on the public internet.'],
					approveAction: 'approve-went-public',
				},
			],
		}),
	)

	expect(html).toContain('Approve package changes')
	expect(html).toContain(
		'Approving turns on internet-visible serving for this package.',
	)
	expect(html).toContain(
		'Internet-visible serving stays off until you approve.',
	)
	expect(html).toContain('Approve and make internet-visible')
	expect(html).toContain('Once it is internet-visible')
	expect(html).toContain('Approve capability set')
})

test('credential-needs-only copy wins over an already internet-visible package', async () => {
	const html = await render(
		loaderData({
			package: {
				...loaderData().package,
				isInternetVisible: true,
			},
			fingerprintMatchesApproval: true,
			latestApprovedAt: '2026-10-16T04:36:41Z',
			pendingApprovals: [
				{
					id: 'req-cred-1',
					reason: 'credential_needs_changed',
					reasonLabel: 'Credential needs changed',
					pendingCommit: 'dddddddddddddddddddddddddddddddddddddddd',
					createdAt: '2026-10-14T00:00:00.000Z',
					changes: [
						'This version changes the credential need MAIL: was Key from resend, now OAuth from resend',
					],
					approveAction: 'approve-credential-needs',
				},
			],
		}),
	)

	expect(html).toContain('Approve credential needs')
	expect(html).toContain('The previously published version can use these.')
	expect(html).not.toContain('This capability set is already approved')
	expect(html).not.toContain('2026-10-16T04:36:41Z')
	expect(html).not.toContain(
		'It is internet-visible, so requests from anyone can run code that uses these.',
	)
	expect(html).not.toContain('Approve capability set')
	expect(html).not.toContain('Re-approve capability set')
	expect(html).not.toContain('public internet')
})

test('a package that declares nothing gets one plain empty state', async () => {
	const html = await render(loaderData({ entries: [] }))

	expect(html).toContain('data-testid="package-approve-capabilities-empty"')
	expect(html).toContain(
		'This package uses no credentials or other capabilities.',
	)
	expect(html).not.toContain('>Credentials<')
	expect(html).not.toContain('>Other capabilities<')
	expect(html).not.toContain('Package storage')
	expect(html).toContain('Approve capability set')
})

test('storage alone keeps the credentials section and says none are used', async () => {
	const html = await render(
		loaderData({
			entries: [
				{
					kind: 'storage',
					storageId: packageId,
					hosts: [],
					via: ['mau-chart'],
				},
			],
		}),
	)

	expect(html).toContain('This package does not use any of your credentials.')
	expect(html).toContain('>Package storage<')
	expect(html).not.toContain('data-testid="package-approve-capabilities-empty"')
})

test('an unpublished package shows neither the empty state nor sections', async () => {
	const html = await render(
		loaderData({
			entries: [],
			publishedCommit: null,
			securityAudit: { status: 'unpublished' },
		}),
	)

	expect(html).toContain('Publish this package before approving')
	expect(html).not.toContain('data-testid="package-approve-capabilities-empty"')
	expect(html).not.toContain('>Credentials<')
})

test('each credential says how this package reaches it', async () => {
	const credential = (
		id: string,
		extra: Partial<
			AccountPackageApproveCapabilitiesLoaderData['entries'][number]
		>,
	) => ({
		kind: 'credential' as const,
		credentialId: id,
		name: id,
		credentialKind: 'secret',
		hosts: ['api.example.com'],
		placement: null,
		via: ['mau-chart'],
		...extra,
	})
	const html = await render(
		loaderData({
			entries: [
				credential('need-cred', {
					source: 'need',
					needKey: 'github',
					credentialKind: 'oauth',
				}),
				credential('mount-cred', { source: 'mount' }),
				credential('grant-cred', { source: 'grant' }),
				credential('package-cred', { source: 'package' }),
			],
		}),
	)

	expect(html).toContain('fills its declared github credential')
	expect(html).toContain('Key · declared by this package')
	expect(html).toContain('Key · you granted this package access')
	expect(html).toContain('Key · saved for this package only')
	expect(html).not.toContain('used by this package')
})

test('a credential shared with app visitors says so in plain language', async () => {
	const roomsDb = {
		kind: 'credential' as const,
		credentialId,
		name: 'ROOMS_DB',
		credentialKind: 'secret',
		hosts: ['db.example.com'],
		placement: null,
		via: ['mau-chart'],
	}
	const html = await render(
		loaderData({
			entries: [
				{
					...roomsDb,
					source: 'need',
					needKey: 'database',
					ownerCredentialForVisitors: true,
				},
				{ ...roomsDb, source: 'grant' },
			],
		}),
	)
	const visible = beforeDetails(html)

	expect(visible).toContain(
		'data-testid="package-approve-capabilities-credential-visitors"',
	)
	expect(visible).toContain(
		'Visitors can use this credential through the app, whether they are signed out or signed in as someone else.',
	)
	expect(visible.match(/credential-visitors"/g)).toHaveLength(1)
	expect(visible).not.toContain(credentialId)
	expect(visible.toLowerCase()).not.toContain('secret')

	const singleEntry = await render(
		loaderData({ entries: [{ ...roomsDb, source: 'grant' }] }),
	)
	const idMentions = (page: string) => page.split(credentialId).length - 1
	expect(idMentions(singleEntry)).toBeGreaterThan(0)
	expect(idMentions(html)).toBe(idMentions(singleEntry))
})

test('credentials not shared with visitors carry no visitor note', async () => {
	const html = await render(loaderData())

	expect(html).not.toContain('credential-visitors')
	expect(html).not.toContain('Visitors can use this credential')
})

test('security audit reads "No security audit performed" and offers a copyable agent prompt', async () => {
	const html = await render(loaderData())
	const field = securityAuditField(html)

	expect(field).toContain('data-audit-status="not_audited"')
	expect(field).toContain('>Security audit<')
	expect(field).toContain('No security audit performed')
	expect(field).toContain('aria-haspopup="dialog"')
	expect(field).toContain('Ask your agent for a security audit')

	const prompt = field.slice(
		field.indexOf('data-testid="package-security-audit-prompt"'),
	)
	for (const value of [packageId, publishedCommit, fingerprint]) {
		expect(prompt).toContain(value)
	}
	expect(prompt).toContain('packageSecurityAuditRecord')
	expect(field).toContain('aria-label="Copy security audit prompt"')
	expect(withoutDialogs(field)).not.toContain(publishedCommit)

	// Informational only: Approve stays its own button.
	expect(html).toContain('data-testid="package-approve-capabilities"')
	expect(field).not.toContain('data-testid="package-approve-capabilities"')
})

test('security audit shows who audited when, with a link to the summary', async () => {
	const html = await render(
		loaderData({
			securityAudit: {
				status: 'audited',
				verdict: 'concerns',
				summary: 'FATHOM_API_KEY is only sent to api.usefathom.com.',
				auditor: 'Audit Agent',
				recordedBy: '@kody',
				recordedAt: '2026-10-14T15:30:00.000Z',
			},
		}),
	)
	const field = securityAuditField(html)

	expect(field).toContain('data-audit-status="audited"')
	expect(field.replace(/<[^>]*>/g, '')).toContain(
		'Audited 2026-10-14 by Audit Agent',
	)
	expect(field).toMatch(
		/<time dateTime="2026-10-14T15:30:00.000Z">2026-10-14<\/time>/,
	)
	expect(field).toContain('href="#security-audit"')
	expect(field).toContain('>Concerns<')
	expect(field).toContain('Security audit summary')
	expect(field).toContain('recorded by @kody')
	expect(field).toContain('FATHOM_API_KEY is only sent to api.usefathom.com.')
	expect(field).not.toContain('No security audit performed')
	expect(field).not.toContain(publishedCommit)
})

test('security audit asks for a publish before an unpublished package can be audited', async () => {
	const html = await render(
		loaderData({
			publishedCommit: null,
			securityAudit: { status: 'unpublished' },
		}),
	)
	const field = securityAuditField(html)

	expect(field).toContain(
		'No security audit performed. Publish this package to audit it.',
	)
	expect(field).not.toContain('<dialog')
})

test('security audit says it does not cover a paused publish waiting on the page', async () => {
	const paused = await render(
		loaderData({
			pendingApprovals: [
				{
					id: 'req-2',
					reason: 'credential_needs_changed',
					reasonLabel: 'Credential needs changed',
					pendingCommit: 'cccccccccccccccccccccccccccccccccccccccc',
					createdAt: '2026-10-14T00:00:00.000Z',
					changes: [],
					approveAction: 'approve-credential-needs',
				},
			],
		}),
	)
	expect(securityAuditField(paused)).toContain(
		'Covers the published version only, not the paused publish waiting',
	)

	expect(securityAuditField(await render(loaderData()))).not.toContain(
		'data-testid="package-security-audit-paused-note"',
	)
})

test('a go-public request folds into the capability Approve as one decision', async () => {
	const wentPublic = {
		id: 'req-went-public',
		reason: 'went_public' as const,
		reasonLabel: 'Went public',
		pendingCommit: publishedCommit,
		createdAt: '2026-10-14T00:00:00.000Z',
		changes: ['Serve this package on the public internet.'],
		approveAction: 'approve-went-public' as const,
	}
	const html = await render(
		loaderData({
			pendingApprovals: [wentPublic],
			goPublicRequestId: wentPublic.id,
		}),
	)

	expect(html).not.toContain('data-testid="package-pending-approvals"')
	expect(html).not.toContain('data-testid="package-pending-approval-approve"')
	expect(html).toContain(
		'Approving turns on internet-visible serving for this package.',
	)
	expect(html).toContain(
		'data-testid="package-approve-capabilities-go-public-note"',
	)
	expect(html).toContain(
		'One approval records this capability set and turns on internet-visible serving.',
	)

	const alreadyPinned = await render(
		loaderData({
			pendingApprovals: [wentPublic],
			goPublicRequestId: wentPublic.id,
			fingerprintMatchesApproval: true,
		}),
	)
	expect(alreadyPinned).toContain(
		'You asked to make this package internet-visible. Approving turns on internet-visible serving.',
	)
	expect(alreadyPinned).toContain('Approve and make internet-visible')
	expect(alreadyPinned).not.toContain(
		'One approval records this capability set and turns on internet-visible serving.',
	)
	const approve = html.slice(
		html.indexOf('data-testid="package-approve-capabilities"'),
		html.indexOf(
			'</button>',
			html.indexOf('data-testid="package-approve-capabilities"'),
		),
	)
	expect(approve).toContain('Approve and make internet-visible')
	expect(approve).toContain('aria-hidden="true"')
	expect(approve).toContain('Back to package settings')
	const back = html.slice(
		html.indexOf('data-testid="package-approve-capabilities-back"'),
		html.indexOf(
			'</a>',
			html.indexOf('data-testid="package-approve-capabilities-back"'),
		),
	)
	expect(back).toContain('Back to package settings')
	expect(back).toContain('aria-hidden="true"')
	expect(back).toContain('Approve and make internet-visible')
	expect(
		html.match(/data-testid="package-approve-capabilities"/g),
	).toHaveLength(1)

	const separate = await render(loaderData({ pendingApprovals: [wentPublic] }))
	expect(separate).toContain('data-testid="package-pending-approval-approve"')
	expect(separate).not.toContain(
		'data-testid="package-approve-capabilities-go-public-note"',
	)
	expect(separate).toContain('Approve capability set')
})
