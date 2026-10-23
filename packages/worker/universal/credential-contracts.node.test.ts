import { expect, test } from 'vitest'
import {
	type CredentialMappingProposalChange,
	buildCredentialApprovalHref,
	buildCredentialCreateHref,
	buildCredentialCreateUrl,
	isCredentialKind,
	maxCredentialProposalValues,
	orgCredentialCreatePath,
	parseCredentialApprovalQuery,
	parseCredentialCreateQuery,
	parseCredentialPick,
	readCredentialProposalId,
} from './credential-contracts.ts'

test('creation links lock the kind only when required and round-trip prefill', () => {
	const href = buildCredentialCreateHref({
		kind: 'oauth',
		kindMode: 'required',
		name: 'github',
		provider: 'github',
		description: 'Read PRs',
		allowedHosts: ['api.github.com', ' uploads.github.com '],
		packageKodyId: 'pr-digest',
		needKey: 'github',
		extra: { scopes: 'repo', kind: 'secret' },
	})
	const url = new URL(href, 'https://kody.codes')
	expect(url.pathname).toBe('/connect/credential')
	const parsed = parseCredentialCreateQuery(url.searchParams)
	expect(parsed).toMatchObject({
		kind: 'oauth',
		kindLocked: true,
		name: 'github',
		provider: 'github',
		description: 'Read PRs',
		allowedHosts: ['api.github.com', 'uploads.github.com'],
		packageKodyId: 'pr-digest',
		needKey: 'github',
	})
	expect(parsed.passthrough.toString()).toBe('scopes=repo')

	const hint = parseCredentialCreateQuery(
		new URL(buildCredentialCreateHref({ kind: 'secret' }), 'https://x.test')
			.searchParams,
	)
	expect(hint).toMatchObject({ kind: 'secret', kindLocked: false })

	const unknownKind = parseCredentialCreateQuery(
		new URLSearchParams('kind=nope&kindMode=required'),
	)
	expect(unknownKind).toMatchObject({ kind: null, kindLocked: false })
	expect(buildCredentialCreateHref({})).toBe('/connect/credential')
	expect(
		buildCredentialCreateUrl('https://kody.codes/mcp', { name: 'x' }),
	).toBe('https://kody.codes/connect/credential?name=x')
})

test('links that know their org open that org, and carry package scope, expiry, and locks', () => {
	expect(orgCredentialCreatePath('acme clients')).toBe(
		'/@acme%20clients/-/credentials/new',
	)
	expect(buildCredentialCreateHref({ orgSlug: 'acme', name: 'x' })).toBe(
		'/@acme/-/credentials/new?name=x',
	)
	expect(buildCredentialCreateHref({ orgSlug: ' ', name: 'x' })).toBe(
		'/connect/credential?name=x',
	)

	const packageKey = new URL(
		buildCredentialCreateHref({
			orgSlug: 'acme',
			kind: 'secret',
			name: 'TOKEN',
			packageScopedTo: 'pkg-1',
			expiresAt: '2026-12-31',
			allowedPackages: ['pkg-2'],
		}),
		'https://kody.codes',
	)
	expect(Object.fromEntries(packageKey.searchParams)).toEqual({
		kind: 'secret',
		name: 'TOKEN',
		scope: 'package',
		packageId: 'pkg-1',
		expiresAt: '2026-12-31',
	})
	expect(parseCredentialCreateQuery(packageKey.searchParams)).toMatchObject({
		packageScopedTo: 'pkg-1',
		packageScopeMissingId: false,
		expiresAt: '2026-12-31',
		allowedPackages: [],
	})

	const locked = parseCredentialCreateQuery(
		new URL(
			buildCredentialCreateHref({
				allowedPackages: ['pkg-2', ' pkg-1 ', 'pkg-2'],
			}),
			'https://kody.codes',
		).searchParams,
	)
	expect(locked).toMatchObject({
		packageScopedTo: null,
		allowedPackages: ['pkg-2', 'pkg-1'],
	})
	expect(locked.passthrough.toString()).toBe('')

	const parse = (search: string) =>
		parseCredentialCreateQuery(new URLSearchParams(search))
	expect(parse('packageId=pkg-1')).toMatchObject({
		packageScopedTo: 'pkg-1',
	})
	expect(parse('scope=package')).toMatchObject({
		packageScopedTo: null,
		packageScopeMissingId: true,
	})
	expect(parse('scope=user&packageId=pkg-1&allowedPackages=a,b')).toMatchObject(
		{ packageScopedTo: null, allowedPackages: ['a', 'b'] },
	)
})

