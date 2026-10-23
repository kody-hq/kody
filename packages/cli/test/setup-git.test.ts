import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	apiTokenNeedsRefresh,
	assertUserOwnedTokensLive,
	authRemoveGit,
	authSetupGit,
	cliExactVersionForNpx,
	cliVersionSupportsGitCredential,
	decideSetupGitToken,
	describeKodyCredentialKind,
	ensureSetupGitScopes,
	exactNpxHelperVersion,
	formatAuthRemoveGitReport,
	gitCredentialHelperCommand,
	gitCredentialHelperNeedsRepair,
	gitCredentialHostFromMcpUrl,
	isEphemeralNpxEntryPath,
	isKodyGitCredentialHelperValue,
	isMajorOnlyNpxHelper,
	installGitCredentialConfig,
	refreshGitCredentialHelperPinIfNeeded,
	scopesIncludeRequired,
	setupGitDefaultScopes,
	setupGitRequiredScopes,
} from '../src/setup-git.js'
import {
	loadStoredApiToken,
	type StoredApiToken,
} from '../src/api-token-store.js'
import { resolveCliTokenLifetime } from '../src/auth-bootstrap.js'
import {
	ensureGitApiToken,
	formatGitCredentialOutput,
	isKodyGitHttpsHost,
	parseGitCredentialAction,
	parseGitCredentialInput,
	handleGitCredential,
} from '../src/git-credential.js'
import { resolveCommand } from '../src/cli.js'
import { createFileBackend } from '../src/store.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sampleStored = (scopes: Array<string>): StoredApiToken => ({
	version: 1,
	apiUrl: 'https://api.kody.codes',
	token: `kody_at_${'a'.repeat(20)}_${'B'.repeat(43)}`,
	tokenId: 'tok_1',
	scopes,
	createdVia: 'cli-bootstrap',
})

test('resolveCommand maps auth setup-git, remove-git, and git-credential', () => {
	assert.equal(resolveCommand(['auth', 'setup-git']).command, 'auth')
	assert.equal(
		resolveCommand(['auth', 'setup-git']).positionals[0],
		'setup-git',
	)
	assert.equal(
		resolveCommand(['auth', 'remove-git']).positionals[0],
		'remove-git',
	)
	assert.equal(
		resolveCommand(['git-credential', 'get']).command,
		'git-credential',
	)
	assert.equal(resolveCommand(['git-credential', 'get']).positionals[0], 'get')
})

test('gitCredentialHostFromMcpUrl uses the MCP origin host', () => {
	assert.equal(
		gitCredentialHostFromMcpUrl('https://kody.codes/mcp'),
		'kody.codes',
	)
	assert.equal(
		gitCredentialHostFromMcpUrl(
			'https://kody-pr-3572.kody-a99.workers.dev/mcp',
		),
		'kody-pr-3572.kody-a99.workers.dev',
	)
})

test('scopesIncludeRequired and ensureSetupGitScopes', () => {
	assert.equal(scopesIncludeRequired(['package:read', 'package:write']), true)
	assert.equal(scopesIncludeRequired(['package:read']), false)
	assert.deepEqual(ensureSetupGitScopes(['org:read']), [
		'org:read',
		'package:read',
		'package:write',
	])
	for (const scope of setupGitRequiredScopes) {
		assert.ok(setupGitDefaultScopes.includes(scope))
	}
})

test('assertUserOwnedTokensLive rejects missing org_binding', () => {
	assert.throws(
		() =>
			assertUserOwnedTokensLive({
				id: 't',
				orgBinding: null,
				scopes: [...setupGitRequiredScopes],
				expiresAt: null,
			}),
		/org_binding/,
	)
	assert.doesNotThrow(() =>
		assertUserOwnedTokensLive({
			id: 't',
			orgBinding: 'user',
			scopes: [...setupGitRequiredScopes],
			expiresAt: null,
		}),
	)
})

