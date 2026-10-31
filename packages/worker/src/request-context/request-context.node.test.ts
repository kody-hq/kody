import { expect, test } from 'vitest'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	createMcpCallerContext,
	parseMcpCallerContext,
	parseMcpCallerContextWire,
	toMcpCallerContextWire,
} from '#mcp/context.ts'
import {
	deriveRequestContext,
	inheritRequest,
	parseRequestLineage,
	requestLineage,
} from './request-context.ts'

const stableId = 'a'.repeat(64)
const user: McpUserContext = {
	userId: personIdFromStored(stableId),
	email: 'ada@example.com',
	username: 'ada',
	displayName: 'Ada',
}

test('orgBinding overrides implicit personalOrgId slug from username', () => {
	const request = deriveRequestContext({
		user,
		source: { kind: 'session' },
		orgBinding: {
			org: { id: ownerIdFromStored(stableId), slug: 'legacy-slug' },
			role: 'owner',
		},
	})
	expect(request.org).toEqual({ id: stableId, slug: 'legacy-slug' })
})

test('interactive sources act as the person, as Owner of their own org', () => {
	const session = deriveRequestContext({ user, source: { kind: 'session' } })
	expect(session).toEqual({
		org: { id: stableId, slug: 'ada' },
		actor: { userId: stableId, username: 'ada' },
		attribution: { kind: 'user', userId: stableId },
		credential: {
			kind: 'session',
			id: null,
			orgId: stableId,
			scopes: null,
			profileName: null,
		},
		membership: { role: 'owner' },
	})

	const token = deriveRequestContext({
		user,
		source: { kind: 'api-token', tokenId: 'tok_1' },
		profileName: 'work',
		scopes: ['org:execute', 'org:read'],
	})
	expect(token.credential).toEqual({
		kind: 'api-token',
		id: 'tok_1',
		orgId: stableId,
		scopes: ['org:execute', 'org:read'],
		profileName: 'work',
	})
	expect(token.actor).toEqual(session.actor)
})

test('automation sources have no actor and no membership', () => {
	const cases = [
		[{ kind: 'schedule', jobId: 'job-1' }, 'schedule', 'schedule'],
		[{ kind: 'webhook', sourceId: 'wh-1' }, 'webhook', 'webhook'],
		[
			{
				kind: 'inbound-email',
				sourceId: 'inbox-1',
				sender: { kind: 'inbox-owner' },
			},
			'email',
			'inbound-email',
		],
		[{ kind: 'platform-event', sourceId: 'repo' }, 'event', 'platform-event'],
	] as const
	for (const [source, automationSource, credentialKind] of cases) {
		const request = deriveRequestContext({ user, source })
		expect(request.org.id).toBe(stableId)
		expect(request.actor).toBeNull()
		expect(request.membership).toBeNull()
		expect(request.attribution).toEqual({
			kind: 'automation',
			source: automationSource,
			sourceId: 'jobId' in source ? source.jobId : source.sourceId,
		})
		expect(request.credential.kind).toBe(credentialKind)
	}
})

test('inherited runs keep the starter lineage and re-resolve the org', () => {
	const starter = deriveRequestContext({
		user,
		source: { kind: 'api-token', tokenId: 'tok_1' },
	})
	const nested = deriveRequestContext({
		user,
		source: inheritRequest(starter),
	})
	expect(nested).toEqual(starter)

	const automation = deriveRequestContext({
		user,
		source: { kind: 'webhook', sourceId: 'wh-1' },
	})
	const emitted = deriveRequestContext({
		user,
		source: inheritRequest(automation),
	})
	expect(emitted.actor).toBeNull()
	expect(emitted.membership).toBeNull()
	expect(emitted.attribution).toEqual(automation.attribution)
})

test('a verified member sender is the actor of an inbound email run, still billed as Automation', () => {
	const memberId = personIdFromStored('b'.repeat(64))
	const request = deriveRequestContext({
		user,
		source: {
			kind: 'inbound-email',
			sourceId: 'inbox-1',
			sender: {
				kind: 'member',
				actor: { userId: memberId, username: 'bea' },
				role: 'member',
			},
		},
	})
	expect(request).toEqual({
		org: { id: stableId, slug: 'ada' },
		actor: { userId: memberId, username: 'bea' },
		attribution: { kind: 'automation', source: 'email', sourceId: 'inbox-1' },
		credential: {
			kind: 'inbound-email',
			id: 'inbox-1',
			orgId: stableId,
			scopes: null,
			profileName: null,
		},
		membership: { role: 'member' },
	})
})