test('picks parse names, scoped names, and ids', () => {
	expect(parseCredentialPick('work')).toEqual({ name: 'work' })
	expect(parseCredentialPick('org:work')).toEqual({
		name: 'work',
		scope: 'org',
	})
	expect(parseCredentialPick('personal:me')).toEqual({
		name: 'me',
		scope: 'personal',
	})
	expect(parseCredentialPick('id:abc')).toEqual({ id: 'abc' })
	expect(parseCredentialPick('acme:bot')).toEqual({ name: 'acme:bot' })
	expect(parseCredentialPick('name:org:bot')).toEqual({ name: 'org:bot' })
	expect(parseCredentialPick('  ')).toBeNull()
	expect(parseCredentialPick('org:')).toBeNull()
	expect(parseCredentialPick('name:')).toBeNull()
	expect(isCredentialKind('mcp')).toBe(true)
	expect(isCredentialKind('vault')).toBe(false)
})

test('names that look like prefixes and brackets in names round-trip', () => {
	const changes = [
		{
			target: { type: 'default', layer: 'mine' },
			needKey: 'google',
			credentials: [
				{ name: 'org:bot' },
				{ name: 'id:abc' },
				{ name: 'name:x' },
			],
		},
		{
			target: {
				type: 'trigger',
				trigger: { kind: 'cron', name: 'daily]backup [50%]' },
			},
			needKey: 'git[hub]',
			credentials: [{ id: 'cred-1' }],
		},
	] satisfies Array<CredentialMappingProposalChange>
	const href = buildCredentialApprovalHref({
		username: 'acme',
		kodyId: 'pr-digest',
		changes,
	})
	const url = new URL(href, 'https://kody.codes')
	expect(url.searchParams.getAll('mine[google]')).toEqual([
		'name:org:bot',
		'name:id:abc',
		'name:name:x',
	])
	expect(parseCredentialApprovalQuery(url.searchParams)).toEqual({
		changes,
		enable: [],
		sender: null,
		reason: null,
		errors: [],
	})
})

test('a leading space before a reserved prefix still escapes the name', () => {
	const href = buildCredentialApprovalHref({
		username: 'acme',
		kodyId: 'pr-digest',
		changes: [
			{
				target: { type: 'default', layer: 'mine' },
				needKey: 'google',
				credentials: [{ name: ' org:bot' }, { name: '  id:abc' }],
			},
		],
	})
	const url = new URL(href, 'https://kody.codes')
	expect(url.searchParams.getAll('mine[google]')).toEqual([
		'name: org:bot',
		'name:  id:abc',
	])
	expect(parseCredentialApprovalQuery(url.searchParams).changes).toEqual([
		{
			target: { type: 'default', layer: 'mine' },
			needKey: 'google',
			credentials: [{ name: 'org:bot' }, { name: 'id:abc' }],
		},
	])
})

test('approval links round-trip defaults, personal defaults, triggers, and none', () => {
	const href = buildCredentialApprovalHref({
		username: 'acme',
		kodyId: 'pr-digest',
		changes: [
			{
				target: { type: 'default', layer: 'org' },
				needKey: 'github',
				credentials: [{ name: 'acme-bot', scope: 'org' }],
			},
			{
				target: { type: 'default', layer: 'mine' },
				needKey: 'google',
				credentials: [{ name: 'work' }, { id: 'cred-2' }],
			},
			{
				target: {
					type: 'trigger',
					trigger: { kind: 'cron', name: 'daily' },
				},
				needKey: 'slack',
				credentials: [],
			},
		],
		reason: 'Daily digest',
	})
	const url = new URL(href, 'https://kody.codes')
	expect(url.pathname).toBe('/@acme/pr-digest/approve-credentials')
	expect(parseCredentialApprovalQuery(url.searchParams)).toEqual({
		changes: [
			{
				target: { type: 'default', layer: 'org' },
				needKey: 'github',
				credentials: [{ name: 'acme-bot', scope: 'org' }],
			},
			{
				target: { type: 'default', layer: 'mine' },
				needKey: 'google',
				credentials: [{ name: 'work' }, { id: 'cred-2' }],
			},
			{
				target: {
					type: 'trigger',
					trigger: { kind: 'cron', name: 'daily' },
				},
				needKey: 'slack',
				credentials: [],
			},
		],
		enable: [],
		sender: null,
		reason: 'Daily digest',
		errors: [],
	})
})

