import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	checkServerJsonVersionBump,
	classifyPublishedVersion,
	classifyServerJsonChange,
	decidePublish,
	interpretPublishError,
	isDuplicateVersionPublishError,
	main,
	resolveServerJsonValidationBase,
	parsePublishedServerResponse,
	parseServerJson,
	registryServerVersionUrl,
	serverJsonDescriptionLengthError,
	serverJsonDescriptionMaxLength,
	serverJsonEquals,
	type ServerJson,
} from './mcp-registry-publish.ts'

const localServer: ServerJson = {
	$schema: 'https://example.test/server.schema.json',
	name: 'io.github.kody-hq/kody',
	title: 'Kody',
	description: "Your agents' cloud.",
	version: '1.0.2',
	websiteUrl: 'https://kody.codes',
	repository: { url: 'https://github.com/kody-hq/kody', source: 'github' },
	remotes: [{ type: 'streamable-http', url: 'https://kody.codes/mcp' }],
}

function jsonResponse(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

test('classifies registry lookup into publish, skip, or version-bump failure', () => {
	expect(
		classifyPublishedVersion({ local: localServer, published: null }),
	).toEqual({
		action: 'publish',
		reason: 'io.github.kody-hq/kody@1.0.2 is not in the registry.',
	})
	expect(
		classifyPublishedVersion({
			local: localServer,
			published: { ...localServer },
		}),
	).toMatchObject({ action: 'skip' })
	expect(
		classifyPublishedVersion({
			local: { ...localServer, description: 'New copy' },
			published: localServer,
		}),
	).toMatchObject({ action: 'fail' })
	expect(
		classifyPublishedVersion({
			local: localServer,
			published: null,
			fetchFailed: true,
		}),
	).toMatchObject({ action: 'publish' })
})

test('server.json equality ignores key order', () => {
	const reversed: ServerJson = {
		version: '1.0.2',
		name: 'io.github.kody-hq/kody',
		remotes: localServer.remotes,
		repository: localServer.repository,
		websiteUrl: localServer.websiteUrl,
		description: localServer.description,
		title: localServer.title,
		$schema: localServer.$schema,
	}
	expect(serverJsonEquals(localServer, reversed)).toBe(true)
	expect(
		serverJsonEquals(localServer, { ...localServer, title: 'Other' }),
	).toBe(false)
})

test('metadata edits without a version bump fail the local change check', () => {
	expect(
		classifyServerJsonChange({ base: localServer, head: localServer }),
	).toBe('unchanged')
	expect(
		classifyServerJsonChange({
			base: localServer,
			head: { ...localServer, version: '1.0.3' },
		}),
	).toBe('ok')
	expect(
		classifyServerJsonChange({
			base: localServer,
			head: { ...localServer, description: 'New copy' },
		}),
	).toBe('needs-version-bump')
	expect(
		classifyServerJsonChange({
			base: null,
			head: localServer,
		}),
	).toBe('ok')
})

test('parses registry payloads and encodes the version URL', () => {
	expect(registryServerVersionUrl('io.github.kody-hq/kody', '1.0.3')).toBe(
		'https://registry.modelcontextprotocol.io/v0.1/servers/io.github.kody-hq%2Fkody/versions/1.0.3',
	)
	expect(
		parsePublishedServerResponse({
			server: localServer,
			_meta: { extra: true },
		}),
	).toEqual(localServer)
	expect(parsePublishedServerResponse(localServer)).toEqual(localServer)
	expect(() => parseServerJson('[]')).toThrow(/JSON object/)
	expect(() => parseServerJson('{"name":"x"}')).toThrow(/version/)
	expect(() => parseServerJson('{"name":"x","version":"1.0.0"}')).toThrow(
		/description/,
	)
	expect(
		parseServerJson(
			JSON.stringify({
				...localServer,
				description: 'x'.repeat(serverJsonDescriptionMaxLength + 1),
			}),
		).description,
	).toBe('x'.repeat(serverJsonDescriptionMaxLength + 1))
})

test('MCP Registry description limit is enforced on the local payload only', async () => {
	const tooLong = 'x'.repeat(serverJsonDescriptionMaxLength + 1)
	expect(
		serverJsonDescriptionLengthError(
			'x'.repeat(serverJsonDescriptionMaxLength),
		),
	).toBeNull()
	expect(serverJsonDescriptionLengthError(tooLong)).toMatch(/100/)

	const checkedIn = parseServerJson(readFileSync('server.json', 'utf8'))
	expect(typeof checkedIn.description).toBe('string')
	expect(
		serverJsonDescriptionLengthError(checkedIn.description as string),
	).toBe(null)

	const rejected = await decidePublish({
		local: { ...localServer, description: tooLong },
		fetchImpl: async () => {
			throw new Error('should not look up a too-long description')
		},
	})
	expect(rejected).toMatchObject({ action: 'fail' })

	const invalid = await checkServerJsonVersionBump({
		head: { ...localServer, description: tooLong },
		env: {},
		git: async () => null,
	})
	expect(invalid).toMatchObject({ ok: false, kind: 'invalid-description' })
})

test('decidePublish skips a matching published version and publishes a 404', async () => {
	const skip = await decidePublish({
		local: localServer,
		fetchImpl: async () => jsonResponse(200, { server: localServer }),
	})
	expect(skip.action).toBe('skip')

	const missing = await decidePublish({
		local: localServer,
		fetchImpl: async () => jsonResponse(404, { title: 'Not Found' }),
	})
	expect(missing.action).toBe('publish')

	const drift = await decidePublish({
		local: { ...localServer, description: 'New copy' },
		fetchImpl: async () => jsonResponse(200, { server: localServer }),
	})
	expect(drift.action).toBe('fail')

	const lookupFailed = await decidePublish({
		local: localServer,
		fetchImpl: async () => jsonResponse(503, { title: 'Unavailable' }),
	})
	expect(lookupFailed.action).toBe('publish')
})

test('duplicate publisher output is success only when the published payload matches', async () => {
	const duplicateText =
		'Error: publish failed: server returned status 400: {"errors":[{"message":"invalid version: cannot publish duplicate version"}]}'
	expect(isDuplicateVersionPublishError(duplicateText)).toBe(true)
	expect(isDuplicateVersionPublishError('unauthorized')).toBe(false)

	const match = await interpretPublishError({
		text: duplicateText,
		local: localServer,
		fetchImpl: async () => jsonResponse(200, { server: localServer }),
	})
	expect(match.action).toBe('skip')

	const drift = await interpretPublishError({
		text: duplicateText,
		local: { ...localServer, description: 'New copy' },
		fetchImpl: async () => jsonResponse(200, { server: localServer }),
	})
	expect(drift.action).toBe('fail')

	const lookupFailed = await interpretPublishError({
		text: duplicateText,
		local: localServer,
		fetchImpl: async () => jsonResponse(503, { title: 'Unavailable' }),
	})
	expect(lookupFailed.action).toBe('fail')

	const missing = await interpretPublishError({
		text: duplicateText,
		local: localServer,
		fetchImpl: async () => jsonResponse(404, { title: 'Not Found' }),
	})
	expect(missing.action).toBe('fail')

	const other = await interpretPublishError({
		text: 'unauthorized',
		local: localServer,
		fetchImpl: async () => {
			throw new Error('should not look up')
		},
	})
	expect(other).toEqual({ action: 'fail', reason: 'unauthorized' })
})

test('checkServerJsonVersionBump reports metadata drift against the Git base', async () => {
	const git = async (args: ReadonlyArray<string>) => {
		const command = args.join(' ')
		if (command === 'rev-parse HEAD^{commit}') return 'head\n'
		if (command === 'rev-parse base^{commit}') return 'base\n'
		if (command === 'show base:server.json') {
			return `${JSON.stringify(localServer, null, '\t')}\n`
		}
		return null
	}

	const unchanged = await checkServerJsonVersionBump({
		head: localServer,
		env: { MCP_REGISTRY_VALIDATION_BASE: 'base' },
		git,
	})
	expect(unchanged).toMatchObject({ ok: true, kind: 'unchanged' })

	const bumped = await checkServerJsonVersionBump({
		head: { ...localServer, version: '1.0.3', description: 'New copy' },
		env: { MCP_REGISTRY_VALIDATION_BASE: 'base' },
		git,
	})
	expect(bumped).toMatchObject({ ok: true, kind: 'ok' })

	const drift = await checkServerJsonVersionBump({
		head: { ...localServer, description: 'New copy' },
		env: { MCP_REGISTRY_VALIDATION_BASE: 'base' },
		git,
	})
	expect(drift).toMatchObject({ ok: false, kind: 'needs-version-bump' })

	const skipped = await checkServerJsonVersionBump({
		head: localServer,
		env: {},
		git: async () => null,
	})
	expect(skipped).toMatchObject({ ok: true, kind: 'skipped' })

	const multiCommitPush = await checkServerJsonVersionBump({
		head: { ...localServer, version: '1.0.4', description: 'New copy' },
		env: { MCP_REGISTRY_VALIDATION_BASE: 'base' },
		git,
	})
	expect(multiCommitPush).toMatchObject({ ok: true, kind: 'ok' })
})

test('resolveServerJsonValidationBase prefers the explicit pre-push SHA over HEAD^1', async () => {
	const git = async (args: ReadonlyArray<string>) => {
		const command = args.join(' ')
		if (command === 'rev-parse HEAD^{commit}') return 'head\n'
		if (command === 'rev-parse before^{commit}') return 'before\n'
		if (command === 'rev-parse HEAD^1') return 'parent\n'
		if (command === 'merge-base HEAD origin/main') return 'head\n'
		if (command === 'merge-base HEAD main') return 'head\n'
		return null
	}
	await expect(
		resolveServerJsonValidationBase({
			env: { MCP_REGISTRY_VALIDATION_BASE: 'before' },
			git,
		}),
	).resolves.toBe('before')
})

test('CLI decide and interpret-error write the workflow contract', async () => {
	const previousExitCode = process.exitCode
	const dir = mkdtempSync(path.join(tmpdir(), 'mcp-registry-publish-'))
	const outputPath = path.join(dir, 'github-output')
	writeFileSync(outputPath, '')
	const previousOutput = process.env.GITHUB_OUTPUT
	process.env.GITHUB_OUTPUT = outputPath

	consoleError.mockImplementation(() => {})
	process.exitCode = undefined
	await main(['interpret-error', '--text', 'unauthorized'])
	expect(process.exitCode).toBe(1)
	expect(consoleError).toHaveBeenCalled()

	process.exitCode = undefined
	await main([])
	expect(process.exitCode).toBe(1)

	if (previousOutput === undefined) {
		delete process.env.GITHUB_OUTPUT
	} else {
		process.env.GITHUB_OUTPUT = previousOutput
	}
	process.exitCode = previousExitCode
	expect(readFileSync(outputPath, 'utf8')).toBe('')
})