test('downstream runs keep the starter role instead of the org identity Owner role', () => {
	// A Member of the org `user` owns starts a run; downstream runs execute as
	// `user`, the org's own identity, whose role is Owner.
	const memberRun = deriveRequestContext({
		user: { userId: personIdFromStored('b'.repeat(64)), username: 'bea' },
		source: { kind: 'mcp-oauth' },
		orgBinding: {
			org: { id: ownerIdFromStored(stableId), slug: 'ada' },
			role: 'member',
		},
	})
	const lineage = JSON.parse(
		JSON.stringify(requestLineage(memberRun)),
	) as unknown
	const parsed = parseRequestLineage(lineage)
	expect(parsed?.membership).toEqual({ role: 'member' })
	const emitted = deriveRequestContext({
		user,
		source: { kind: 'inherited', lineage: parsed! },
	})
	expect(emitted.actor).toEqual(memberRun.actor)
	expect(emitted.membership).toEqual({ role: 'member' })

	// The role was held in the starter's org only.
	const otherOrg = deriveRequestContext({
		user: { userId: personIdFromStored('c'.repeat(64)), username: 'cy' },
		source: { kind: 'inherited', lineage: parsed! },
	})
	expect(otherOrg.membership).toBeNull()

	// Lineage persisted before it carried membership never takes the org
	// identity's Owner role for someone else.
	const { membership: _membership, ...legacy } = parsed!
	expect(
		deriveRequestContext({
			user,
			source: { kind: 'inherited', lineage: parseRequestLineage(legacy)! },
		}).membership,
	).toBeNull()

	// A personal org's owner still runs as Owner from legacy lineage.
	const ownerRun = deriveRequestContext({ user, source: { kind: 'mcp-oauth' } })
	const { membership: _ownerMembership, ...legacyOwner } = JSON.parse(
		JSON.stringify(requestLineage(ownerRun)),
	) as Record<string, unknown>
	expect(
		deriveRequestContext({
			user,
			source: {
				kind: 'inherited',
				lineage: parseRequestLineage(legacyOwner)!,
			},
		}).membership,
	).toEqual({ role: 'owner' })
	expect(
		parseRequestLineage({ ...legacy, membership: { role: 'admin' } }),
	).toBeNull()
})

test('every source keeps the connection profile it was reached through', () => {
	const job = deriveRequestContext({
		user,
		source: { kind: 'schedule', jobId: 'job-1' },
		profileName: '  work  ',
	})
	expect(job.credential.profileName).toBe('work')
	expect(
		deriveRequestContext({
			user,
			source: { kind: 'session' },
			profileName: ' ',
		}).credential.profileName,
	).toBeNull()

	// A run started by a profile-bound credential keeps that profile; a run
	// whose starter had none keeps the profile persisted with the job.
	const starter = deriveRequestContext({
		user,
		source: { kind: 'api-token', tokenId: 'tok_1' },
		profileName: 'starter',
	})
	expect(
		deriveRequestContext({
			user,
			source: inheritRequest(starter),
			profileName: 'work',
		}).credential.profileName,
	).toBe('starter')
	const unprofiled = deriveRequestContext({
		user,
		source: { kind: 'session' },
	})
	expect(
		deriveRequestContext({
			user,
			source: inheritRequest(unprofiled),
			profileName: 'work',
		}).credential.profileName,
	).toBe('work')
})

test('lineage survives a JSON round trip and malformed lineage is rejected', () => {
	const lineage = requestLineage(
		deriveRequestContext({ user, source: { kind: 'mcp-oauth' } }),
	)
	expect(parseRequestLineage(JSON.parse(JSON.stringify(lineage)))).toEqual(
		lineage,
	)
	const automation = requestLineage(
		deriveRequestContext({ user, source: { kind: 'schedule', jobId: 'j' } }),
	)
	expect(parseRequestLineage(JSON.parse(JSON.stringify(automation)))).toEqual(
		automation,
	)

	expect(parseRequestLineage(undefined)).toBeNull()
	expect(
		parseRequestLineage({
			...lineage,
			credential: { ...lineage.credential, kind: 'site-admin' },
		}),
	).toBeNull()
	expect(
		parseRequestLineage({
			...lineage,
			credential: { ...lineage.credential, scopes: ['package:root'] },
		}),
	).toBeNull()
	expect(
		parseRequestLineage({
			...lineage,
			attribution: { kind: 'automation', source: 'cron', sourceId: 'x' },
		}),
	).toBeNull()
})