test('decideSetupGitToken reuses a suitable user-owned token', () => {
	const stored = sampleStored(['package:read', 'package:write', 'org:execute'])
	const decision = decideSetupGitToken({
		stored,
		metadata: {
			id: stored.tokenId,
			orgBinding: 'user',
			scopes: stored.scopes!,
			expiresAt: null,
		},
	})
	assert.equal(decision.action, 'reuse')
})

test('decideSetupGitToken mints when package scopes are missing', () => {
	const stored = sampleStored(['org:execute', 'org:read'])
	const decision = decideSetupGitToken({
		stored,
		metadata: {
			id: stored.tokenId,
			orgBinding: 'user',
			scopes: stored.scopes!,
			expiresAt: null,
		},
	})
	assert.equal(decision.action, 'mint')
	if (decision.action === 'mint') {
		assert.ok(decision.scopes.includes('package:read'))
		assert.ok(decision.scopes.includes('package:write'))
		assert.ok(decision.scopes.includes('org:execute'))
		assert.equal(decision.lifetime.kind, 'alias')
		if (decision.lifetime.kind === 'alias') {
			assert.equal(decision.lifetime.lifetime, 'long')
		}
	}
})

test('installGitCredentialConfig writes helper + useHttpPath', () => {
	const calls: Array<Array<string>> = []
	const installed = installGitCredentialConfig({
		host: 'kody.codes',
		helperCommand: '!kody git-credential',
		runGit: (args) => {
			calls.push([...args])
			return { status: 0, stderr: '' }
		},
	})
	assert.equal(installed.scope, '--global')
	assert.deepEqual(calls, [
		[
			'config',
			'--global',
			'credential.https://kody.codes.helper',
			'!kody git-credential',
		],
		['config', '--global', 'credential.https://kody.codes.useHttpPath', 'true'],
	])
})

test('gitCredentialHelperCommand prefers version-capable global or exact npx pin', () => {
	assert.equal(
		isEphemeralNpxEntryPath(
			'/Users/kent/.npm/_npx/4309649e9362ebcf/node_modules/.bin/kody',
		),
		true,
	)
	assert.equal(isEphemeralNpxEntryPath('/usr/local/bin/kody'), false)
	assert.equal(cliExactVersionForNpx('1.16.5'), '1.16.5')
	assert.equal(cliExactVersionForNpx('0.0.0-semantically-released'), '1.18.0')
	assert.equal(cliVersionSupportsGitCredential('1.16.0'), true)
	assert.equal(cliVersionSupportsGitCredential('1.1.0'), false)

	const stableEntry = gitCredentialHelperCommand({
		execPath: '/usr/bin/node',
		entryPath: '/tmp/kody-bot-cli/dist/bin.js',
		which: () => undefined,
	})
	assert.equal(
		stableEntry,
		'!/usr/bin/node /tmp/kody-bot-cli/dist/bin.js git-credential',
	)

	const globalKody = gitCredentialHelperCommand({
		entryPath: '/Users/kent/.npm/_npx/abc/node_modules/.bin/kody',
		which: () => '/usr/local/bin/kody',
		readKodyVersion: () => '1.16.5',
	})
	assert.equal(globalKody, '!/usr/local/bin/kody git-credential')

	const staleGlobal = gitCredentialHelperCommand({
		entryPath: '/Users/kent/.npm/_npx/abc/node_modules/.bin/kody',
		which: () => '/usr/local/bin/kody',
		readKodyVersion: () => '1.1.0',
		packageVersion: '1.16.5',
	})
	assert.equal(staleGlobal, '!npx -y @kodycodes/cli@1.16.5 git-credential')

	const npxPinned = gitCredentialHelperCommand({
		entryPath: '/Users/kent/.npm/_npx/abc/node_modules/.bin/kody',
		which: () => undefined,
		packageVersion: '1.16.5',
	})
	assert.equal(npxPinned, '!npx -y @kodycodes/cli@1.16.5 git-credential')
})

