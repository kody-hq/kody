import { expect, test } from 'vitest'
import {
	type CredentialListItem,
	credentialKinds,
	parseCredentialCreateQuery,
} from '#universal/credential-contracts.ts'
import {
	buildKeySaveBody,
	createKeyFormState,
	credentialCreateAgentPrompt,
	credentialCreateFormKey,
	credentialCreateHandoffHref,
	credentialCreateMode,
	credentialNeedApprovalHref,
	existingKindConflict,
	findExistingOrgKey,
	expiresAtDateValue,
	expiresAtHasTime,
	findMatchingCredentials,
	isMaskedLoginField,
	loginFieldNames,
	keyFormProblem,
	keyLinkProblem,
	parseHostsInput,
	writeCredentialCreateKind,
} from './connect-credential-shared.ts'

function credential(
	overrides: Partial<CredentialListItem> & { id: string; name: string },
): CredentialListItem {
	return {
		kind: 'secret',
		scope: 'org',
		provider: null,
		description: '',
		hosts: [],
		inject: null,
		placement: null,
		packageId: null,
		lockedToPackageIds: [],
		expiresAt: null,
		createdAt: '2026-10-13T00:00:00.000Z',
		updatedAt: '2026-10-13T00:00:00.000Z',
		status: 'ok',
		statusMessage: null,
		mcp: null,
		...overrides,
	}
}

const query = (search: string) =>
	parseCredentialCreateQuery(new URLSearchParams(search))

test('the website takes a typed value for every kind but OAuth and MCP, which it hands off', () => {
	expect(
		Object.fromEntries(
			credentialKinds.map((kind) => [kind, credentialCreateMode(kind)]),
		),
	).toEqual({
		secret: 'value-form',
		oauth: 'handoff',
		mcp: 'handoff',
		url: 'value-form',
		login: 'value-form',
		signing: 'value-form',
	})
})

test('choosing a kind keeps the prefill, and hand-offs carry it on', () => {
	expect(
		writeCredentialCreateKind(
			'/connect/credential?kind=secret&name=x&forPackage=pr-digest&need=llm',
			'oauth',
		),
	).toBe('/connect/credential?kind=oauth&name=x&forPackage=pr-digest&need=llm')
	expect(
		credentialCreateHandoffHref({
			kind: 'oauth',
			search: new URLSearchParams('kind=oauth&provider=github&scopes=repo'),
			orgSlug: 'acme',
		}),
	).toBe('/connect/oauth?kind=oauth&provider=github&scopes=repo&org=acme')
	expect(
		credentialCreateHandoffHref({
			kind: 'mcp',
			search: new URLSearchParams('kind=mcp'),
			orgSlug: 'acme',
		}),
	).toBe('/@acme/-/mcp-servers/new')
	expect(
		credentialCreateHandoffHref({
			kind: 'mcp',
			search: new URLSearchParams(
				'kind=mcp&name=docs&url=https%3A%2F%2Fmcp.example.com&provider=x',
			),
			orgSlug: 'acme',
		}),
	).toBe('/@acme/-/mcp-servers/new?name=docs&url=https%3A%2F%2Fmcp.example.com')
})

test('the Key form starts from the link and saves an org Key', () => {
	const form = createKeyFormState(
		query(
			'kind=secret&name=OPENAI_API_KEY&provider=openai&description=For+summaries&allowedHosts=api.openai.com,uploads.openai.com',
		),
	)
	expect(form).toEqual({
		name: 'OPENAI_API_KEY',
		value: '',
		description: 'For summaries',
		provider: 'openai',
		hosts: 'api.openai.com\nuploads.openai.com',
		expiresAt: '',
		packageScope: 'org',
		packageId: '',
		allowedPackages: [],
		replaceExisting: false,
		loginFields: {},
		loginExchange: {
			url: '',
			bodyFormat: 'json',
			body: '{"username":"{username}","password":"{password}"}',
			tokenPath: '',
			rest: {},
		},
		loginExchangeOpen: true,
	})
	expect(
		buildKeySaveBody({
			kind: 'secret',
			form: { ...form, value: 'sk-1', hosts: 'API.openai.com, x.dev\nx.dev' },
			existing: null,
		}),
	).toEqual({
		ok: true,
		body: {
			action: 'save',
			currentId: null,
			name: 'OPENAI_API_KEY',
			scope: 'user',
			packageId: null,
			value: 'sk-1',
			description: 'For summaries',
			provider: 'openai',
			expiresAt: null,
			allowedHosts: ['api.openai.com', 'x.dev'],
			allowedPackages: [],
		},
	})
})

