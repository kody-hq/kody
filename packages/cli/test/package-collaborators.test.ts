import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runCli } from '../src/cli.js'
import { clearOpenApiRouteCache } from '../src/open-api-client.js'
import {
	formatCollaboratorList,
	type PackageCollaborator,
	parsePackageCollaboratorCommand,
	runPackageCollaboratorPlan,
} from '../src/package-collaborators.js'

const pkg = {
	id: 'pkg-1',
	kody_id: 'release-notes',
	name: '@acme/release-notes',
}

function collaborator(
	overrides: Partial<PackageCollaborator>,
): PackageCollaborator {
	return {
		grant_id: 'grant-1',
		subject_type: 'user',
		subject_id: 'user-1',
		kind: 'member',
		username: 'bob',
		display_name: 'Bob Builder',
		team_slug: null,
		team_name: null,
		preset: 'use',
		permissions: ['package:execute', 'package:read'],
		created_at: '2026-10-14T00:00:00.000Z',
		...overrides,
	}
}

const team = collaborator({
	grant_id: 'grant-team',
	subject_type: 'team',
	subject_id: 'team-1',
	kind: 'team',
	username: null,
	display_name: null,
	team_slug: 'writers',
	team_name: 'Writers',
	preset: 'contribute',
})

test('grant parses --team / --user and defaults the preset to use', () => {
	assert.deepEqual(
		parsePackageCollaboratorCommand({
			action: 'grant',
			positionals: ['@acme/release-notes'],
			values: { team: 'writers', preset: 'contribute' },
		}),
		{
			action: 'grant',
			packageId: '@acme/release-notes',
			subject: { kind: 'team', slug: 'writers' },
			preset: 'contribute',
		},
	)
	assert.deepEqual(
		parsePackageCollaboratorCommand({
			action: 'grant',
			positionals: ['release-notes'],
			values: { user: '@bob' },
		}),
		{
			action: 'grant',
			packageId: 'release-notes',
			subject: { kind: 'user', username: 'bob' },
			preset: 'use',
		},
	)
})

test('grant and revoke reject missing, doubled, or invalid flags', () => {
	const parse =
		(action: 'grant' | 'revoke', positionals: Array<string>, values = {}) =>
		() =>
			parsePackageCollaboratorCommand({ action, positionals, values })
	assert.throws(parse('grant', ['pkg']), /exactly one of --team or --user/)
	assert.throws(
		parse('grant', ['pkg'], { team: 'a', user: 'b' }),
		/exactly one/,
	)
	assert.throws(
		parse('grant', ['pkg'], { grant: 'g' }),
		/exactly one of --team or --user/,
	)
	assert.throws(
		parse('grant', ['pkg'], { team: 'a', preset: 'owner' }),
		/--preset must be one of/,
	)
	assert.throws(
		parse('grant', [], { team: 'a' }),
		/Usage: kody package collaborators/,
	)
	assert.throws(parse('grant', ['pkg', 'extra'], { team: 'a' }), /Usage/)
	assert.throws(parse('grant', ['pkg'], { team: '  ' }), /--team needs a value/)
	assert.throws(
		parse('revoke', ['pkg'], { grant: 'g', preset: 'use' }),
		/only for grant/,
	)
	assert.throws(
		parse('revoke', ['pkg'], { team: 'a', grant: 'g' }),
		/exactly one of --team, --user, or --grant/,
	)
})

test('collaborators prints a table and the API JSON with --json', async () => {
	const list = { package: pkg, collaborators: [team, collaborator({})] }
	const calls: Array<[string, Record<string, unknown>]> = []
	const call = async (operationId: string, params: Record<string, unknown>) => {
		calls.push([operationId, params])
		return list
	}
	const text = await runPackageCollaboratorPlan({
		plan: { action: 'collaborators', packageId: 'release-notes' },
		call,
		json: false,
	})
	assert.equal(text, formatCollaboratorList(list))
	assert.match(text, /^@acme\/release-notes \(pkg-1\)\n/)
	assert.match(text, /team\s+writers \(Writers\)\s+contribute\s+grant-team/)
	assert.match(text, /member\s+@bob \(Bob Builder\)\s+use\s+grant-1/)
	const json = await runPackageCollaboratorPlan({
		plan: { action: 'collaborators', packageId: 'release-notes' },
		call,
		json: true,
	})
	assert.deepEqual(JSON.parse(json), list)
	assert.deepEqual(calls[0], [
		'packageCollaboratorList',
		{ package_id: 'release-notes' },
	])
	assert.match(
		formatCollaboratorList({ package: pkg, collaborators: [] }),
		/No collaborators\. Org owners always have full access\./,
	)
})