test('gitCredentialHelperNeedsRepair detects major-only, ephemeral, and outdated pins', () => {
	assert.equal(
		isMajorOnlyNpxHelper('!npx -y @kodycodes/cli@1 git-credential'),
		true,
	)
	assert.equal(
		exactNpxHelperVersion('!npx -y @kodycodes/cli@1.16.4 git-credential'),
		'1.16.4',
	)
	assert.equal(
		gitCredentialHelperNeedsRepair({
			helper: '!npx -y @kodycodes/cli@1 git-credential',
			packageVersion: '1.16.5',
		}),
		true,
	)
	assert.equal(
		gitCredentialHelperNeedsRepair({
			helper:
				'!/Users/kent/.npm/_npx/abc/node_modules/.bin/kody git-credential',
			packageVersion: '1.16.5',
		}),
		true,
	)
	assert.equal(
		gitCredentialHelperNeedsRepair({
			helper: '!npx -y @kodycodes/cli@1.16.4 git-credential',
			packageVersion: '1.16.5',
		}),
		true,
	)
	assert.equal(
		gitCredentialHelperNeedsRepair({
			helper: '!npx -y @kodycodes/cli@1.16.5 git-credential',
			packageVersion: '1.16.5',
		}),
		false,
	)
	assert.equal(
		gitCredentialHelperNeedsRepair({
			helper: '!/usr/local/bin/kody git-credential',
			packageVersion: '1.16.5',
			readKodyVersion: () => '1.1.0',
			probeBinaryVersion: true,
		}),
		true,
	)
	assert.equal(
		gitCredentialHelperNeedsRepair({
			helper: '!/usr/local/bin/kody git-credential',
			packageVersion: '1.16.5',
			readKodyVersion: () => '1.16.5',
			probeBinaryVersion: true,
		}),
		false,
	)
	// Hot path must not spawn --version for path helpers (was an 8–20s stall).
	assert.equal(
		gitCredentialHelperNeedsRepair({
			helper: '!/usr/local/bin/kody git-credential',
			packageVersion: '1.16.5',
			readKodyVersion: () => {
				throw new Error('must not probe on hot path')
			},
		}),
		false,
	)
})

test('refreshGitCredentialHelperPinIfNeeded rewrites major-only pins', () => {
	const writes: Array<Array<string>> = []
	const refreshed = refreshGitCredentialHelperPinIfNeeded({
		mcpUrl: 'https://kody.codes/mcp',
		packageVersion: '1.16.5',
		which: () => undefined,
		entryPath: '/Users/kent/.npm/_npx/abc/node_modules/.bin/kody',
		runGitGet: () => ({
			status: 0,
			stdout: '!npx -y @kodycodes/cli@1 git-credential',
			stderr: '',
		}),
		runGit: (args) => {
			writes.push([...args])
			return { status: 0, stderr: '' }
		},
	})
	assert.equal(refreshed, true)
	assert.deepEqual(writes[0], [
		'config',
		'--global',
		'credential.https://kody.codes.helper',
		'!npx -y @kodycodes/cli@1.16.5 git-credential',
	])
})

test('apiTokenNeedsRefresh treats expired and near-expiry tokens', () => {
	const now = Date.parse('2026-10-13T19:00:00.000Z')
	assert.equal(apiTokenNeedsRefresh(null, now), true)
	assert.equal(
		apiTokenNeedsRefresh({ expiresAt: '2026-10-13T18:00:00.000Z' }, now),
		true,
	)
	assert.equal(
		apiTokenNeedsRefresh({ expiresAt: '2026-10-13T19:30:00.000Z' }, now),
		true,
	)
	assert.equal(
		apiTokenNeedsRefresh({ expiresAt: '2026-10-14T19:00:00.000Z' }, now),
		false,
	)
	assert.equal(apiTokenNeedsRefresh({ expiresAt: null }, now), false)
})