test('replacing an existing Key keeps its hosts; package locks follow the form', () => {
	const existing = credential({
		id: 'k1',
		name: 'OPENAI_API_KEY',
		hosts: ['api.openai.com'],
		lockedToPackageIds: ['pkg-1'],
	})
	const credentials = [
		credential({ id: 'p1', name: 'OPENAI_API_KEY', packageId: 'pkg-2' }),
		credential({ id: 'm1', name: 'OPENAI_API_KEY', scope: 'personal' }),
		existing,
	]
	expect(findExistingOrgKey(credentials, ' OPENAI_API_KEY ')).toBe(existing)
	expect(findExistingOrgKey(credentials, '')).toBeNull()
	const form = {
		...createKeyFormState(query('name=OPENAI_API_KEY&allowedHosts=x.dev')),
		value: 'sk-2',
		replaceExisting: true,
		// Replacement hydrates checkboxes from existing locks; the save submits
		// that checked set (so unchecking removes a lock).
		allowedPackages: ['pkg-1'],
	}
	expect(buildKeySaveBody({ kind: 'secret', form, existing })).toMatchObject({
		body: {
			currentId: 'user::::OPENAI_API_KEY',
			allowedHosts: ['api.openai.com', 'x.dev'],
			allowedPackages: ['pkg-1'],
		},
	})
	// Case-only rename keeps currentId on the stored casing so the server can
	// update the row in place instead of treating it as a create.
	expect(
		buildKeySaveBody({
			kind: 'secret',
			form: { ...form, name: 'openai_api_key' },
			existing,
		}),
	).toMatchObject({
		body: {
			currentId: 'user::::OPENAI_API_KEY',
			name: 'openai_api_key',
		},
	})
	expect(
		buildKeySaveBody({
			kind: 'secret',
			form: { ...form, allowedPackages: ['pkg-2'] },
			existing,
		}),
	).toMatchObject({
		body: { allowedPackages: ['pkg-2'] },
	})
	expect(
		findExistingOrgKey(
			[credential({ id: 'o1', name: 'gh', kind: 'oauth' })],
			'gh',
		),
	).toBeNull()
	// An emptied provider clears the replaced Key's; no Key to replace sends none.
	const withProvider = { ...existing, provider: 'openai' }
	expect(
		buildKeySaveBody({ kind: 'secret', form, existing: withProvider }),
	).toMatchObject({ ok: true, body: { provider: '' } })
	expect(
		buildKeySaveBody({
			kind: 'secret',
			form: { ...form, replaceExisting: false },
			existing: null,
		}),
	).toMatchObject({ ok: true, body: { provider: null } })
})

test('a name another kind holds is not offered for replacement', () => {
	const signing = credential({ id: 's1', name: 'HOOK', kind: 'signing' })
	const oauth = credential({ id: 'o1', name: 'github', kind: 'oauth' })
	expect(findExistingOrgKey([oauth], 'github')).toBeNull()
	expect(findExistingOrgKey([signing], 'HOOK')).toBe(signing)
	expect(existingKindConflict(signing, 'secret')).toContain(
		'credential named HOOK already exists',
	)
	expect(existingKindConflict(signing, 'signing')).toBeNull()
	expect(existingKindConflict(null, 'secret')).toBeNull()
})