test('revoke by team or user looks up the grant; by grant id it does not', async () => {
	const calls: Array<string> = []
	const call = async (operationId: string, params: Record<string, unknown>) => {
		calls.push(`${operationId} ${JSON.stringify(params)}`)
		if (operationId === 'packageCollaboratorList') {
			return { package: pkg, collaborators: [team, collaborator({})] }
		}
		return { grant_id: params.grant_id, removed: true }
	}
	const removed = await runPackageCollaboratorPlan({
		plan: {
			action: 'revoke',
			packageId: 'release-notes',
			target: { kind: 'user', username: 'BOB' },
		},
		call,
		json: false,
	})
	assert.equal(
		removed,
		'Removed @bob (Bob Builder) from @acme/release-notes.\n',
	)
	await runPackageCollaboratorPlan({
		plan: {
			action: 'revoke',
			packageId: 'release-notes',
			target: { kind: 'grant', grantId: 'grant-team' },
		},
		call,
		json: false,
	})
	assert.deepEqual(calls, [
		'packageCollaboratorList {"package_id":"release-notes"}',
		'packageCollaboratorRemove {"package_id":"release-notes","grant_id":"grant-1"}',
		'packageCollaboratorRemove {"package_id":"release-notes","grant_id":"grant-team"}',
	])
	await assert.rejects(
		runPackageCollaboratorPlan({
			plan: {
				action: 'revoke',
				packageId: 'release-notes',
				target: { kind: 'team', slug: 'design' },
			},
			call,
			json: false,
		}),
		/team design is not a collaborator on @acme\/release-notes\./,
	)
})

test('kody package grant and revoke call the package-scoped routes with --org', async () => {
	clearOpenApiRouteCache()
	const previousFetch = globalThis.fetch
	const calls: Array<string> = []
	globalThis.fetch = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		const url = new URL(String(input))
		const method = (init?.method ?? 'GET').toUpperCase()
		const json = (body: unknown) =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		if (url.pathname === '/openapi.json') {
			return json({
				paths: {
					'/v1/packages/{package_id}/collaborators': {
						get: { operationId: 'packageCollaboratorList' },
						post: { operationId: 'packageCollaboratorSet' },
					},
					'/v1/packages/{package_id}/collaborators/{grant_id}': {
						delete: { operationId: 'packageCollaboratorRemove' },
					},
				},
			})
		}
		calls.push(
			`${method} ${url.pathname}${url.search} ${typeof init?.body === 'string' ? init.body : ''}`.trim(),
		)
		if (method === 'POST') return json({ package: pkg, collaborator: team })
		if (method === 'GET') return json({ package: pkg, collaborators: [team] })
		return json({ grant_id: 'grant-team', removed: true })
	}) as typeof fetch
	const run = async (args: Array<string>) => {
		let stdout = ''
		let stderr = ''
		const code = await runCli(
			[
				...args,
				'--org',
				'acme',
				'--token',
				'kody_at_test',
				'--api-url',
				'https://api.kody.codes',
				'--mcp-url',
				'https://package-collaborators.test/mcp',
			],
			{
				stdout: (text) => {
					stdout += text
				},
				stderr: (text) => {
					stderr += text
				},
			},
		)
		assert.equal(code, 0, stderr)
		return stdout
	}
	try {
		assert.equal(
			await run([
				'package',
				'grant',
				'@acme/release-notes',
				'--team',
				'writers',
				'--preset',
				'contribute',
			]),
			'writers (Writers) now has contribute on @acme/release-notes (grant grant-team).\n',
		)
		assert.equal(
			await run(['package', 'revoke', 'release-notes', '--team', 'writers']),
			'Removed writers (Writers) from @acme/release-notes.\n',
		)
		assert.deepEqual(calls, [
			'POST /v1/packages/%40acme%2Frelease-notes/collaborators?org=acme {"team_slug":"writers","preset":"contribute"}',
			'GET /v1/packages/release-notes/collaborators?org=acme',
			'DELETE /v1/packages/release-notes/collaborators/grant-team?org=acme',
		])
	} finally {
		globalThis.fetch = previousFetch
		clearOpenApiRouteCache()
	}
})

test('kody package grant --user adds an outside collaborator with Read', async () => {
	clearOpenApiRouteCache()
	const previousFetch = globalThis.fetch
	const calls: Array<string> = []
	const outside = collaborator({
		grant_id: 'grant-outside',
		kind: 'outside',
		username: 'dana',
		display_name: null,
		preset: 'read',
		permissions: ['package:read'],
	})
	globalThis.fetch = (async (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => {
		const url = new URL(String(input))
		const method = (init?.method ?? 'GET').toUpperCase()
		const json = (body: unknown) =>
			new Response(JSON.stringify(body), {
				status: 200,
				headers: { 'content-type': 'application/json' },
			})
		if (url.pathname === '/openapi.json') {
			return json({
				paths: {
					'/v1/packages/{package_id}/collaborators': {
						post: { operationId: 'packageCollaboratorSet' },
					},
				},
			})
		}
		calls.push(
			`${method} ${url.pathname}${url.search} ${typeof init?.body === 'string' ? init.body : ''}`.trim(),
		)
		return json({ package: pkg, collaborator: outside })
	}) as typeof fetch
	try {
		let stdout = ''
		let stderr = ''
		const code = await runCli(
			[
				'package',
				'grant',
				'@acme/release-notes',
				'--user',
				'@dana',
				'--preset',
				'read',
				'--token',
				'kody_at_test',
				'--api-url',
				'https://api.kody.codes',
				'--mcp-url',
				'https://package-collaborators.test/mcp',
			],
			{
				stdout: (text) => {
					stdout += text
				},
				stderr: (text) => {
					stderr += text
				},
			},
		)
		assert.equal(code, 0, stderr)
		assert.match(stdout, /@dana now has read on @acme\/release-notes/)
		assert.deepEqual(calls, [
			'POST /v1/packages/%40acme%2Frelease-notes/collaborators {"username":"dana","preset":"read"}',
		])
	} finally {
		globalThis.fetch = previousFetch
		clearOpenApiRouteCache()
	}
})