test('parseGitCredentialInput and get output', async () => {
	const req = parseGitCredentialInput(
		'protocol=https\nhost=kody.codes\npath=@kent/pkg.git\n\n',
	)
	assert.deepEqual(req, {
		protocol: 'https',
		host: 'kody.codes',
		path: '@kent/pkg.git',
	})
	assert.equal(parseGitCredentialAction(['get']), 'get')
	assert.throws(() => parseGitCredentialAction([]), /Usage/)
	assert.equal(
		formatGitCredentialOutput({ username: 'x', password: 'kody_at_abc' }),
		'username=x\npassword=kody_at_abc\n',
	)
	assert.equal(
		isKodyGitHttpsHost({
			protocol: 'https',
			host: 'kody.codes',
			expectedHost: 'kody.codes',
		}),
		true,
	)
	assert.equal(
		isKodyGitHttpsHost({
			protocol: 'https',
			host: 'github.com',
			expectedHost: 'kody.codes',
		}),
		false,
	)

	const emptyDir = mkdtempSync(join(tmpdir(), 'kody-git-cred-'))
	const emptyBackend = createFileBackend(join(emptyDir, 'empty-token.json'))
	const empty = await handleGitCredential({
		action: 'get',
		request: { protocol: 'https', host: 'github.com' },
		apiUrl: 'https://api.example.test',
		mcpUrl: 'https://kody.codes/mcp',
		backend: emptyBackend,
	})
	assert.equal(empty, '')

	const tokenPath = join(emptyDir, 'token.json')
	const stored = sampleStored(['package:read', 'package:write'])
	writeFileSync(tokenPath, JSON.stringify(stored))
	const filled = await handleGitCredential({
		action: 'get',
		request: { protocol: 'https', host: 'kody.codes', path: '@a/b.git' },
		apiUrl: stored.apiUrl,
		mcpUrl: 'https://kody.codes/mcp',
		backend: createFileBackend(tokenPath),
		loadLogin: () => null,
	})
	assert.equal(
		filled,
		formatGitCredentialOutput({ username: 'x', password: stored.token }),
	)
})

test('git-credential silently remints an expired token via login', async () => {
	const home = mkdtempSync(join(tmpdir(), 'kody-git-refresh-'))
	const tokenPath = join(home, 'token.json')
	const expired = {
		...sampleStored(['package:read', 'package:write', 'org:execute']),
		expiresAt: '2020-01-01T00:00:00.000Z',
		tokenId: 'tok_expired',
	}
	writeFileSync(tokenPath, JSON.stringify(expired))
	const backend = createFileBackend(tokenPath)
	const freshToken = `kody_at_${'f'.repeat(20)}_${'G'.repeat(43)}`
	let mintCalls = 0
	const login = {
		version: 1 as const,
		mcpUrl: 'https://kody.codes/mcp',
		resource: 'https://kody.codes/mcp',
		authorizationServerUrl: 'https://kody.codes',
		clientId: 'c',
		accessToken: 'oauth',
		tokenType: 'bearer',
	}

	const previousFetch = globalThis.fetch
	globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
		const url = String(input instanceof Request ? input.url : input)
		if (url.endsWith('/v1/tokens/bootstrap/redeem')) {
			return new Response(
				JSON.stringify({
					token: freshToken,
					id: 'tok_fresh',
					name: 'kody-cli-bootstrap',
					scopes: expired.scopes,
					expires_at: '2026-11-01T00:00:00.000Z',
					max_expires_at: '2027-01-01T00:00:00.000Z',
					created_via: 'cli-bootstrap',
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } },
			)
		}
		return new Response(JSON.stringify({ error: { message: url } }), {
			status: 404,
			headers: { 'content-type': 'application/json' },
		})
	}) as typeof fetch

	try {
		const out = await handleGitCredential({
			action: 'get',
			request: { protocol: 'https', host: 'kody.codes', path: '@a/b.git' },
			apiUrl: expired.apiUrl,
			mcpUrl: 'https://kody.codes/mcp',
			backend,
			nowMs: Date.parse('2026-10-13T19:00:00.000Z'),
			loadLogin: () => login,
			mint: async () => {
				mintCalls += 1
				return {
					bootstrap_code: `kody_bc_${'c'.repeat(16)}_${'D'.repeat(32)}`,
					scopes: expired.scopes,
					idle_ttl_seconds: 1_209_600,
					max_lifetime_seconds: 7_776_000,
				}
			},
		})
		assert.equal(
			out,
			formatGitCredentialOutput({ username: 'x', password: freshToken }),
		)
		assert.equal(mintCalls, 1)
		assert.equal(
			loadStoredApiToken(expired.apiUrl, backend)?.tokenId,
			'tok_fresh',
		)
		assert.equal(loadStoredApiToken(expired.apiUrl, backend)?.token, freshToken)

		// Fresh token should not remint again.
		const again = await ensureGitApiToken({
			apiUrl: expired.apiUrl,
			mcpUrl: 'https://kody.codes/mcp',
			backend,
			nowMs: Date.parse('2026-10-13T19:00:00.000Z'),
			loadLogin: () => login,
			mint: async () => {
				mintCalls += 1
				throw new Error('should not mint')
			},
		})
		assert.equal(again?.refreshed, false)
		assert.equal(mintCalls, 1)
	} finally {
		globalThis.fetch = previousFetch
	}
})