test('package Keys, expiry, and package locks come from the link and save like the legacy intake', () => {
	const packageForm = createKeyFormState(
		query('name=TOKEN&scope=package&packageId=pkg-1&expiresAt=2026-12-31'),
	)
	expect(packageForm).toMatchObject({
		packageScope: 'package',
		packageId: 'pkg-1',
		expiresAt: '2026-12-31T00:00:00.000Z',
		allowedPackages: [],
	})
	expect(expiresAtDateValue(packageForm.expiresAt)).toBe('2026-12-31')
	expect(expiresAtHasTime(packageForm.expiresAt)).toBe(false)
	expect(expiresAtHasTime('2026-12-31T15:30:00.000Z')).toBe(true)
	expect(
		buildKeySaveBody({
			kind: 'secret',
			form: { ...packageForm, value: 'v', allowedPackages: ['pkg-9'] },
			existing: null,
		}),
	).toMatchObject({
		ok: true,
		body: {
			scope: 'package',
			packageId: 'pkg-1',
			expiresAt: '2026-12-31T00:00:00.000Z',
			allowedPackages: [],
		},
	})
	expect(
		buildKeySaveBody({
			kind: 'url',
			form: {
				...packageForm,
				value: 'https://hooks.example.com/abc',
				hosts: 'hooks.example.com',
			},
			existing: null,
		}),
	).toMatchObject({ ok: true, body: { scope: 'user', packageId: null } })

	const lockedForm = createKeyFormState(
		query('name=TOKEN&allowedPackages=pkg-2,pkg-1'),
	)
	expect(lockedForm).toMatchObject({
		packageScope: 'org',
		allowedPackages: ['pkg-2', 'pkg-1'],
	})
	expect(
		buildKeySaveBody({
			kind: 'secret',
			form: { ...lockedForm, value: 'v' },
			existing: null,
		}),
	).toMatchObject({
		ok: true,
		body: {
			scope: 'user',
			packageId: null,
			allowedPackages: ['pkg-1', 'pkg-2'],
		},
	})

	const packageKey = credential({
		id: 'p1',
		name: 'TOKEN',
		packageId: 'pkg-1',
		expiresAt: '2027-01-01T00:00:00.000Z',
	})
	const orgKey = credential({ id: 'o1', name: 'TOKEN' })
	expect(findExistingOrgKey([orgKey, packageKey], 'TOKEN', 'pkg-1')).toBe(
		packageKey,
	)
	expect(findExistingOrgKey([orgKey, packageKey], 'TOKEN')).toBe(orgKey)
	expect(
		buildKeySaveBody({
			kind: 'secret',
			form: {
				...createKeyFormState(query('name=TOKEN&packageId=pkg-1')),
				value: 'v',
				replaceExisting: true,
			},
			existing: packageKey,
		}),
	).toMatchObject({
		ok: true,
		body: {
			currentId: 'package::pkg-1::TOKEN',
			expiresAt: '2027-01-01T00:00:00.000Z',
		},
	})
})

test('a link the form cannot honor says why, and a package Key needs its package', () => {
	const packages = [{ id: 'pkg-1' }]
	const problem = (search: string) =>
		keyLinkProblem({ query: query(search), packages })
	expect(problem('name=x&packageId=pkg-1&expiresAt=2026-12-31')).toBeNull()
	expect(problem('expiresAt=soon')).toContain('invalid expiresAt')
	expect(createKeyFormState(query('expiresAt=soon')).expiresAt).toBe('')
	expect(problem('scope=package')).toContain('names no package')
	expect(problem('packageId=pkg-404')).toContain('not in this org')
	expect(problem('kind=url&packageId=pkg-1')).toContain(
		'Only a Key can belong to one package',
	)
	expect(problem('kind=url&allowedPackages=pkg-1')).toBeNull()
	const packageScopeNoId = {
		...createKeyFormState(query('name=x')),
		packageScope: 'package' as const,
	}
	expect(keyFormProblem(packageScopeNoId, 'secret')).toBe(
		'Choose the package this key belongs to.',
	)
	expect(keyFormProblem(packageScopeNoId, 'url')).toBeNull()
	expect(
		keyFormProblem(createKeyFormState(query('name=x')), 'secret'),
	).toBeNull()
})

test('matches need a provider, and a kind when the link names one', () => {
	const credentials = [
		credential({ id: 'a', name: 'gh', kind: 'oauth', provider: 'github' }),
		credential({ id: 'b', name: 'GH_PAT', provider: 'github' }),
		credential({ id: 'c', name: 'other', kind: 'oauth', provider: 'linear' }),
	]
	const ids = (search: string) =>
		findMatchingCredentials(credentials, query(search)).map((item) => item.id)
	expect(ids('kind=oauth&provider=github')).toEqual(['a'])
	expect(ids('provider=github')).toEqual(['a', 'b'])
	expect(ids('kind=oauth')).toEqual([])
})

test('hosts accept lines, commas, and spaces', () => {
	expect(parseHostsInput(' a.dev,b.dev \n\nA.dev c.dev')).toEqual([
		'a.dev',
		'b.dev',
		'c.dev',
	])
})

test('url and signing saves send kind and exactly the typed hosts', () => {
	const existing = credential({
		id: 'u1',
		name: 'BOT_URL',
		kind: 'url',
		hosts: ['old.example.com'],
		lockedToPackageIds: ['pkg-1'],
	})
	const form = {
		...createKeyFormState(
			query('kind=url&name=BOT_URL&allowedHosts=hooks.example.com'),
		),
		value: ' https://hooks.example.com/abc ',
		replaceExisting: true,
		allowedPackages: ['pkg-1'],
	}
	expect(buildKeySaveBody({ kind: 'url', form, existing })).toEqual({
		ok: true,
		body: {
			action: 'save',
			currentId: 'user::::BOT_URL',
			name: 'BOT_URL',
			scope: 'user',
			packageId: null,
			kind: 'url',
			value: 'https://hooks.example.com/abc',
			hosts: ['hooks.example.com'],
			allowedHosts: [],
			allowedPackages: ['pkg-1'],
			description: '',
			provider: null,
			expiresAt: null,
		},
	})
	expect(
		buildKeySaveBody({ kind: 'signing', form, existing: null }),
	).toMatchObject({ ok: true, body: { kind: 'signing', currentId: null } })
})

