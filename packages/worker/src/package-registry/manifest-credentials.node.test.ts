import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'
import { readRootPackage } from '#worker/package-runtime/module-graph-workspace.ts'
import { parseAuthoredPackageJson } from './manifest.ts'

function manifestWithCredentials(credentials: unknown) {
	return JSON.stringify({
		name: '@acme/demo',
		exports: { '.': './index.ts' },
		kody: { description: 'Demo package.', credentials },
	})
}

function publishError(credentials: unknown) {
	try {
		parseAuthoredPackageJson({ content: manifestWithCredentials(credentials) })
	} catch (error) {
		return error instanceof Error ? error.message : String(error)
	}
	throw new Error('Expected publish to reject the manifest.')
}

test('the kody.credentials example in docs/use/packages.md publishes', () => {
	const doc = readFileSync(
		join(
			dirname(fileURLToPath(import.meta.url)),
			'../../../../docs/use/packages.md',
		),
		'utf8',
	)
	const section = doc.split('### Credential slots (`kody.credentials`)')[1]
	const example = section?.match(/```json\n([\s\S]*?)```/)?.[1]
	expect(example).toBeDefined()
	const manifest = parseAuthoredPackageJson({ content: example! })
	const credentials = manifest.kody.credentials
	expect(credentials).toBeDefined()
	expect(Object.keys(credentials ?? {}).length).toBeGreaterThan(0)
	for (const slot of Object.values(credentials ?? {})) {
		expect(slot.kind).toMatch(/^(oauth|secret|mcp|url|login|signing)$/)
	}
})

test('publish accepts fill placement on a credential need', () => {
	const secret = {
		kind: 'secret' as const,
		provider: 'acme',
		description: 'Refresh token filled into Amazon form bodies.',
		placement: { body: true as const },
	}
	expect(
		parseAuthoredPackageJson({
			content: manifestWithCredentials({ KEY: secret }),
		}).kody.credentials,
	).toEqual({ KEY: secret })
	expect(
		parseAuthoredPackageJson({
			content: manifestWithCredentials({ KEY: secret }),
			mode: 'published',
		}).kody.credentials,
	).toEqual({ KEY: secret })
})

test('publish rejects an invalid placement shape, and published snapshots drop it', () => {
	const secret = { kind: 'secret', provider: 'acme', description: 'x' }
	expect(
		parseAuthoredPackageJson({
			content: manifestWithCredentials({ KEY: secret }),
		}).kody.credentials,
	).toEqual({ KEY: secret })
	const placed = {
		KEY: {
			...secret,
			placement: { header: 'Authorization', template: 'Bearer {value}' },
		},
	}
	expect(publishError(placed)).toMatch(/kody\.credentials\.KEY\.placement/)
	const content = manifestWithCredentials(placed)
	for (const { kody } of [
		parseAuthoredPackageJson({ content, mode: 'published' }),
		readRootPackage({ 'package.json': content })!.manifest,
	]) {
		expect(kody.credentials).toEqual({})
		expect(kody.invalidCredentialSlots?.KEY).toMatch(/placement/)
	}
})

test('publish accepts a need with only description (optional kind)', () => {
	const content = manifestWithCredentials({
		github: { description: 'Read PRs to summarize them' },
	})
	const authored = parseAuthoredPackageJson({ content, mode: 'authoring' })
	expect(authored.kody.credentials).toEqual({
		github: { description: 'Read PRs to summarize them' },
	})
})

test('publish rejects invalid kody.credentials slots and names the slot', () => {
	expect(
		publishError({
			GOOGLE: { kind: 'token', provider: 'google', description: 'x' },
		}),
	).toBe(
		'Invalid package.json:\n✖ Invalid option: expected one of "secret"|"oauth"|"mcp"|"url"|"login"|"signing"\n  → at kody.credentials.GOOGLE.kind',
	)
	expect(
		publishError({ GOOGLE: { kind: 'oauth', provider: '', description: 'x' } }),
	).toMatch(/kody\.credentials\.GOOGLE\.provider/)
	expect(
		publishError({ GOOGLE: { kind: 'oauth', provider: 'google' } }),
	).toMatch(/kody\.credentials\.GOOGLE\.description/)
	expect(
		publishError({
			GOOGLE: {
				kind: 'oauth',
				provider: 'google',
				description: 'x',
				mulitple: true,
			},
		}),
	).toMatch(/Unrecognized key: "mulitple"[\s\S]*kody\.credentials\.GOOGLE/)
	expect(
		publishError({
			'@me/GOOGLE': { kind: 'oauth', provider: 'g', description: 'x' },
		}),
	).toContain('Credential slot names start with a letter')
	expect(publishError(['GOOGLE'])).toMatch(/kody\.credentials/)
})

