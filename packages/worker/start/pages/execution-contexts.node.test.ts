import { expect, test } from 'vitest'
import {
	chainFixture,
	contextFixture,
	pageFixture,
	sharedBuildbox,
} from '../test-support/execution-contexts-fixtures.ts'
import { renderStartPage } from '../test-support/render-start-page.ts'
import { createElement } from 'react'
import type { ExecutionContextsPageData } from '#universal/execution-contexts.ts'
import { ExecutionContextsRoute } from './execution-contexts.tsx'
import {
	ContextOptInForm,
	RunCancelControl,
} from './execution-context-detail.tsx'
import { optInCopy } from '#universal/execution-context-trust-copy.ts'

function route(
	payload: ExecutionContextsPageData,
	selectedId: string | null,
	currentHref: string,
) {
	return createElement(ExecutionContextsRoute, {
		payload,
		selectedId,
		currentHref,
	})
}

const href = '/@jane/-/execution-contexts'

function text(html: string) {
	return html
		.replace(/<!-- -->/g, '')
		.replace(/<style[^>]*>[\s\S]*?<\/style>/g, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&#x27;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, '&')
		.replace(/\s+/g, ' ')
}

test('flag off shows the experiment callout, not a permission error', async () => {
	const html = await renderStartPage(
		route({ enabled: false, orgSlug: 'jane' }, null, href),
		href,
	)
	expect(html).toContain('data-testid="execution-contexts-flag-off"')
	expect(text(html)).toContain('Try execution contexts')
	expect(text(html)).not.toMatch(/permission|denied/i)
})

test('list shows chain, statuses, unutilized note and register card', async () => {
	const html = await renderStartPage(route(pageFixture(), null, href), href)
	const body = text(html)
	expect(body).toContain('Your fallback chain in @jane')
	expect(body).toContain('Kody cloud')
	expect(body).toContain('Not in any chain')
	expect(body).toContain('1st in your chain')
	expect(body).toContain('Shared with you, opt in to use')
	expect(body).toContain('buildbox (needs opt-in)')
	expect(body).toContain('kody connect --name my-machine')
	expect(body).toContain('run `kody login` again first')
	expect(html).toContain('href="/@jane/-/execution-contexts/ec_buildbox"')
})

test('chain rows have up/down buttons and a keyboard grab handle; cloud is not draggable', async () => {
	const html = await renderStartPage(
		route(
			pageFixture({
				chain: chainFixture([
					{ kind: 'context', id: 'ec_server', usable: true },
					{ kind: 'context', id: 'ec_laptop', usable: true },
					{ kind: 'cloud' },
				]),
			}),
			null,
			href,
		),
		href,
	)
	expect(html).toContain('aria-label="Move home-server down"')
	expect(html).toContain('aria-label="Reorder my-laptop, position 2 of 2"')
	expect(html).toMatch(/role="status"/)
	const cloud = html.slice(html.indexOf('data-testid="chain-cloud"'))
	expect(cloud.slice(0, cloud.indexOf('</li>'))).not.toContain('draggable')
})

test('unusable stored entries stay visible with their reason', async () => {
	const html = await renderStartPage(
		route(
			pageFixture({
				chain: chainFixture([
					{
						kind: 'context',
						id: 'ec_buildbox',
						usable: false,
						unusableReason: 'not_opted_in',
					},
					{ kind: 'cloud' },
				]),
			}),
			null,
			href,
		),
		href,
	)
	expect(text(html)).toContain('Not opted in, skipped')
	expect(html).toContain('aria-label="Remove buildbox from your chain"')
})

test('strict chain with nothing usable warns that runs will fail', async () => {
	const html = await renderStartPage(
		route(
			pageFixture({
				chain: { ...chainFixture([]), strict: true },
			}),
			null,
			href,
		),
		href,
	)
	expect(text(html)).toContain('your execute runs will fail')
	expect(text(html)).toContain('Add Kody cloud back')
})

function renderOptIn(chainFull: boolean) {
	return renderStartPage(
		createElement(ContextOptInForm, {
			copy: optInCopy({
				name: sharedBuildbox.name,
				operator: sharedBuildbox.operator.handle,
				grant: sharedBuildbox.grantSummary,
			}),
			chainFull,
			addToChain: false,
			onAddToChainChange: () => {},
			busy: false,
			error: null,
			onCancel: () => {},
			onConfirm: () => {},
		}),
		`${href}/ec_buildbox`,
	)
}

test('detail for a shared context offers opt-in and shows own-runs scope', async () => {
	const html = await renderStartPage(
		route(
			pageFixture({ selected: sharedBuildbox }),
			'ec_buildbox',
			`${href}/ec_buildbox`,
		),
		`${href}/ec_buildbox`,
	)
	const body = text(html)
	expect(html).toContain('data-testid="execution-context-detail"')
	expect(html).toContain('data-testid="context-opt-in"')
	expect(body).toContain('Runs')
	expect(body).toContain('Audit log')
})

test('the opt-in dialog shows trust copy and an unchecked chain checkbox', async () => {
	const html = await renderOptIn(false)
	const body = text(html)
	expect(body).toContain('@sam can see the code, inputs, logs and results')
	expect(body).toContain('Local network access is on')
	expect(body).toContain('Add it to the end of my fallback chain')
	expect(html).toMatch(/type="checkbox"(?![^>]*checked)/)
})

test('opt-in checkbox is disabled when the chain is full', async () => {
	const html = await renderOptIn(true)
	expect(html).toMatch(/type="checkbox"[^>]*disabled/)
	expect(text(html)).toContain(
		'Your chain is full, so this context will not be added to it.',
	)
})

test('operator detail shows sharing with levels and no invite links note', async () => {
	const mine = contextFixture()
	const html = await renderStartPage(
		route(pageFixture({ selected: mine }), mine.id, `${href}/${mine.id}`),
		`${href}/${mine.id}`,
	)
	const body = text(html)
	expect(html).toContain('data-testid="context-sharing"')
	expect(body).toContain('Only me')
	expect(body).toContain('Everyone in @jane')
	expect(body).toContain('Not in any chain')
	expect(body).not.toContain('Opt into')
})

test('attached-org detail labels everyone with the current org, keeps Owned by', async () => {
	const vault = contextFixture({
		id: 'ec_vault',
		name: 'family-vault',
		ownerOrg: { id: 'org_kent', slug: 'kentcdodds' },
		operator: { handle: 'kentcdodds' },
		isOperator: true,
		canAddShares: true,
		grantSummary: {
			fs: 1,
			fsMode: 'read',
			egress: { mode: 'public' },
			runtime: 'all',
			timeoutMs: 90_000,
		},
		sharing: {
			level: 'org',
			grants: [],
			// Viewer @kody: loadSharing remaps allMembers to this attachment.
			attachedOrgs: [{ id: 'org_kody', slug: 'kody', allMembers: true }],
			allMembers: true,
			accessRoster: {
				orgSlug: 'kody',
				operator: {
					handle: 'kentcdodds',
					execute: true,
					manage: true,
					commands: true,
				},
				people: [
					{
						handle: 'tannerlinsley',
						source: 'all_members',
						preset: 'use',
						execute: true,
						manage: false,
						commands: false,
					},
				],
				teams: [],
				noAccess: [],
			},
		},
	})
	const pageHref = `/@kody/-/execution-contexts/${vault.id}`
	const html = await renderStartPage(
		route(
			pageFixture({
				orgSlug: 'kody',
				personalOrg: false,
				contexts: [vault],
				selected: vault,
				unutilized: { count: 0, contexts: [], note: '' },
			}),
			vault.id,
			pageHref,
		),
		pageHref,
	)
	const body = text(html)
	expect(html).toContain('data-testid="context-sharing"')
	expect(html).toContain('data-testid="context-access-roster"')
	expect(body).toContain('Owned by @kentcdodds')
	// Viewer org labels for allMembers; owner org stays on Owned by only.
	expect(body).toMatch(/Shared with\s+Everyone in @kody(?:\s|$)/)
	expect(body).toMatch(/Everyone in @kody,\s+Use: run code here/)
	expect(html).toContain('Everyone in @<!-- -->kody')
	expect(body).toContain('Who has access in @kody')
	expect(body).toContain(
		'Machine operator @kentcdodds — execute, manage, commands',
	)
	expect(body).toContain('@tannerlinsley — everyone in @kody — execute')
	expect(body).toContain(
		'files: none (machine has 1 path, read for operator runs only)',
	)
	expect(body).toContain(
		"Host folders are for the operator's own runs only. Shared runs do not mount them.",
	)
})

test('attached only_me roster matches kents-jaguar: operator access, member no access', async () => {
	const jaguar = contextFixture({
		id: 'ec_202t084t571i573k150y',
		name: 'kents-jaguar',
		ownerOrg: { id: 'org_kent', slug: 'kentcdodds' },
		operator: { handle: 'kentcdodds' },
		isOperator: true,
		canAddShares: true,
		myPermissions: [
			'read',
			'execute',
			'command',
			'write',
			'delete',
			'manage_access',
		],
		grantSummary: {
			fs: 1,
			egress: { mode: 'public' },
			runtime: 'all',
			timeoutMs: 90_000,
			commands: true,
		},
		sharing: {
			level: 'only_me',
			grants: [],
			attachedOrgs: [{ id: 'org_kody', slug: 'kody', allMembers: false }],
			allMembers: false,
			accessRoster: {
				orgSlug: 'kody',
				operator: {
					handle: 'kentcdodds',
					execute: true,
					manage: true,
					commands: true,
				},
				people: [],
				teams: [],
				noAccess: [{ handle: 'tannerlinsley' }],
			},
		},
	})
	const pageHref = `/@kody/-/execution-contexts/${jaguar.id}`
	const html = await renderStartPage(
		route(
			pageFixture({
				orgSlug: 'kody',
				personalOrg: false,
				contexts: [jaguar],
				selected: jaguar,
				unutilized: { count: 0, contexts: [], note: '' },
			}),
			jaguar.id,
			pageHref,
		),
		pageHref,
	)
	const body = text(html)
	expect(html).toContain('data-testid="context-access-roster"')
	expect(body).toContain('Owned by @kentcdodds')
	expect(body).toContain('Only me')
	expect(body).toContain('Who has access in @kody')
	expect(body).toContain(
		'Machine operator @kentcdodds — execute, manage, commands',
	)
	expect(body).toContain('Members without access in @kody')
	expect(body).toContain('@tannerlinsley')
	expect(body).not.toMatch(/Everyone in @kentcdodds,\s+Use/)
})

test('personal allMembers roster keeps operator separate without inventing other orgs', async () => {
	const personal = contextFixture({
		id: 'ec_jaguar_personal',
		name: 'kents-jaguar',
		ownerOrg: { id: 'org_kent', slug: 'kentcdodds' },
		operator: { handle: 'kentcdodds' },
		isOperator: true,
		canAddShares: true,
		sharing: {
			level: 'org',
			grants: [],
			attachedOrgs: [{ id: 'org_kody', slug: 'kody', allMembers: false }],
			allMembers: true,
			accessRoster: {
				orgSlug: 'kentcdodds',
				operator: {
					handle: 'kentcdodds',
					execute: true,
					manage: true,
					commands: true,
				},
				people: [],
				teams: [],
				noAccess: [],
			},
		},
	})
	const pageHref = `/@kentcdodds/-/execution-contexts/${personal.id}`
	const html = await renderStartPage(
		route(
			pageFixture({
				orgSlug: 'kentcdodds',
				personalOrg: true,
				contexts: [personal],
				selected: personal,
				unutilized: { count: 0, contexts: [], note: '' },
			}),
			personal.id,
			pageHref,
		),
		pageHref,
	)
	const body = text(html)
	expect(body).toContain('Who has access in @kentcdodds')
	expect(body).toContain(
		'Machine operator @kentcdodds — execute, manage, commands',
	)
	expect(body).toContain('Everyone in @kentcdodds')
	expect(body).toContain('no other members')
})

test('a missing context id shows a not-found message, not a crash', async () => {
	const html = await renderStartPage(
		route(pageFixture(), 'ec_gone', `${href}/ec_gone`),
		`${href}/ec_gone`,
	)
	expect(text(html)).toContain('does not exist or is not visible to you')
})

test('operator detail shows daemon version, outdated flag and background service', async () => {
	const outdated = contextFixture({
		client: {
			name: 'kody-cli',
			version: '1.40.0',
			latestVersion: '1.52.0',
			outdated: true,
		},
		capabilities: { os: 'linux', features: [], service: 'systemd' },
	})
	const html = await renderStartPage(
		route(
			pageFixture({ selected: outdated }),
			'ec_laptop',
			`${href}/ec_laptop`,
		),
		`${href}/ec_laptop`,
	)
	const body = text(html)
	expect(body).toContain('kody-cli 1.40.0')
	expect(body).toContain(
		'Outdated: 1.52.0 is out. Run kody update on the machine',
	)
	expect(body).toContain('Background service (systemd)')
	expect(body).not.toContain('kody daemon install --context')
	expect(body).toContain('Not reported')
	expect(body).toContain('This daemon predates auto-update')

	for (const [autoUpdate, shown, hint] of [
		['on', 'On', 'kody daemon auto-update off'],
		['off', 'Off', 'kody daemon auto-update on'],
	] as const) {
		const page = text(
			await renderStartPage(
				route(
					pageFixture({
						selected: contextFixture({
							capabilities: {
								os: 'darwin',
								features: [],
								service: 'launchd',
								autoUpdate,
							},
						}),
					}),
					'ec_laptop',
					`${href}/ec_laptop`,
				),
				`${href}/ec_laptop`,
			),
		)
		expect(page).toContain(`Auto-update ${shown}`)
		expect(page).toContain(hint)
	}

	const foreground = contextFixture({
		capabilities: { os: 'darwin', features: [], service: null },
	})
	const plain = text(
		await renderStartPage(
			route(
				pageFixture({ selected: foreground }),
				'ec_laptop',
				`${href}/ec_laptop`,
			),
			`${href}/ec_laptop`,
		),
	)
	expect(plain).toContain('Terminal (not a background service)')
	expect(plain).toContain(
		'wait for in-flight runs to finish, stop the terminal daemon (Ctrl+C), then run: kody daemon install --context ec_laptop',
	)
	expect(plain).not.toContain('Outdated')

	const offline = contextFixture({
		status: 'offline',
		capabilities: { os: 'win32', features: [], service: null },
	})
	const idle = text(
		await renderStartPage(
			route(
				pageFixture({ selected: offline }),
				'ec_laptop',
				`${href}/ec_laptop`,
			),
			`${href}/ec_laptop`,
		),
	)
	expect(idle).toContain('Not running')
	expect(idle).not.toContain('Terminal (not a background service)')
	expect(idle).toContain(
		'Run kody daemon install --context ec_laptop to keep it running',
	)

	const scheduled = contextFixture({
		capabilities: { os: 'win32', features: [], service: 'taskscheduler' },
	})
	const windows = text(
		await renderStartPage(
			route(
				pageFixture({ selected: scheduled }),
				'ec_laptop',
				`${href}/ec_laptop`,
			),
			`${href}/ec_laptop`,
		),
	)
	expect(windows).toContain('Background service (Task Scheduler)')
})

test('an in-progress run offers Cancel, then asks before it stops the run', async () => {
	const props = {
		runId: 'run_1',
		onAsk: () => {},
		onConfirm: () => {},
		onKeep: () => {},
	}
	const idle = await renderStartPage(
		createElement(RunCancelControl, {
			...props,
			cancelling: false,
			confirming: false,
		}),
	)
	expect(idle).toContain('aria-label="Cancel run run_1"')
	expect(text(idle)).toContain('Cancel')
	const confirming = text(
		await renderStartPage(
			createElement(RunCancelControl, {
				...props,
				cancelling: false,
				confirming: true,
			}),
		),
	)
	expect(confirming).toContain('Stop run')
	expect(confirming).toContain('Keep running')
	expect(
		text(
			await renderStartPage(
				createElement(RunCancelControl, {
					...props,
					cancelling: true,
					confirming: false,
				}),
			),
		),
	).toContain('Cancelling…')
})

const machineAccessFixture = {
	canGrant: true,
	profiles: [{ id: 'prof_ci', name: 'ci-bot' }],
	capabilities: [
		{
			id: 'mc_kdocker',
			kind: 'command' as const,
			name: 'kdocker',
			description: 'Restart a container',
			shareable: true,
			grants: [
				{ grantId: 'g_sam', subject: { kind: 'user' as const, handle: 'sam' } },
				{ grantId: 'g_all', subject: { kind: 'everyone' as const } },
			],
		},
		{
			id: 'mc_nas',
			kind: 'lan' as const,
			name: 'nas-api',
			description: null,
			shareable: true,
			grants: [],
		},
		{
			id: 'mc_folder',
			kind: 'fs' as const,
			name: 'kody-runner',
			description: null,
			shareable: false,
			grants: [],
		},
	],
}

test('operator detail lists machine access with who holds each entry', async () => {
	const mine = contextFixture({ machineAccess: machineAccessFixture })
	const html = await renderStartPage(
		route(pageFixture({ selected: mine }), mine.id, `${href}/${mine.id}`),
		`${href}/${mine.id}`,
	)
	const body = text(html)
	expect(html).toContain('data-testid="context-machine-access"')
	expect(body).toContain('Named commands')
	expect(body).toContain('kdocker')
	expect(body).toContain('Restart a container')
	expect(body).toContain('@sam')
	expect(body).toContain('Everyone in @jane')
	expect(body).toContain('Local network destinations')
	expect(body).toContain('Only the operator')
	expect(body).toContain('Host folders')
	expect(body).toContain('never shared')
	expect(body).toContain('One of my profiles')
	// Two shareable entries get a form; the host folder does not.
	expect(body.match(/Give access/g)).toHaveLength(2)
})

test('operator detail says how to define machine access when there is none', async () => {
	const mine = contextFixture({
		machineAccess: { canGrant: true, profiles: [], capabilities: [] },
	})
	const html = await renderStartPage(
		route(pageFixture({ selected: mine }), mine.id, `${href}/${mine.id}`),
		`${href}/${mine.id}`,
	)
	expect(html).toContain('data-testid="context-machine-access-empty"')
	expect(text(html)).toContain('kody context capability add')
})

test('someone the machine is shared with sees only what their profiles hold', async () => {
	const withGrant = {
		...sharedBuildbox,
		machineAccess: {
			canGrant: false,
			profiles: [{ id: 'prof_ci', name: 'ci-bot' }],
			capabilities: [
				{
					id: 'mc_kdocker',
					kind: 'command' as const,
					name: 'kdocker',
					description: null,
					shareable: true,
					grants: [
						{
							grantId: 'g_prof',
							subject: {
								kind: 'profile' as const,
								id: 'prof_ci',
								name: 'ci-bot',
							},
						},
					],
				},
			],
		},
	}
	const html = await renderStartPage(
		route(
			pageFixture({ selected: withGrant }),
			withGrant.id,
			`${href}/${withGrant.id}`,
		),
		`${href}/${withGrant.id}`,
	)
	const body = text(html)
	expect(body).toContain('What your profiles can use on buildbox')
	expect(body).toContain('Profile ci-bot')
	expect(body).toContain('One of my profiles')
	expect(body).not.toContain('A person')

	const without = {
		...sharedBuildbox,
		machineAccess: { canGrant: false, profiles: [], capabilities: [] },
	}
	const none = await renderStartPage(
		route(
			pageFixture({ selected: without }),
			without.id,
			`${href}/${without.id}`,
		),
		`${href}/${without.id}`,
	)
	expect(none).not.toContain('data-testid="context-machine-access"')
})