test('a login save builds its value from the exchange body fields', () => {
	const exchange = {
		url: 'https://api.example.com/login',
		bodyFormat: 'form',
		body: { email: '{email}', pass: '{password}', client: 'kody' },
		tokenPath: 'data.token',
		ttlSeconds: 600,
	}
	const form = createKeyFormState(
		query(
			`kind=login&name=SITE&allowedHosts=api.example.com&loginExchange=${encodeURIComponent(JSON.stringify(exchange))}`,
		),
	)
	expect(loginFieldNames(form.loginExchange)).toEqual(['email', 'password'])
	expect(form.loginExchangeOpen).toBe(false)
	expect(isMaskedLoginField('password')).toBe(true)
	expect(isMaskedLoginField('email')).toBe(false)
	const save = buildKeySaveBody({
		kind: 'login',
		form: {
			...form,
			loginFields: { email: 'me@x.dev', password: 'pw', extra: 'no' },
		},
		existing: null,
	})
	expect(save).toMatchObject({
		ok: true,
		body: {
			kind: 'login',
			value: JSON.stringify({ email: 'me@x.dev', password: 'pw' }),
			hosts: ['api.example.com'],
			loginExchange: exchange,
		},
	})
	expect(
		buildKeySaveBody({
			kind: 'login',
			form: { ...form, loginExchange: { ...form.loginExchange, body: '[1]' } },
			existing: null,
		}),
	).toMatchObject({ ok: false, error: expect.stringContaining('JSON object') })
	expect(loginFieldNames({ ...form.loginExchange, body: 'not json' })).toEqual([
		'username',
		'password',
	])
})

test('the agent prompt names the kind, credential, need, link, and error', () => {
	expect(
		credentialCreateAgentPrompt({
			kind: 'url',
			query: query('kind=url&name=BOT_URL&forPackage=bot&need=telegram'),
			pageUrl: 'https://kody.codes/connect/credential?kind=url',
			error: 'A url credential needs hosts.',
		}),
	).toBe(
		[
			'I tried to save a URL credential named "BOT_URL" for the "telegram" need of package bot on Kody: https://kody.codes/connect/credential?kind=url',
			'Kody said: A url credential needs hosts.',
			'Help me fix the link or the form. Do not ask me to paste the value into chat.',
		].join('\n'),
	)
})

test('a saved credential for a package need links to approve it as your default', () => {
	const href = credentialNeedApprovalHref({
		orgSlug: 'acme',
		packageKodyId: 'pr-digest',
		needKey: 'github',
		credentialId: 'cred 1',
	})
	const url = new URL(href, 'https://kody.codes')
	expect(url.pathname).toBe('/@acme/pr-digest/approve-credentials')
	expect([...url.searchParams]).toEqual([['mine[github]', 'id:cred 1']])
})

test('the agent prompt leaves out a login link’s exchange', () => {
	const exchange = encodeURIComponent(
		JSON.stringify({
			url: 'https://auth.example.com/token',
			body: { client_secret: 'fixed-secret', username: '{username}' },
		}),
	)
	const prompt = credentialCreateAgentPrompt({
		kind: 'login',
		query: query('kind=login&name=SVC_LOGIN'),
		pageUrl: `https://kody.codes/@acme/-/credentials/new?kind=login&name=SVC_LOGIN&loginExchange=${exchange}`,
		error: 'Fill every login field.',
	})
	expect(prompt).not.toContain('fixed-secret')
	expect(prompt).toContain(
		'https://kody.codes/@acme/-/credentials/new?kind=login&name=SVC_LOGIN',
	)
	expect(prompt).toContain('left out the link’s loginExchange')
})

test('picking Key on a link with no kind keeps the same form', () => {
	const bare = '/@acme/-/credentials/new?name=STRIPE_KEY'
	expect(credentialCreateFormKey(bare)).toBe(
		credentialCreateFormKey(writeCredentialCreateKind(bare, 'secret')),
	)
	expect(credentialCreateFormKey(bare)).not.toBe(
		credentialCreateFormKey(writeCredentialCreateKind(bare, 'url')),
	)
})