test('the request context is derived, never part of the persisted caller context', () => {
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://kody.example',
		user,
		source: { kind: 'mcp-oauth' },
	})
	expect(callerContext.request?.credential.kind).toBe('mcp-oauth')
	const wire = toMcpCallerContextWire(callerContext)
	expect(wire).not.toHaveProperty('request')
	expect(parseMcpCallerContextWire(JSON.parse(JSON.stringify(wire)))).toEqual(
		wire,
	)

	expect(
		createMcpCallerContext({
			baseUrl: 'https://kody.example',
			source: { kind: 'mcp-oauth' },
		}).request,
	).toBeNull()
})

test('orgBinding round-trips on the wire so the org slug survives a user rename', () => {
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://kody.example',
		user,
		source: { kind: 'session' },
		orgBinding: {
			org: { id: ownerIdFromStored(stableId), slug: 'legacy-slug' },
			role: 'member',
		},
	})
	expect(callerContext.request?.org.slug).toBe('legacy-slug')
	const wire = toMcpCallerContextWire(callerContext)
	expect(wire.orgBinding).toEqual({
		org: { id: stableId, slug: 'legacy-slug' },
		role: 'member',
	})

	const serialized = JSON.parse(JSON.stringify(wire)) as {
		user: { username: string }
	}
	serialized.user.username = 'ada-renamed'
	const rederived = parseMcpCallerContext(serialized, { kind: 'session' })
	expect(rederived.user?.username).toBe('ada-renamed')
	expect(rederived.request?.org).toEqual({
		id: stableId,
		slug: 'legacy-slug',
	})
	expect(rederived.request?.membership).toEqual({ role: 'member' })
})

test('OAuth and CLI bearer grants carry their client id as the credential id', () => {
	const clientId = 'https://kody.example/oauth/cli-client-metadata.json'
	const cli = createMcpCallerContext({
		baseUrl: 'https://kody.example',
		user,
		source: { kind: 'cli' },
		oauthClientId: clientId,
	})
	expect(cli.request?.credential).toMatchObject({ kind: 'cli', id: clientId })

	const wire = toMcpCallerContextWire(
		createMcpCallerContext({
			baseUrl: 'https://kody.example',
			user,
			source: { kind: 'mcp-oauth' },
			oauthClientId: ' slack-bot ',
		}),
	)
	expect(wire.oauthClientId).toBe('slack-bot')
	const reparsed = parseMcpCallerContext(wire, { kind: 'mcp-oauth' })
	expect(reparsed.request?.credential).toMatchObject({
		kind: 'mcp-oauth',
		id: 'slack-bot',
	})

	const nested = deriveRequestContext({
		user,
		source: inheritRequest(reparsed.request!),
	})
	expect(nested.credential).toMatchObject({
		kind: 'mcp-oauth',
		id: 'slack-bot',
	})

	const session = createMcpCallerContext({
		baseUrl: 'https://kody.example',
		user,
		source: { kind: 'session' },
		oauthClientId: 'ignored',
	})
	expect(session.request?.credential.id).toBeNull()
	expect(
		toMcpCallerContextWire(
			createMcpCallerContext({
				baseUrl: 'https://kody.example',
				user,
				source: { kind: 'session' },
			}),
		),
	).not.toHaveProperty('oauthClientId')
})