test('enable params turn triggers on with no mapping, deduped and capped with mappings', () => {
	const href = buildCredentialApprovalHref({
		username: 'acme',
		kodyId: 'pr-digest',
		changes: [],
		enable: [
			{ kind: 'webhook', name: 'incoming' },
			{ kind: 'subscription', name: 'acme.thing:happened' },
		],
	})
	expect(href).toBe(
		'/@acme/pr-digest/approve-credentials?enable=webhook%3Aincoming&enable=subscription%3Aacme.thing%3Ahappened',
	)
	expect(
		parseCredentialApprovalQuery(
			new URL(href, 'https://kody.codes').searchParams,
		),
	).toEqual({
		changes: [],
		enable: [
			{ kind: 'webhook', name: 'incoming' },
			{ kind: 'subscription', name: 'acme.thing:happened' },
		],
		sender: null,
		reason: null,
		errors: [],
	})

	const endpointHref = buildCredentialApprovalHref({
		username: 'acme',
		kodyId: 'pr-digest',
		changes: [],
		enable: [
			{
				kind: 'webhook',
				name: 'incoming',
				endpointId: '11111111-1111-1111-1111-111111111111',
			},
		],
	})
	expect(endpointHref).toContain(
		'enable=webhook%3Aincoming%3A11111111-1111-1111-1111-111111111111',
	)
	expect(
		parseCredentialApprovalQuery(
			new URL(endpointHref, 'https://kody.codes').searchParams,
		).enable,
	).toEqual([
		{
			kind: 'webhook',
			name: 'incoming',
			endpointId: '11111111-1111-1111-1111-111111111111',
		},
	])

	const messy = parseCredentialApprovalQuery(
		new URLSearchParams(
			'enable=webhook:incoming&enable= webhook : incoming &enable=hourly:x&enable=cron:&enable=daily',
		),
	)
	expect(messy.enable).toEqual([{ kind: 'webhook', name: 'incoming' }])
	expect(messy.errors).toEqual([
		'"enable=hourly:x" is not a trigger; use <cron|subscription|webhook>:<name>.',
		'"enable=cron:" is not a trigger; use <cron|subscription|webhook>:<name>.',
		'"enable=daily" is not a trigger; use <cron|subscription|webhook>:<name>.',
	])

	const tooMany = new URLSearchParams()
	for (let index = 0; index < maxCredentialProposalValues; index += 1) {
		tooMany.append(`default[need-${index}]`, 'x')
	}
	tooMany.append('enable', 'webhook:incoming')
	const capped = parseCredentialApprovalQuery(tooMany)
	expect(capped).toMatchObject({ changes: [], enable: [] })
	expect(capped.errors).toHaveLength(1)
})

test('approval queries report malformed mapping params and cap the size', () => {
	const parsed = parseCredentialApprovalQuery(
		new URLSearchParams(
			'defaults[github]=x&trigger[hourly:x][github]=y&utm_source=chat&default[github]=org:bot',
		),
	)
	expect(parsed.errors).toEqual([
		'"defaults[github]" is not a mapping parameter.',
		'"trigger[hourly:x][github]" is not a mapping parameter.',
	])
	expect(parsed.changes).toEqual([
		{
			target: { type: 'default', layer: 'org' },
			needKey: 'github',
			credentials: [{ name: 'bot', scope: 'org' }],
		},
	])

	const invalid = parseCredentialApprovalQuery(
		new URLSearchParams(
			'default[github]=org:&mine[google]=&mine[google]=work&default[slack]=',
		),
	)
	expect(invalid.errors).toEqual([
		'"default[github]" has a value that is not a credential pick: "org:".',
		'"mine[google]" mixes an empty value (none on purpose) with credentials.',
	])
	expect(invalid.changes).toEqual([
		{
			target: { type: 'default', layer: 'org' },
			needKey: 'slack',
			credentials: [],
		},
	])

	const tooMany = new URLSearchParams()
	for (let index = 0; index <= maxCredentialProposalValues; index += 1) {
		tooMany.append(`default[need-${index}]`, 'x')
	}
	const capped = parseCredentialApprovalQuery(tooMany)
	expect(capped.changes).toEqual([])
	expect(capped.errors).toHaveLength(1)

	// The cap counts mapping params; a repeatable param may list many values.
	const manyValues = new URLSearchParams()
	for (let index = 0; index <= maxCredentialProposalValues; index += 1) {
		manyValues.append('default[github]', `bot-${index}`)
	}
	const repeated = parseCredentialApprovalQuery(manyValues)
	expect(repeated.errors).toEqual([])
	expect(repeated.changes[0]!.credentials).toHaveLength(
		maxCredentialProposalValues + 1,
	)
})

test('param names that decode to one target and need make one change', () => {
	const parsed = parseCredentialApprovalQuery(
		new URLSearchParams(
			'default[github]=org:bot&default[git%68ub]=personal:me&default[ github ]=extra&trigger[cron:daily][slack]=a&trigger[cron: daily][slack]=b',
		),
	)
	expect(parsed.errors).toEqual([])
	expect(parsed.changes).toEqual([
		{
			target: { type: 'default', layer: 'org' },
			needKey: 'github',
			credentials: [
				{ name: 'bot', scope: 'org' },
				{ name: 'me', scope: 'personal' },
				{ name: 'extra' },
			],
		},
		{
			target: { type: 'trigger', trigger: { kind: 'cron', name: 'daily' } },
			needKey: 'slack',
			credentials: [{ name: 'a' }, { name: 'b' }],
		},
	])
})