test('needs may omit provider and use the opt-in kinds', () => {
	const credentials = {
		github: { kind: 'oauth', description: 'Repos to triage.' },
		telegram: { kind: 'url', description: 'Bot URL.' },
		portal: { kind: 'login', provider: 'acme-portal', description: 'Portal.' },
		webhook: { kind: 'signing', description: 'Signs requests.' },
	}
	expect(
		parseAuthoredPackageJson({ content: manifestWithCredentials(credentials) })
			.kody.credentials,
	).toEqual(credentials)
})

test('a need opts in to owner credentials for visitors only with true', () => {
	const credentials = {
		database: {
			description: 'Rooms database.',
			ownerCredentialForVisitors: true,
		},
		github: { description: 'Repos.' },
	}
	expect(
		parseAuthoredPackageJson({ content: manifestWithCredentials(credentials) })
			.kody.credentials,
	).toEqual(credentials)
	for (const value of [false, 'true', 1]) {
		expect(
			publishError({
				database: { description: 'x', ownerCredentialForVisitors: value },
			}),
		).toMatch(
			/ownerCredentialForVisitors takes only true[\s\S]*kody\.credentials\.database\.ownerCredentialForVisitors/,
		)
	}
	expect(
		publishError({
			database: { description: 'x', ownerCredentialsForVisitors: true },
		}),
	).toMatch(/Unrecognized key: "ownerCredentialsForVisitors"/)
})

test('published snapshots load when an old kody.credentials key predates the schema', () => {
	const content = manifestWithCredentials({ GOOGLE: 'my google account' })
	expect(
		readRootPackage({ 'package.json': content })?.manifest.kody.credentials,
	).toBeUndefined()
	expect(
		parseAuthoredPackageJson({ content, mode: 'published' }).kody.credentials,
	).toBeUndefined()
	expect(() => parseAuthoredPackageJson({ content })).toThrow(
		/kody\.credentials\.GOOGLE/,
	)

	for (const garbage of ['x', ['GOOGLE'], { GOOGLE: 'x', LINEAR: 1 }]) {
		expect(
			parseAuthoredPackageJson({
				content: manifestWithCredentials(garbage),
				mode: 'published',
			}).kody,
		).not.toHaveProperty('credentials')
	}
	const empty = manifestWithCredentials({})
	for (const mode of ['published', 'authoring'] as const) {
		expect(
			parseAuthoredPackageJson({ content: empty, mode }).kody.credentials,
		).toEqual({})
	}

	const valid = manifestWithCredentials({
		LINEAR: { kind: 'mcp', provider: 'linear', description: 'Linear MCP.' },
	})
	expect(
		parseAuthoredPackageJson({ content: valid, mode: 'published' }).kody
			.credentials,
	).toEqual({
		LINEAR: { kind: 'mcp', provider: 'linear', description: 'Linear MCP.' },
	})
})

test('published snapshots keep valid slots when one slot fails the slot schema, and name the bad slot', () => {
	const google = { kind: 'oauth', provider: 'google', description: 'Google.' }
	const linear = { kind: 'mcp', provider: 'linear', description: 'Linear.' }
	const content = manifestWithCredentials({
		GOOGLE: google,
		KEY: {
			kind: 'secret',
			provider: 'acme',
			description: 'Acme API key.',
			placement: { header: 'X-Kody-Key' },
		},
		LINEAR: { ...linear, futureRule: true },
		'bad name': google,
		toString: google,
	})
	for (const { kody } of [
		parseAuthoredPackageJson({ content, mode: 'published' }),
		readRootPackage({ 'package.json': content })!.manifest,
	]) {
		expect(kody.credentials).toEqual({
			GOOGLE: google,
			toString: google,
		})
		expect(kody.invalidCredentialSlots?.KEY).toMatch(/placement/)
		expect(kody.invalidCredentialSlots?.LINEAR).toMatch(/futureRule/)
		expect(kody.invalidCredentialSlots?.['bad name']).toMatch(
			/Credential slot names/,
		)
	}
	expect(() => parseAuthoredPackageJson({ content })).toThrow(
		/kody\.credentials\.KEY\.placement/,
	)

	const allInvalid = parseAuthoredPackageJson({
		content: manifestWithCredentials({ LINEAR: { ...linear, futureRule: 1 } }),
		mode: 'published',
	})
	expect(allInvalid.kody.credentials).toEqual({})
	expect(Object.keys(allInvalid.kody.invalidCredentialSlots ?? {})).toEqual([
		'LINEAR',
	])
})

test('package.json cannot set invalidCredentialSlots', () => {
	const content = JSON.stringify({
		name: '@acme/demo',
		exports: { '.': './index.ts' },
		kody: {
			description: 'Demo package.',
			invalidCredentialSlots: { GOOGLE: 'forged' },
		},
	})
	expect(
		parseAuthoredPackageJson({ content }).kody.invalidCredentialSlots,
	).toBeUndefined()
	expect(
		parseAuthoredPackageJson({ content, mode: 'published' }).kody
			.invalidCredentialSlots,
	).toBeUndefined()
})