test('authSetupGit with login session and no API token mints then installs helper', async () => {
	const home = mkdtempSync(join(tmpdir(), 'kody-setup-git-login-'))
	const tokenBackend = createFileBackend(join(home, 'api-token.json'))
	const mintedToken = `kody_at_${'m'.repeat(20)}_${'N'.repeat(43)}`
	const mintCalls: Array<Record<string, unknown>> = []
	const gitCalls: Array<Array<string>> = []
	const currentCalls: Array<string> = []

	const result = await authSetupGit({
		apiUrl: 'https://api.setup-git-login.test',
		mcpUrl: 'https://kody.codes/mcp',
		hasLoginSession: true,
		lifetime: resolveCliTokenLifetime({ lifetime: 'long' }),
		backend: tokenBackend,
		helperCommand: '!kody git-credential',
		runGit: (args) => {
			gitCalls.push([...args])
			return { status: 0, stderr: '' }
		},
		mint: async (params) => {
			mintCalls.push(params)
			return {
				bootstrap_code: `kody_bc_${'c'.repeat(16)}_${'D'.repeat(32)}`,
				scopes: setupGitDefaultScopes,
				idle_ttl_seconds: 1_209_600,
				max_lifetime_seconds: 7_776_000,
			}
		},
		fetchFn: (async (
			input: Parameters<typeof fetch>[0],
			init?: RequestInit,
		) => {
			const url = String(input instanceof Request ? input.url : input)
			if (url.endsWith('/v1/tokens/bootstrap/redeem')) {
				return new Response(
					JSON.stringify({
						token: mintedToken,
						id: 'tok_login_mint',
						name: 'kody-cli-bootstrap',
						scopes: [...setupGitDefaultScopes],
						expires_at: '2026-11-01T00:00:00.000Z',
						max_expires_at: '2027-01-01T00:00:00.000Z',
						created_via: 'cli-bootstrap',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				)
			}
			if (url.includes('/v1/tokens/current')) {
				currentCalls.push(url)
				return new Response(
					JSON.stringify({
						id: 'tok_login_mint',
						org_binding: 'user',
						scopes: [...setupGitDefaultScopes],
						expires_at: '2026-11-01T00:00:00.000Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				)
			}
			return new Response(JSON.stringify({ error: { message: url } }), {
				status: 404,
				headers: { 'content-type': 'application/json' },
			})
		}) as typeof fetch,
	})

	assert.equal(result.minted, true)
	assert.equal(result.tokenId, 'tok_login_mint')
	assert.equal(result.orgBinding, 'user')
	assert.equal(mintCalls.length, 1)
	assert.deepEqual(mintCalls[0]?.lifetime, 'long')
	assert.ok(
		(mintCalls[0]?.scopes as Array<string>).includes('package:read') &&
			(mintCalls[0]?.scopes as Array<string>).includes('package:write'),
	)
	// Login OAuth cannot probe /tokens/current; only the minted token is checked.
	assert.equal(currentCalls.length, 1)
	assert.ok(currentCalls[0]?.includes('/v1/tokens/current'))
	assert.equal(gitCalls.length, 2)
	assert.equal(
		loadStoredApiToken('https://api.setup-git-login.test', tokenBackend)?.token,
		mintedToken,
	)
})

test('authSetupGit without login or API token fails with login guidance', async () => {
	const home = mkdtempSync(join(tmpdir(), 'kody-setup-git-empty-'))
	await assert.rejects(
		() =>
			authSetupGit({
				apiUrl: 'https://api.setup-git-empty.test',
				mcpUrl: 'https://kody.codes/mcp',
				hasLoginSession: false,
				backend: createFileBackend(join(home, 'missing.json')),
				mint: async () => {
					throw new Error('mint should not run')
				},
				runGit: () => ({ status: 0, stderr: '' }),
			}),
		/Run `kody login`/,
	)
})

test('isKodyGitCredentialHelperValue recognizes npx pins and kody helpers', () => {
	assert.equal(
		isKodyGitCredentialHelperValue('!npx -y @kodycodes/cli@1 git-credential'),
		true,
	)
	assert.equal(
		isKodyGitCredentialHelperValue(
			'!npx -y @kodycodes/cli@1.16.5 git-credential',
		),
		true,
	)
	assert.equal(
		isKodyGitCredentialHelperValue(
			'!/Users/kent/.npm/_npx/abc/node_modules/.bin/kody git-credential',
		),
		true,
	)
	assert.equal(
		isKodyGitCredentialHelperValue('!/usr/local/bin/kody git-credential'),
		true,
	)
	assert.equal(isKodyGitCredentialHelperValue('osxkeychain'), false)
})

test('authRemoveGit clears helpers, revokes token, deletes store; idempotent when empty', async () => {
	const home = mkdtempSync(join(tmpdir(), 'kody-remove-git-'))
	const tokenPath = join(home, 'token.json')
	const stored = {
		...sampleStored(['package:read', 'package:write', 'token:delete']),
		apiUrl: 'https://api.remove-git.test',
		tokenId: 'tok_remove',
	}
	writeFileSync(tokenPath, JSON.stringify(stored))
	const backend = createFileBackend(tokenPath)
	const unsets: Array<Array<string>> = []
	const config: Record<string, string> = {
		'--global\tcredential.https://kody.codes.helper':
			'!npx -y @kodycodes/cli@1 git-credential',
		'--global\tcredential.https://kody.codes.useHttpPath': 'true',
		'--local\tcredential.https://kody.codes.helper':
			'!/Users/kent/.npm/_npx/old/node_modules/.bin/kody git-credential',
	}

	let revokeCalls = 0
	const result = await authRemoveGit({
		apiUrl: stored.apiUrl,
		mcpUrl: 'https://kody.codes/mcp',
		backend,
		runGitGet: (args) => {
			const scope = args[1] as string
			const mode = args[2]
			const key = args[3] as string
			if (mode === '--get-all') {
				const value = config[`${scope}\t${key}`]
				if (!value) return { status: 1, stdout: '', stderr: '' }
				return { status: 0, stdout: value, stderr: '' }
			}
			return { status: 1, stdout: '', stderr: '' }
		},
		runGit: (args) => {
			unsets.push([...args])
			if (args[2] === '--unset-all') {
				delete config[`${args[1]}\t${args[3]}`]
			}
			return { status: 0, stderr: '' }
		},
		fetchFn: (async (
			input: Parameters<typeof fetch>[0],
			init?: RequestInit,
		) => {
			const url = String(input instanceof Request ? input.url : input)
			assert.equal(init?.method, 'DELETE')
			assert.ok(url.endsWith('/v1/tokens/current'))
			revokeCalls += 1
			return new Response(null, { status: 204 })
		}) as typeof fetch,
	})

	assert.equal(result.removedHelpers.length, 2)
	assert.ok(
		result.removedHelpers.some((entry) =>
			entry.value.includes('@kodycodes/cli@1'),
		),
	)
	assert.ok(
		result.removedHelpers.some((entry) => entry.value.includes('/_npx/')),
	)
	assert.equal(result.removedPathKeys.length, 1)
	assert.equal(result.tokenRevoked, 'yes')
	assert.equal(result.tokenId, 'tok_remove')
	assert.equal(result.tokenDeletedLocally, true)
	assert.equal(revokeCalls, 1)
	assert.equal(loadStoredApiToken(stored.apiUrl, backend), null)
	assert.match(
		formatAuthRemoveGitReport(result),
		/Removed Kody Git HTTPS setup/,
	)
	assert.match(
		formatAuthRemoveGitReport(result),
		/Left kody login sessions alone/,
	)

	const empty = await authRemoveGit({
		apiUrl: 'https://api.remove-git-empty.test',
		mcpUrl: 'https://kody.codes/mcp',
		backend: createFileBackend(join(home, 'missing.json')),
		runGitGet: () => ({ status: 1, stdout: '', stderr: '' }),
		runGit: () => ({ status: 1, stderr: 'not found' }),
	})
	assert.equal(empty.removedHelpers.length, 0)
	assert.equal(empty.tokenRevoked, 'skipped')
	assert.equal(empty.tokenDeletedLocally, false)
	assert.match(formatAuthRemoveGitReport(empty), /Nothing to remove/)
})

test('describeKodyCredentialKind names the kind without echoing the value', () => {
	const apiToken = `kody_at_${'s'.repeat(20)}_${'T'.repeat(43)}`
	const code = `kody_bc_${'c'.repeat(16)}_${'D'.repeat(32)}`
	assert.match(describeKodyCredentialKind(apiToken), /API token \(kody_at_\)/)
	assert.match(describeKodyCredentialKind(code), /bootstrap code \(kody_bc_\)/)
	assert.match(
		describeKodyCredentialKind('oauth-access-xyz'),
		/not a Kody API token/,
	)
	for (const value of [apiToken, code, 'oauth-access-xyz']) {
		assert.ok(!describeKodyCredentialKind(value).includes(value))
	}
})

const unauthorizedFetch = (async (input: Parameters<typeof fetch>[0]) => {
	const url = String(input instanceof Request ? input.url : input)
	if (url.includes('/v1/tokens/current')) {
		return new Response(
			JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }),
			{ status: 401, headers: { 'content-type': 'application/json' } },
		)
	}
	return new Response('{}', { status: 404 })
}) as typeof fetch

test('authSetupGit 401 on a --token bootstrap code says what was rejected and how to fix it', async () => {
	const home = mkdtempSync(join(tmpdir(), 'kody-setup-git-401-flag-'))
	const code = `kody_bc_${'c'.repeat(16)}_${'D'.repeat(32)}`
	await assert.rejects(
		() =>
			authSetupGit({
				apiUrl: 'https://api.setup-git-401.test',
				mcpUrl: 'https://kody.codes/mcp',
				token: code,
				hasLoginSession: true,
				backend: createFileBackend(join(home, 'missing.json')),
				mint: async () => {
					throw new Error('mint should not run')
				},
				runGit: () => ({ status: 0, stderr: '' }),
				fetchFn: unauthorizedFetch,
			}),
		(error: unknown) => {
			assert.ok(error instanceof Error)
			assert.match(error.message, /bootstrap code \(kody_bc_\)/)
			assert.match(error.message, /passed with --token/)
			assert.match(error.message, /kody auth bootstrap/)
			assert.ok(!error.message.includes(code))
			return true
		},
	)
})

test('authSetupGit 401 on a stored token without login tells the user to run kody login', async () => {
	const home = mkdtempSync(join(tmpdir(), 'kody-setup-git-401-stored-'))
	const tokenPath = join(home, 'api-token.json')
	const stored = {
		...sampleStored([...setupGitRequiredScopes]),
		apiUrl: 'https://api.setup-git-401.test',
	}
	writeFileSync(tokenPath, JSON.stringify(stored))
	await assert.rejects(
		() =>
			authSetupGit({
				apiUrl: 'https://api.setup-git-401.test',
				mcpUrl: 'https://kody.codes/mcp',
				hasLoginSession: false,
				backend: createFileBackend(tokenPath),
				mint: async () => {
					throw new Error('mint should not run')
				},
				runGit: () => ({ status: 0, stderr: '' }),
				fetchFn: unauthorizedFetch,
			}),
		(error: unknown) => {
			assert.ok(error instanceof Error)
			assert.match(error.message, /Kody API token \(kody_at_\)/)
			assert.match(error.message, /stored on this computer/)
			assert.match(error.message, /Run `kody login`/)
			assert.ok(!error.message.includes(stored.token))
			return true
		},
	)
})

test('authSetupGit 401 on a stored token with a login session mints a fresh token', async () => {
	const home = mkdtempSync(join(tmpdir(), 'kody-setup-git-401-remint-'))
	const tokenPath = join(home, 'api-token.json')
	const apiUrl = 'https://api.setup-git-401-remint.test'
	const deadToken = `kody_at_${'d'.repeat(20)}_${'E'.repeat(43)}`
	const freshToken = `kody_at_${'f'.repeat(20)}_${'G'.repeat(43)}`
	writeFileSync(
		tokenPath,
		JSON.stringify({
			...sampleStored([...setupGitRequiredScopes]),
			apiUrl,
			token: deadToken,
		}),
	)
	let mints = 0
	const result = await authSetupGit({
		apiUrl,
		mcpUrl: 'https://kody.codes/mcp',
		hasLoginSession: true,
		lifetime: resolveCliTokenLifetime({ lifetime: 'long' }),
		backend: createFileBackend(tokenPath),
		helperCommand: '!kody git-credential',
		runGit: () => ({ status: 0, stderr: '' }),
		mint: async () => {
			mints += 1
			return {
				bootstrap_code: `kody_bc_${'c'.repeat(16)}_${'D'.repeat(32)}`,
				scopes: setupGitDefaultScopes,
				idle_ttl_seconds: 1_209_600,
				max_lifetime_seconds: 7_776_000,
			}
		},
		fetchFn: (async (
			input: Parameters<typeof fetch>[0],
			init?: RequestInit,
		) => {
			const url = String(input instanceof Request ? input.url : input)
			if (url.endsWith('/v1/tokens/bootstrap/redeem')) {
				return new Response(
					JSON.stringify({
						token: freshToken,
						id: 'tok_fresh',
						name: 'kody-cli-bootstrap',
						scopes: [...setupGitDefaultScopes],
						expires_at: '2026-11-01T00:00:00.000Z',
						max_expires_at: '2027-01-01T00:00:00.000Z',
						created_via: 'cli-bootstrap',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				)
			}
			if (url.includes('/v1/tokens/current')) {
				const auth = new Headers(init?.headers).get('authorization') ?? ''
				if (auth.includes(deadToken)) {
					return new Response(
						JSON.stringify({ error: { code: 'unauthorized', message: 'no' } }),
						{ status: 401, headers: { 'content-type': 'application/json' } },
					)
				}
				return new Response(
					JSON.stringify({
						id: 'tok_fresh',
						org_binding: 'user',
						scopes: [...setupGitDefaultScopes],
						expires_at: '2026-11-01T00:00:00.000Z',
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } },
				)
			}
			return new Response('{}', { status: 404 })
		}) as typeof fetch,
	})
	assert.equal(mints, 1)
	assert.equal(result.minted, true)
	assert.equal(result.tokenId, 'tok_fresh')
	assert.equal(
		loadStoredApiToken(apiUrl, createFileBackend(tokenPath))?.token,
		freshToken,
	)
})