test('a triggered run never exceeds the credential that turned it on', () => {
	const enablerId = personIdFromStored('c'.repeat(64))
	const enablement = {
		id: 'enablement-1',
		enabler: { userId: enablerId, username: 'cy' },
		role: 'member' as const,
		scopes: ['package:execute' as const],
		profileName: 'work',
	}
	for (const source of [
		{ kind: 'schedule', jobId: 'job-1', enablement },
		{ kind: 'webhook', sourceId: 'hook-1', enablement },
		{ kind: 'platform-event', sourceId: 'event-1', enablement },
		{
			kind: 'inbound-email',
			sourceId: 'inbox-1',
			sender: { kind: 'inbox-owner' },
			enablement,
		},
	] as const) {
		const request = deriveRequestContext({ user, source })
		expect(request.actor).toEqual({ userId: enablerId, username: 'cy' })
		expect(request.credential).toMatchObject({
			id: 'enablement-1',
			scopes: ['package:execute'],
			profileName: 'work',
		})
	}
	const unnarrowed = deriveRequestContext({
		user,
		source: {
			kind: 'schedule',
			jobId: 'job-1',
			enablement: { ...enablement, scopes: null, profileName: null },
		},
	})
	expect(unnarrowed.credential).toMatchObject({
		scopes: null,
		profileName: null,
	})
})

test('context-run lineage keeps operator access and narrowing across a durable boundary', () => {
	const operatorRun = deriveRequestContext({
		user,
		source: { kind: 'execution-context-run', ecid: 'ec_1', runId: 'run_1' },
		contextRunByOperator: true,
	})
	const operator = parseRequestLineage(
		JSON.parse(JSON.stringify(requestLineage(operatorRun))),
	)
	expect(operator?.credential).toMatchObject({
		kind: 'execution-context-run',
		contextRunByOperator: true,
	})
	expect(operator?.credential.contextCredentialIds).toBeUndefined()

	const sharedRun = deriveRequestContext({
		user,
		source: { kind: 'execution-context-run', ecid: 'ec_1', runId: 'run_2' },
		contextCredentialIds: [],
	})
	const shared = parseRequestLineage(
		JSON.parse(JSON.stringify(requestLineage(sharedRun))),
	)
	expect(shared?.credential.contextRunByOperator).toBeUndefined()
	expect(shared?.credential.contextCredentialIds).toEqual([])

	// A forged operator flag never drops narrowing someone else's run carries.
	const forged = parseRequestLineage({
		...JSON.parse(JSON.stringify(requestLineage(sharedRun))),
		credential: {
			...sharedRun.credential,
			contextRunByOperator: true,
		},
	})
	expect(forged?.credential.contextCredentialIds).toEqual([])
})

test('profile binding and its frozen chain survive a lineage round trip', () => {
	const lineage = requestLineage(
		deriveRequestContext({
			user,
			source: { kind: 'api-token', tokenId: 'tok_1' },
			profileId: 'prf_child',
			profileChain: ['prf_root', 'prf_child'],
		}),
	)
	const parsed = parseRequestLineage(JSON.parse(JSON.stringify(lineage)))
	expect(parsed?.credential.profileId).toBe('prf_child')
	expect(parsed?.credential.profileChain).toEqual(['prf_root', 'prf_child'])
	expect(
		parseRequestLineage({
			...lineage,
			credential: { ...lineage.credential, profileChain: ['prf_other'] },
		})?.credential,
	).toMatchObject({ profileId: 'prf_child' })
	expect(
		parseRequestLineage({
			...lineage,
			credential: { ...lineage.credential, profileChain: ['prf_other'] },
		})?.credential.profileChain,
	).toBeUndefined()
})

test('a triggered run as a sub-profile records its whole chain', () => {
	const enablement = {
		id: 'enablement-1',
		enabler: { userId: user.userId, username: 'cy' },
		role: 'member' as const,
		profileId: 'prf_child',
		profileChain: ['prf_root', 'prf_child'],
	}
	const request = deriveRequestContext({
		user,
		source: { kind: 'schedule', jobId: 'job-1', enablement },
	})
	expect(request.credential).toMatchObject({
		profileId: 'prf_child',
		profileChain: ['prf_root', 'prf_child'],
	})
	const parent = deriveRequestContext({
		user,
		source: { kind: 'api-token', tokenId: 'tok_1' },
	})
	const inherited = deriveRequestContext({
		user,
		source: { kind: 'inherited', lineage: requestLineage(parent) },
		profileId: 'prf_child',
		profileChain: ['prf_root', 'prf_child'],
	})
	expect(inherited.credential).toMatchObject({
		profileId: 'prf_child',
		profileChain: ['prf_root', 'prf_child'],
	})
})