test('a blank pick name never encodes as none on purpose', () => {
	const href = buildCredentialApprovalHref({
		username: 'acme',
		kodyId: 'digest',
		changes: [
			{
				target: { type: 'default', layer: 'mine' },
				needKey: 'mail',
				credentials: [{ name: '  ' }],
			},
		],
	})
	const parsed = parseCredentialApprovalQuery(
		new URL(href, 'https://kody.codes').searchParams,
	)
	expect(parsed.changes).toEqual([])
	expect(parsed.errors).toEqual([
		'"mine[mail]" has a value that is not a credential pick: "name:  ".',
	])
})

test('an approval link names the recorded agent proposal without adding a change', () => {
	const changes: Array<CredentialMappingProposalChange> = [
		{
			target: { type: 'trigger', trigger: { kind: 'cron', name: 'daily' } },
			needKey: 'chat',
			credentials: [{ name: 'team-slack' }],
		},
	]
	const plain = buildCredentialApprovalHref({
		username: 'acme-clients',
		kodyId: 'digest',
		changes,
	})
	const named = buildCredentialApprovalHref({
		username: 'acme-clients',
		kodyId: 'digest',
		changes,
		proposalId: 'p-1',
	})
	const search = new URL(named, 'https://kody.test').searchParams
	expect(readCredentialProposalId(search)).toBe('p-1')
	expect(
		readCredentialProposalId(new URL(plain, 'https://kody.test').searchParams),
	).toBeNull()
	expect(parseCredentialApprovalQuery(search)).toEqual(
		parseCredentialApprovalQuery(
			new URL(plain, 'https://kody.test').searchParams,
		),
	)
})

test('approval links round-trip a sender and reject a sender that cannot be stored', () => {
	const memberId = 'a'.repeat(64)
	const href = buildCredentialApprovalHref({
		username: 'acme',
		kodyId: 'digest',
		changes: [],
		enable: [{ kind: 'subscription', name: 'email.message.received' }],
		sender: { kind: 'address', value: 'receipts@shop.example' },
	})
	expect(href).toBe(
		'/@acme/digest/approve-credentials?enable=subscription%3Aemail.message.received&sender_kind=address&sender_value=receipts%40shop.example',
	)
	expect(
		parseCredentialApprovalQuery(
			new URL(href, 'https://kody.codes').searchParams,
		),
	).toEqual({
		changes: [],
		enable: [{ kind: 'subscription', name: 'email.message.received' }],
		sender: { kind: 'address', value: 'receipts@shop.example' },
		reason: null,
		errors: [],
	})

	const member = parseCredentialApprovalQuery(
		new URLSearchParams(
			`enable=subscription:email.message.received&sender_kind=member&sender_value=${memberId.toUpperCase()}`,
		),
	)
	expect(member.sender).toEqual({ kind: 'member', value: memberId })
	expect(member.errors).toEqual([])

	const domain = parseCredentialApprovalQuery(
		new URLSearchParams(
			'sender_kind=domain&sender_value=%40Shop.Example&enable=subscription:email.message.quarantined',
		),
	)
	expect(domain.sender).toEqual({ kind: 'domain', value: 'shop.example' })

	const anyAuthenticated = parseCredentialApprovalQuery(
		new URLSearchParams(
			'sender_kind=any_authenticated&sender_value=ignored@shop.example',
		),
	)
	expect(anyAuthenticated.sender).toEqual({
		kind: 'any_authenticated',
		value: null,
	})
	expect(anyAuthenticated.errors).toEqual([])

	const missingValue = parseCredentialApprovalQuery(
		new URLSearchParams('sender_kind=address'),
	)
	expect(missingValue.sender).toBeNull()
	expect(missingValue.errors).toEqual([
		'"sender_kind=address" needs a sender_value that is an email address.',
	])

	const missingKind = parseCredentialApprovalQuery(
		new URLSearchParams('sender_value=receipts@shop.example'),
	)
	expect(missingKind.sender).toBeNull()
	expect(missingKind.errors[0]).toContain('sender_kind')

	const unknown = parseCredentialApprovalQuery(
		new URLSearchParams('sender_kind=everyone&default[github]=org:bot'),
	)
	expect(unknown.sender).toBeNull()
	expect(unknown.changes).toEqual([
		{
			target: { type: 'default', layer: 'org' },
			needKey: 'github',
			credentials: [{ name: 'bot', scope: 'org' }],
		},
	])
	expect(unknown.errors).toEqual([
		'"sender_kind=everyone" is not a sender; use member, address, domain, or any_authenticated.',
	])
})
