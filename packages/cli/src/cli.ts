import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'
import {
	cliBootstrapMintCall,
	hasExplicitTokenFlag,
	requireApiToken,
	resolveScopedApiToken,
} from './api-token.js'
import { deleteStoredApiToken, loadStoredApiToken } from './api-token-store.js'
import {
	authBootstrap,
	authBootstrapWithScopes,
	bootstrapMintLifetimeFields,
	cliCredentialBootstrapOperationId,
	parseCliLifetimeSecondsFlag,
	parseCliScopesFlag,
	resolveCliTokenLifetime,
	type ResolvedCliTokenLifetime,
} from './auth-bootstrap.js'
import {
	parseCredentialFlags,
	type CredentialCallMapInput,
} from './credential-call-map.js'
import { defaultApiUrl, defaultMcpUrl } from './defaults.js'
import { buildUsage } from './help.js'
import { orgSlugFromFlag, resolveOrgSlug } from './org-resolve.js'
import { refreshGitCredentialHelperPinIfNeeded } from './setup-git.js'
import {
	deleteCredentials,
	listStoredOrgs,
	loadCredentialStore,
	loadCredentials,
} from './store.js'
import { formatToolResult } from './tool-result.js'
import { resolveLocalExecuteBearer } from './local-execute-auth.js'
import { assertNoUnknownCliOptions } from './unknown-cli-option.js'
import {
	isPublishedPackageInvokeSpecifier,
	resolveExecuteInvokeCode,
} from './invoke-passthrough.js'
import { assertLocalExecuteNodeEngine } from './node-engine.js'
import {
	isPackageCollaboratorAction,
	packageCollaboratorUsage,
	parsePackageCollaboratorCommand,
	runPackageCollaboratorPlan,
} from './package-collaborators.js'
import { readPackageVersion } from './package-info.js'
import { redactError } from './redact.js'

export {
	readApiToken,
	requireApiToken as resolveApiToken,
	resolveScopedApiToken,
} from './api-token.js'
export { resolveLocalExecuteBearer } from './local-execute-auth.js'
export {
	authBootstrap,
	authBootstrapWithScopes,
	bootstrapRedeemRequestBody,
	cliTokenLifetimeAliases,
	cliTokenLifetimeMissingError,
	cliTokenLifetimePolicy,
	parseCliLifetimeSecondsFlag,
	parseCliScopesFlag,
	redeemBootstrapCode,
	resolveCliTokenLifetime,
} from './auth-bootstrap.js'

export type CommandName =
	| 'login'
	| 'logout'
	| 'org'
	| 'status'
	| 'auth'
	| 'git-credential'
	| 'whoami'
	| 'search'
	| 'api'
	| 'package'
	| 'execute'
	| 'dev'
	| 'install'
	| 'skill'
	| 'help'
	| 'version'

const orgScopedCommands = new Set<CommandName>([
	'login',
	'logout',
	'whoami',
	'search',
	'api',
	'package',
	'execute',
	'dev',
	'auth',
])

function mcpUrlFrom(values: { mcpUrl?: string }): string {
	return values.mcpUrl || process.env.KODY_MCP_URL || defaultMcpUrl
}

export function apiUrlFrom(
	values: { apiUrl?: string },
	env: NodeJS.ProcessEnv = process.env,
): string {
	return values.apiUrl || env.KODY_API_URL || defaultApiUrl
}

const cliFlagOptions = {
	help: { type: 'boolean', short: 'h' },
	version: { type: 'boolean', short: 'v' },
	json: { type: 'boolean' },
	'mcp-url': { type: 'string' },
	entity: { type: 'string' },
	domain: { type: 'string' },
	limit: { type: 'string' },
	code: { type: 'string' },
	file: { type: 'string' },
	invoke: { type: 'string' },
	params: { type: 'string' },
	'conversation-id': { type: 'string' },
	local: { type: 'boolean' },
	'allow-private-network': { type: 'boolean' },
	credential: { type: 'string', multiple: true },
	token: { type: 'string' },
	'api-url': { type: 'string' },
	lifetime: { type: 'string' },
	'idle-ttl-seconds': { type: 'string' },
	'max-lifetime-seconds': { type: 'string' },
	scopes: { type: 'string' },
	project: { type: 'boolean' },
	'no-browser': { type: 'boolean' },
	org: { type: 'string' },
	target: { type: 'string' },
	'reset-storage': { type: 'boolean' },
	'dry-run': { type: 'boolean' },
	passthrough: { type: 'string' },
	port: { type: 'string' },
	'app-base-path': { type: 'string' },
	'no-live-reload': { type: 'boolean' },
	'ready-file': { type: 'string' },
	'no-attach': { type: 'boolean' },
	method: { type: 'string' },
	body: { type: 'string' },
	clients: { type: 'string' },
	yes: { type: 'boolean', short: 'y' },
	team: { type: 'string' },
	user: { type: 'string' },
	preset: { type: 'string' },
	grant: { type: 'string' },
} as const

const cliFlagNames = Object.keys(cliFlagOptions)

function parseKnown(args: Array<string>) {
	const { tokens, values, positionals } = parseArgs({
		args,
		allowPositionals: true,
		strict: false,
		tokens: true,
		options: cliFlagOptions,
	})
	assertNoUnknownCliOptions(tokens, cliFlagNames)
	return { values, positionals }
}

export function resolveCommand(argv: Array<string>): {
	command: CommandName
	positionals: Array<string>
	values: ReturnType<typeof parseKnown>['values']
} {
	const { positionals, values } = parseKnown(argv)
	if (values.help && positionals.length === 0) {
		return { command: 'help', positionals, values }
	}
	if (values.version && positionals.length === 0) {
		return { command: 'version', positionals, values }
	}
	const raw = positionals[0]
	if (!raw) return { command: 'help', positionals, values }
	switch (raw) {
		case 'login':
		case 'logout':
		case 'org':
		case 'status':
		case 'auth':
		case 'git-credential':
		case 'whoami':
		case 'search':
		case 'api':
		case 'package':
		case 'execute':
		case 'dev':
		case 'install':
		case 'skill':
		case 'help':
		case 'version':
			return { command: raw, positionals: positionals.slice(1), values }
		default:
			// Never embed full usage here: git credential helpers treat any
			// unexpected stdout as protocol data, and older CLIs that dumped
			// help on unknown commands broke `git push`. Keep the hint short;
			// `runCli` always writes errors to stderr only.
			throw new Error(
				`Unknown command "${raw}". Run \`kody --help\` for usage.`,
			)
	}
}

export async function runCli(
	argv: Array<string> = process.argv.slice(2),
	io: { stdout?: (text: string) => void; stderr?: (text: string) => void } = {},
): Promise<number> {
	const write = io.stdout ?? ((text: string) => process.stdout.write(text))
	const writeErr = io.stderr ?? ((text: string) => process.stderr.write(text))
	// Best-effort: upgrade stale git helper pins (major-only / ephemeral /
	// outdated exact) before most commands. Must not write to stdout — git
	// reads the helper protocol from stdout only.
	// Skip under node:test so unit tests never rewrite the developer's
	// global git config; skip git-credential (helper must stay fast / offline
	// while the stored token is valid); skip version/help (no git touch).
	const head = argv[0]
	const skipHelperRefresh =
		process.env.NODE_TEST === '1' ||
		process.env.KODY_SKIP_GIT_HELPER_REFRESH === '1' ||
		head === 'git-credential' ||
		head === 'version' ||
		head === '--version' ||
		head === '-v' ||
		head === 'help' ||
		head === '--help' ||
		head === '-h' ||
		head === undefined
	if (!skipHelperRefresh) {
		try {
			refreshGitCredentialHelperPinIfNeeded({
				mcpUrl: process.env.KODY_MCP_URL || undefined,
			})
		} catch {
			// Ignore refresh failures; the user's command still runs.
		}
	}
	const jsonFlag = argvIncludesJsonFlag(argv)
	try {
		const parsed = resolveCommand(argv)
		const helpMcpUrl = mcpUrlFrom({
			mcpUrl:
				typeof parsed.values['mcp-url'] === 'string'
					? parsed.values['mcp-url']
					: undefined,
		})
		if (parsed.values.help && parsed.command !== 'help') {
			write(buildUsage({ mcpUrl: helpMcpUrl }))
			return 0
		}
		return await dispatch(parsed, write, writeErr)
	} catch (error) {
		const redacted = redactError(error)
		if (jsonFlag) {
			write(`${JSON.stringify(formatCliErrorJson(redacted), null, 2)}\n`)
		}
		writeErr(`${redacted.message}\n`)
		return 1
	}
}

/** Peek `--json` without requiring a successful `resolveCommand` parse. */
export function argvIncludesJsonFlag(argv: Array<string>): boolean {
	return argv.includes('--json')
}

/**
 * Structured `--json` error body. Additive `sent` when a network hop failed
 * before an HTTP response (`false` = connect phase; `"unknown"` otherwise).
 */
export function formatCliErrorJson(error: Error): {
	error: true
	message: string
	status?: number
	code?: string
	sent?: false | 'unknown'
} {
	const body: {
		error: true
		message: string
		status?: number
		code?: string
		sent?: false | 'unknown'
	} = {
		error: true,
		message: error.message,
	}
	const record = error as Error & {
		sent?: unknown
		status?: unknown
		code?: unknown
	}
	if (record.sent === false || record.sent === 'unknown') {
		body.sent = record.sent
	}
	if (typeof record.status === 'number') {
		body.status = record.status
	}
	if (typeof record.code === 'string') {
		body.code = record.code
	}
	return body
}

async function dispatch(
	parsed: ReturnType<typeof resolveCommand>,
	write: (text: string) => void,
	writeErr: (text: string) => void,
): Promise<number> {
	const mcpUrl = mcpUrlFrom({
		mcpUrl:
			typeof parsed.values['mcp-url'] === 'string'
				? parsed.values['mcp-url']
				: undefined,
	})
	const json = parsed.values.json === true
	if (parsed.values['allow-private-network'] === true) {
		const executeAllowsPrivateNetwork =
			parsed.command === 'execute' &&
			(parsed.values.local === true ||
				(await import('./target.js')).resolveTarget({
					command: 'execute',
					flag:
						typeof parsed.values.target === 'string'
							? parsed.values.target
							: undefined,
				}) === 'mock')
		if (parsed.command !== 'dev' && !executeAllowsPrivateNetwork) {
			throw new Error(
				'--allow-private-network can only be used with execute --local, execute --target mock, or kody dev.',
			)
		}
	}
	if (
		parsed.values['reset-storage'] === true &&
		parsed.command !== 'dev' &&
		parsed.command !== 'execute' &&
		parsed.command !== 'search'
	) {
		throw new Error(
			'`--reset-storage` is only used with --target mock on execute, search, or dev.',
		)
	}
	if (parsed.values['dry-run'] === true && parsed.command !== 'dev') {
		throw new Error(
			'`--dry-run` is only used with `kody dev job|webhook|emit` (shows the plan without invoking).',
		)
	}
	if (
		typeof parsed.values.passthrough === 'string' &&
		parsed.command !== 'dev' &&
		parsed.command !== 'execute'
	) {
		throw new Error(
			'`--passthrough` is only used with `execute --target mock` or `kody dev` when `.kody/mocks.ts` is active.',
		)
	}
	const orgFlag =
		typeof parsed.values.org === 'string' ? parsed.values.org : undefined
	if (orgFlag !== undefined && !orgScopedCommands.has(parsed.command)) {
		throw new Error(
			`\`--org\` is not used with \`kody ${parsed.command}\`. Use it with login, logout, whoami, search, api, package, execute, or auth.`,
		)
	}
	// Login/logout honor `--org` only — not KODY_ORG (that env is for one-shot
	// org-scoped commands and must not bind browser login or change logout).
	const orgFlagOnly =
		orgFlag !== undefined ? orgSlugFromFlag(orgFlag) : undefined
	const org = resolveOrgSlug({
		flag: orgFlag,
		activeOrg: loadCredentialStore(mcpUrl)?.activeOrg,
	})

	switch (parsed.command) {
		case 'help':
			write(buildUsage({ mcpUrl }))
			return 0
		case 'version':
			write(`${readPackageVersion()}\n`)
			return 0
		case 'login': {
			const { login } = await import('./auth.js')
			write('Opening the Kody login page in your browser…\n')
			const result = await login({
				mcpUrl,
				apiUrl: apiUrlFrom({
					apiUrl:
						typeof parsed.values['api-url'] === 'string'
							? parsed.values['api-url']
							: undefined,
				}),
				...(typeof parsed.values.lifetime === 'string'
					? { lifetime: parsed.values.lifetime === 'short' ? 'short' : 'long' }
					: {}),
				...(orgFlagOnly ? { org: orgFlagOnly } : {}),
				openBrowser: parsed.values['no-browser'] !== true,
				onAuthorizationUrl: (url) => {
					write(`If the browser does not open, visit:\n${url.href}\n`)
				},
			})
			const orgLabel = result.org
				? ` as org ${result.org}`
				: result.credentials.org
					? ` as org ${result.credentials.org}`
					: ''
			const accountLabel = result.account?.email
				? ` (${result.account.email})`
				: result.account?.displayName
					? ` (${result.account.displayName})`
					: ''
			write(
				`Logged in to ${result.credentials.mcpUrl}${orgLabel}${accountLabel}.\n`,
			)
			if (result.backendKind === 'file' && result.backendPath) {
				write(
					`OS keychain was unavailable; credentials saved at ${result.backendPath} (mode 0600).\n`,
				)
			} else {
				write('Credentials stored in the OS keychain.\n')
			}
			return 0
		}
		case 'logout': {
			const apiUrl = apiUrlFrom({
				apiUrl:
					typeof parsed.values['api-url'] === 'string'
						? parsed.values['api-url']
						: undefined,
			})
			const oauth = deleteCredentials(
				mcpUrl,
				undefined,
				undefined,
				orgFlagOnly ? { org: orgFlagOnly } : undefined,
			)
			// Clear the bootstrap/API token only when removing the last org login
			// or when not targeting a specific remaining multi-org set.
			const clearApiToken = !orgFlagOnly || oauth.remaining === 0
			const apiToken = clearApiToken
				? deleteStoredApiToken(apiUrl)
				: { deleted: false }
			if (!oauth.deleted && !apiToken.deleted) {
				write(
					orgFlagOnly
						? `No stored login for org "${orgFlagOnly}".\n`
						: 'No stored credentials.\n',
				)
				return 0
			}
			const parts: Array<string> = []
			if (oauth.deleted) {
				parts.push(
					orgFlagOnly
						? `Logged out of org ${orgFlagOnly}.`
						: 'Logged out of the active org (kody login).',
				)
			}
			if (apiToken.deleted) parts.push('Cleared stored bootstrap/API token.')
			write(`${parts.join(' ')}\n`)
			return 0
		}
		case 'org': {
			const {
				chooseOrgInteractively,
				formatOrgListHuman,
				formatOrgListJson,
				useOrg,
			} = await import('./org.js')
			const { listStoredOrgs } = await import('./store.js')
			const action = parsed.positionals[0]
			if (action === 'list') {
				const orgs = listStoredOrgs(mcpUrl)
				write(json ? formatOrgListJson(orgs) : formatOrgListHuman(orgs))
				return orgs.length === 0 ? 1 : 0
			}
			if (action === 'use') {
				const slugArg = parsed.positionals[1]
				if (slugArg) {
					const next = useOrg(slugArg, mcpUrl)
					write(`Active org is now ${next.activeOrg}.\n`)
					return 0
				}
				const orgs = listStoredOrgs(mcpUrl)
				const chosen = await chooseOrgInteractively({ orgs })
				const next = useOrg(chosen, mcpUrl)
				write(`Active org is now ${next.activeOrg}.\n`)
				return 0
			}
			throw new Error('Usage: kody org list [--json] | kody org use [<slug>]')
		}
		case 'status': {
			const apiUrl = apiUrlFrom({
				apiUrl:
					typeof parsed.values['api-url'] === 'string'
						? parsed.values['api-url']
						: undefined,
			})
			// Status always reports the active (or pending) login — not KODY_ORG.
			const credentials = loadCredentials(mcpUrl)
			const orgs = listStoredOrgs(mcpUrl)
			const storedApi = loadStoredApiToken(apiUrl)
			if (!credentials && orgs.length === 0 && !storedApi) {
				write('Not logged in.\n')
				return 1
			}
			const lines: Array<string> = []
			if (credentials || orgs.length > 0) {
				const expires = credentials?.expiresAt
					? new Date(credentials.expiresAt).toISOString()
					: 'unknown'
				lines.push(
					`mcp: ${credentials?.mcpUrl ?? mcpUrl}`,
					`logged in: yes`,
					`active org: ${credentials?.org ?? orgs.find((row) => row.active)?.slug ?? '(pending)'}`,
					`orgs: ${orgs.map((row) => (row.active ? `${row.slug}*` : row.slug)).join(', ') || '(pending)'}`,
					`access token expires: ${expires}`,
					`refresh token: ${credentials?.refreshToken ? 'yes' : 'no'}`,
					`scope: ${credentials?.scope ?? 'unknown'}`,
				)
			} else {
				lines.push(`mcp: ${mcpUrl}`, `logged in: no`)
			}
			if (storedApi) {
				const scopes = storedApi.scopes?.join(', ') || '(unknown)'
				lines.push(
					`api: ${storedApi.apiUrl}`,
					`stored API token: yes (${storedApi.tokenId})`,
					`API token scopes: ${scopes}`,
					`API token expires: ${storedApi.expiresAt ?? 'unknown'}`,
					`API token via: ${storedApi.createdVia ?? 'unknown'}`,
				)
			} else {
				lines.push(`api: ${apiUrl}`, `stored API token: no`)
			}
			lines.push('')
			write(lines.join('\n'))
			return 0
		}
		case 'auth': {
			const action = parsed.positionals[0]
			if (action === 'setup-git') {
				return runAuthSetupGit({
					values: parsed.values,
					mcpUrl,
					write,
					...(org ? { org } : {}),
				})
			}
			if (action === 'remove-git') {
				return runAuthRemoveGit({
					values: parsed.values,
					mcpUrl,
					write,
				})
			}
			if (action !== 'bootstrap') {
				throw new Error(
					'Usage: kody auth bootstrap (…) | kody auth setup-git […] | kody auth remove-git [--api-url <url>] [--mcp-url <url>]',
				)
			}
			const code =
				typeof parsed.values.code === 'string' ? parsed.values.code.trim() : ''
			const scopes = parseCliScopesFlag(
				typeof parsed.values.scopes === 'string'
					? parsed.values.scopes
					: undefined,
			)
			if (!code && !scopes) {
				throw new Error(
					'Provide --code <kody_bc_…> from cliCredentialBootstrap (MCP api / kody.cliCredentialBootstrap), or --scopes <list> to mint one with the current kody login session or API token.',
				)
			}
			const lifetime = resolveCliTokenLifetime({
				lifetime:
					typeof parsed.values.lifetime === 'string'
						? parsed.values.lifetime
						: undefined,
				idleTtlSeconds: parseCliLifetimeSecondsFlag(
					typeof parsed.values['idle-ttl-seconds'] === 'string'
						? parsed.values['idle-ttl-seconds']
						: undefined,
					'--idle-ttl-seconds',
				),
				maxLifetimeSeconds: parseCliLifetimeSecondsFlag(
					typeof parsed.values['max-lifetime-seconds'] === 'string'
						? parsed.values['max-lifetime-seconds']
						: undefined,
					'--max-lifetime-seconds',
				),
			})
			const apiUrl = apiUrlFrom({
				apiUrl:
					typeof parsed.values['api-url'] === 'string'
						? parsed.values['api-url']
						: undefined,
			})
			if (code && scopes) {
				throw new Error(
					`--scopes cannot change a bootstrap code: its scopes are fixed when it is minted. From Kody MCP, call \`${cliBootstrapMintCall(scopes, bootstrapMintLifetimeFields(lifetime))}\` and redeem the new code, or drop --code to mint with the current kody login session or API token.`,
				)
			}
			const result = scopes
				? await authBootstrapWithScopes({
						scopes,
						lifetime,
						apiUrl,
						mint: bootstrapMinter({
							scopes,
							lifetime,
							mcpUrl,
							apiUrl,
							tokenValues: tokenFlagValues(parsed.values),
							...(org ? { org } : {}),
						}),
					})
				: await authBootstrap({
						code,
						apiUrl,
						...(lifetime.kind === 'alias'
							? { lifetime: lifetime.lifetime }
							: {
									idleTtlSeconds: lifetime.idleTtlSeconds,
									maxLifetimeSeconds: lifetime.maxLifetimeSeconds,
								}),
					})
			const storedScopes = result.stored.scopes?.join(', ') || '(none)'
			write(
				[
					`Bootstrap API token stored for execute --local, search, whoami, api, and token-auth cloud execute.`,
					`api: ${result.stored.apiUrl}`,
					`token id: ${result.stored.tokenId}`,
					`scopes: ${storedScopes}`,
					`expires: ${result.stored.expiresAt ?? 'unknown'}`,
					result.backendKind === 'file' && result.backendPath
						? `OS keychain was unavailable; token saved at ${result.backendPath} (mode 0600).`
						: 'Token stored in the OS keychain.',
					'',
				].join('\n'),
			)
			return 0
		}
		case 'git-credential': {
			const {
				handleGitCredential,
				parseGitCredentialAction,
				parseGitCredentialInput,
				readGitCredentialStdin,
			} = await import('./git-credential.js')
			const action = parseGitCredentialAction(parsed.positionals)
			const raw = await readGitCredentialStdin(process.stdin)
			const output = await handleGitCredential({
				action,
				request: parseGitCredentialInput(raw),
				apiUrl: apiUrlFrom({
					apiUrl:
						typeof parsed.values['api-url'] === 'string'
							? parsed.values['api-url']
							: undefined,
				}),
				mcpUrl,
			})
			if (output) process.stdout.write(output)
			return 0
		}
		case 'whoami': {
			const { resolveTarget } = await import('./target.js')
			const target = resolveTarget({
				command: 'whoami',
				flag:
					typeof parsed.values.target === 'string'
						? parsed.values.target
						: undefined,
			})
			const tokenValues = tokenFlagValues(parsed.values)
			let apiUrl = apiUrlFrom({
				apiUrl:
					typeof parsed.values['api-url'] === 'string'
						? parsed.values['api-url']
						: undefined,
			})
			if (target === 'mock') {
				const { ensureMockTarget } = await import('./mock/mock-server.js')
				const mock = await ensureMockTarget({
					resetStorage: parsed.values['reset-storage'] === true,
					...(org ? { orgSlug: org } : {}),
				})
				try {
					const me = await fetch(
						`${mock.apiUrl}/v1/me${org ? `?org=${encodeURIComponent(org)}` : ''}`,
						{
							headers: { authorization: `Bearer ${mock.token}` },
						},
					)
					const body = (await me.json()) as Record<string, unknown>
					if (json) {
						write(`${JSON.stringify({ target: 'mock', ...body }, null, 2)}\n`)
					} else {
						const userId =
							typeof body.user_id === 'string' ? body.user_id : 'user_mock'
						const username =
							typeof body.username === 'string' ? body.username : 'mock-user'
						const orgBody =
							body.org && typeof body.org === 'object'
								? (body.org as { slug?: string })
								: {}
						write(
							[
								`target: mock`,
								`api: ${mock.apiUrl}`,
								`user: ${username} (${userId})`,
								`org: ${orgBody.slug ?? org ?? 'mock-org'}`,
								'',
							].join('\n'),
						)
					}
					return me.ok ? 0 : 1
				} finally {
					if (mock.started) await mock.server.close()
				}
			}
			if (
				shouldUseApiToken({
					tokenValues,
					mcpUrl,
					apiUrl,
					allowEnvWithoutLogin: true,
					...(org ? { org } : {}),
				})
			) {
				const { whoamiWithApiToken } = await import('./open-api-client.js')
				const identity = await whoamiWithApiToken({
					token: requireApiToken(tokenValues, process.env, 'whoami', {
						apiUrl,
					}),
					apiUrl,
					...(org ? { org } : {}),
				})
				if (json) {
					write(`${JSON.stringify(identity, null, 2)}\n`)
					return 0
				}
				const scopeLine = identity.token.scopes.join(', ') || '(none)'
				const userLine = identity.user
					? `${identity.user.displayName} <${identity.user.email}>`
					: '(account:read not on this token)'
				write(
					[
						`api: ${identity.apiUrl}`,
						`auth: API token (${identity.token.id})`,
						`user: ${userLine}`,
						`scopes: ${scopeLine}`,
						`expires: ${identity.token.expiresAt ?? 'unknown'}`,
						'',
					].join('\n'),
				)
				return 0
			}
			const { ensureOpenApiCredentials } = await import('./auth.js')
			const credentials = await ensureOpenApiCredentials({
				mcpUrl,
				org,
				apiUrl,
			})
			const { whoamiWithApiToken } = await import('./open-api-client.js')
			const identity = await whoamiWithApiToken({
				token: credentials.accessToken,
				apiUrl,
				...(org ? { org } : {}),
			})
			if (json) {
				write(
					`${JSON.stringify(
						{
							apiUrl: identity.apiUrl,
							org: credentials.org ?? null,
							scope: identity.token.scopes,
							token: identity.token,
							user: identity.user,
						},
						null,
						2,
					)}\n`,
				)
				return 0
			}
			const orgLine = credentials.org ? `\norg: ${credentials.org}` : ''
			const userLine = identity.user
				? `${identity.user.displayName} <${identity.user.email}>`
				: '(no profile)'
			write(
				`Logged in at ${identity.apiUrl}${orgLine}\nuser: ${userLine}\nscopes: ${identity.token.scopes.join(', ') || '(none)'}\n`,
			)
			return 0
		}
		case 'search': {
			const { resolveTarget } = await import('./target.js')
			const target = resolveTarget({
				command: 'search',
				flag:
					typeof parsed.values.target === 'string'
						? parsed.values.target
						: undefined,
			})
			const query = parsed.positionals.join(' ').trim()
			const tokenValues = tokenFlagValues(parsed.values)
			let apiUrl = apiUrlFrom({
				apiUrl:
					typeof parsed.values['api-url'] === 'string'
						? parsed.values['api-url']
						: undefined,
			})
			let closeMock: (() => Promise<void>) | undefined
			try {
				if (target === 'mock') {
					const { ensureMockTarget } = await import('./mock/mock-server.js')
					const mock = await ensureMockTarget({
						resetStorage: parsed.values['reset-storage'] === true,
					})
					apiUrl = mock.apiUrl
					closeMock = mock.started ? () => mock.server.close() : undefined
					const { searchWithApiToken } = await import('./open-api-client.js')
					const result = await searchWithApiToken({
						token: mock.token,
						apiUrl,
						query: query || undefined,
						entity:
							typeof parsed.values.entity === 'string'
								? parsed.values.entity
								: undefined,
						domain:
							typeof parsed.values.domain === 'string'
								? parsed.values.domain
								: undefined,
						limit:
							typeof parsed.values.limit === 'string'
								? Number(parsed.values.limit)
								: undefined,
					})
					write(formatToolResult(result, json))
					return result.isError ? 1 : 0
				}
				if (
					shouldUseApiToken({
						tokenValues,
						mcpUrl,
						apiUrl,
						allowEnvWithoutLogin: true,
						...(org ? { org } : {}),
					})
				) {
					const { searchWithApiToken } = await import('./open-api-client.js')
					const result = await searchWithApiToken({
						token: requireApiToken(tokenValues, process.env, 'search', {
							apiUrl,
						}),
						apiUrl,
						...(org ? { org } : {}),
						query: query || undefined,
						entity:
							typeof parsed.values.entity === 'string'
								? parsed.values.entity
								: undefined,
						domain:
							typeof parsed.values.domain === 'string'
								? parsed.values.domain
								: undefined,
						limit:
							typeof parsed.values.limit === 'string'
								? Number(parsed.values.limit)
								: undefined,
					})
					write(formatToolResult(result, json))
					return result.isError ? 1 : 0
				}
				const { ensureOpenApiCredentials } = await import('./auth.js')
				const credentials = await ensureOpenApiCredentials({
					mcpUrl,
					org,
					apiUrl,
				})
				const { searchWithApiToken } = await import('./open-api-client.js')
				const result = await searchWithApiToken({
					token: credentials.accessToken,
					apiUrl,
					...(org ? { org } : {}),
					query: query || undefined,
					entity:
						typeof parsed.values.entity === 'string'
							? parsed.values.entity
							: undefined,
					domain:
						typeof parsed.values.domain === 'string'
							? parsed.values.domain
							: undefined,
					limit:
						typeof parsed.values.limit === 'string'
							? Number(parsed.values.limit)
							: undefined,
				})
				write(formatToolResult(result, json))
				return result.isError ? 1 : 0
			} finally {
				await closeMock?.()
			}
		}
		case 'execute': {
			const { resolveTarget } = await import('./target.js')
			const target = resolveTarget({
				command: 'execute',
				flag:
					typeof parsed.values.target === 'string'
						? parsed.values.target
						: undefined,
			})
			const invoke =
				typeof parsed.values.invoke === 'string'
					? parsed.values.invoke
					: undefined
			const hasCodeFlag = typeof parsed.values.code === 'string'
			const hasFileFlag = typeof parsed.values.file === 'string'
			const positionalModule = parsed.positionals.join('\n').trim()
			// --target mock always runs locally against the CLI mock (no cloud sandbox).
			const local = parsed.values.local === true || target === 'mock'
			const tokenValues = tokenFlagValues(parsed.values)
			const localPackageInvoke =
				invoke !== undefined ? await tryResolveLocalPackageInvoke(invoke) : null
			/**
			 * Published-package invoke (`kody:@scope/pkg/export`) minted as the
			 * same thin passthrough `--code` would use, so `--local` / `--target
			 * mock` do not need an import wrapper.
			 */
			let publishedInvokeCode: string | undefined
			if (local && invoke !== undefined && !localPackageInvoke) {
				try {
					publishedInvokeCode = resolveExecuteInvokeCode(invoke)
				} catch {
					throw new Error(
						`--invoke ${JSON.stringify(invoke)} is neither a local package export nor a published package specifier. ` +
							`From a package directory, pass an export key from package.json#exports (e.g. \`--invoke ./greet\`). ` +
							`To call a published export locally, use \`--invoke kody:@scope/pkg/export\` (or \`@scope/pkg#export\`) — no \`--code "import …"\` wrapper needed. ` +
							`Or pass --code / --file / a module string.`,
					)
				}
			}
			if (
				executeSourcesConflict({
					invoke,
					hasCodeFlag,
					hasFileFlag,
					positionalModule,
				})
			) {
				throw new Error(
					'--invoke cannot be combined with --code, --file, or a module string.',
				)
			}
			if (local) assertLocalExecuteNodeEngine()
			const fileArg = hasFileFlag ? (parsed.values.file as string) : undefined
			// `--code` wins over `--file`. Only attribute the path when the file is the source.
			const modulePath =
				localPackageInvoke?.modulePath ??
				(!hasCodeFlag && fileArg !== undefined && fileArg !== '-'
					? fileArg
					: undefined)
			const code =
				publishedInvokeCode !== undefined
					? publishedInvokeCode
					: invoke !== undefined && !localPackageInvoke
						? undefined
						: hasCodeFlag
							? parsed.values.code
							: modulePath !== undefined && !localPackageInvoke
								? await readFile(modulePath, 'utf8')
								: localPackageInvoke
									? await readFile(localPackageInvoke.modulePath, 'utf8')
									: fileArg === '-'
										? await readStdin()
										: positionalModule || undefined
			const credentials = parseCredentialFlags(
				Array.isArray(parsed.values.credential)
					? parsed.values.credential.filter(
							(value): value is string => typeof value === 'string',
						)
					: typeof parsed.values.credential === 'string'
						? [parsed.values.credential]
						: undefined,
			)
			const args = buildExecuteToolArgs({
				// Local published invoke is already minted into `code`.
				invoke:
					localPackageInvoke || publishedInvokeCode !== undefined
						? undefined
						: invoke,
				code: typeof code === 'string' ? code : undefined,
				paramsJson:
					typeof parsed.values.params === 'string'
						? parsed.values.params
						: undefined,
				conversationId:
					typeof parsed.values['conversation-id'] === 'string'
						? parsed.values['conversation-id']
						: undefined,
				credentials,
			})
			const prodApiUrl = apiUrlFrom({
				apiUrl:
					typeof parsed.values['api-url'] === 'string'
						? parsed.values['api-url']
						: undefined,
			})
			let apiUrl = prodApiUrl
			const { parsePassthroughHosts } =
				await import('./mock/mock-fetch-gateway.js')
			const passthroughHosts = parsePassthroughHosts(
				typeof parsed.values.passthrough === 'string'
					? parsed.values.passthrough
					: undefined,
			)
			if (passthroughHosts.length > 0 && target !== 'mock') {
				// Help documents --passthrough as ignored on prod (mock-only).
				writeErr(
					'note: `--passthrough` is ignored on `--target prod` (outbound fetch mocking is mock-only).\n',
				)
			}
			let closeMock: (() => Promise<void>) | undefined
			let mockToken: string | undefined
			let mockDepResolve:
				| { apiUrl: string; token: string; org?: string }
				| undefined
			/** Package context for --invoke or --file inside a package directory. */
			let localPackageRun: {
				modulePath: string
				kodyId: string
				packageRoot: string
			} | null = localPackageInvoke
			if (!localPackageRun && local && modulePath !== undefined) {
				try {
					const { loadPackageManifest } = await import('./package-manifest.js')
					const manifest = await loadPackageManifest(process.cwd())
					localPackageRun = {
						modulePath,
						kodyId: manifest.kodyId,
						packageRoot: manifest.root,
					}
				} catch {
					localPackageRun = null
				}
			}
			try {
				if (target === 'mock') {
					const { ensureMockTarget } = await import('./mock/mock-server.js')
					const mock = await ensureMockTarget({
						resetStorage: parsed.values['reset-storage'] === true,
						packageId: localPackageRun
							? `local:${localPackageRun.kodyId}`
							: undefined,
						...(org ? { orgSlug: org } : {}),
					})
					apiUrl = mock.apiUrl
					mockToken = mock.token
					closeMock = mock.started ? () => mock.server.close() : undefined
					const { tryResolveMockDepResolve } =
						await import('./mock-dep-resolve.js')
					mockDepResolve = await tryResolveMockDepResolve({
						tokenValues,
						apiUrl: prodApiUrl,
						mcpUrl,
						...(org ? { org } : {}),
					})
				}
				if (localPackageRun) {
					const { buildLocalPackageContext, runLocalPackageModule } =
						await import('./local-package-run.js')
					const result = await runLocalPackageModule({
						modulePath: localPackageRun.modulePath,
						params: args.params,
						token:
							mockToken ??
							(await resolveLocalExecuteBearer({
								tokenValues,
								mcpUrl,
								apiUrl,
								purpose: 'execute local package export',
								...(org ? { org } : {}),
							})),
						apiUrl,
						target,
						packageContext: buildLocalPackageContext({
							kodyId: localPackageRun.kodyId,
							hostedUrl: 'http://127.0.0.1:0',
						}),
						packageRoot: localPackageRun.packageRoot,
						...(org ? { org } : {}),
						...(mockDepResolve ? { depResolve: mockDepResolve } : {}),
						...(passthroughHosts.length > 0 && target === 'mock'
							? { passthroughHosts }
							: {}),
						allowPrivateNetwork:
							parsed.values['allow-private-network'] === true,
						onStatus: (message) => writeErr(`${message}\n`),
					})
					write(formatToolResult(result, json))
					return result.isError ? 1 : 0
				}
				const useToken =
					local ||
					shouldUseApiToken({
						tokenValues,
						mcpUrl,
						apiUrl,
						allowEnvWithoutLogin: true,
						...(org ? { org } : {}),
					})
				let packageRootForMocks: string | undefined
				if (target === 'mock') {
					try {
						const { loadPackageManifest } =
							await import('./package-manifest.js')
						packageRootForMocks = (await loadPackageManifest(process.cwd()))
							.root
					} catch {
						packageRootForMocks = undefined
					}
				}
				const result = local
					? await (
							await import('./local-execute.js')
						).runLocalExecute({
							code: args.code as string,
							...(modulePath !== undefined ? { modulePath } : {}),
							params: args.params,
							conversationId: args.conversationId as string | undefined,
							...(credentials !== undefined ? { credentials } : {}),
							token:
								mockToken ??
								(await resolveLocalExecuteBearer({
									tokenValues,
									mcpUrl,
									apiUrl,
									purpose: 'execute --local',
									...(org ? { org } : {}),
								})),
							apiUrl,
							target,
							...(org ? { org } : {}),
							...(mockDepResolve ? { depResolve: mockDepResolve } : {}),
							...(packageRootForMocks
								? { packageRoot: packageRootForMocks }
								: {}),
							...(passthroughHosts.length > 0 ? { passthroughHosts } : {}),
							allowPrivateNetwork:
								parsed.values['allow-private-network'] === true,
							onStatus: (message) => writeErr(`${message}\n`),
						})
					: useToken
						? await (
								await import('./remote-execute.js')
							).runRemoteExecuteWithToken({
								code: typeof args.code === 'string' ? args.code : undefined,
								invoke,
								params: args.params,
								conversationId: args.conversationId as string | undefined,
								...(credentials !== undefined ? { credentials } : {}),
								token: requireApiToken(
									tokenValues,
									process.env,
									'execute with an API token',
									{ apiUrl },
								),
								apiUrl,
								...(org ? { org } : {}),
							})
						: await (async () => {
								const { ensureOpenApiCredentials } = await import('./auth.js')
								const session = await ensureOpenApiCredentials({
									mcpUrl,
									org,
									apiUrl,
								})
								return (
									await import('./remote-execute.js')
								).runRemoteExecuteWithToken({
									code: typeof args.code === 'string' ? args.code : undefined,
									invoke,
									params: args.params,
									conversationId: args.conversationId as string | undefined,
									...(credentials !== undefined ? { credentials } : {}),
									token: session.accessToken,
									apiUrl,
									...(org ? { org } : {}),
								})
							})()
				write(formatToolResult(result, json))
				return result.isError ? 1 : 0
			} catch (error) {
				// Package-graph runs before workerd starts. Under --json, keep
				// stdout machine-readable with a stable code instead of leaving it
				// empty (kody#4067). Human output stays on stderr via runCli.
				if (json && local) {
					const { LocalPackageGraphError, packageGraphErrorToolResult } =
						await import('./local-package-graph.js')
					if (error instanceof LocalPackageGraphError) {
						const redacted = redactError(error).message
						const result = packageGraphErrorToolResult(error)
						result.content = [{ type: 'text', text: redacted }]
						result.structuredContent.error.message = redacted
						write(formatToolResult(result, true))
						writeErr(`${redacted}\n`)
						return 1
					}
				}
				throw error
			} finally {
				await closeMock?.()
			}
		}
		case 'dev': {
			const { resolveTarget } = await import('./target.js')
			const {
				parseDevPort,
				parseDevSubcommand,
				resolveDevAuth,
				runDevCheck,
				runDevEmit,
				runDevFetch,
				runDevJob,
				runDevServe,
				runDevWebhook,
				tryAttachedDevFetch,
			} = await import('./dev-command.js')
			const target = resolveTarget({
				command: 'dev',
				flag:
					typeof parsed.values.target === 'string'
						? parsed.values.target
						: undefined,
			})
			const { subcommand, rest } = parseDevSubcommand(parsed.positionals)
			const tokenValues = tokenFlagValues(parsed.values)
			const prodApiUrl = apiUrlFrom({
				apiUrl:
					typeof parsed.values['api-url'] === 'string'
						? parsed.values['api-url']
						: undefined,
			})
			const io = { stdout: write, stderr: writeErr }
			const bodyPath =
				typeof parsed.values.body === 'string' ? parsed.values.body : undefined
			// `check` only bundles + validates the package tree; it never talks to
			// mock/prod, so skip auth (and the mock server) to avoid leaking a listen
			// handle that would keep the process alive after printing results.
			if (subcommand === 'check') {
				return await runDevCheck({ target, json, io })
			}
			const dryRun = parsed.values['dry-run'] === true
			if (
				dryRun &&
				subcommand !== 'job' &&
				subcommand !== 'webhook' &&
				subcommand !== 'emit'
			) {
				throw new Error(
					'`--dry-run` applies to `kody dev job|webhook|emit` only (shows the plan without invoking).',
				)
			}
			// Plan-only dry-run: no login, no mock listen, no --reset-storage.
			if (dryRun) {
				const dryAuth = { token: 'dry-run', apiUrl: prodApiUrl }
				switch (subcommand) {
					case 'job': {
						const jobName = rest[0]
						if (!jobName) throw new Error('Usage: kody dev job <name>')
						return await runDevJob({
							target,
							auth: dryAuth,
							jobName,
							json,
							dryRun: true,
							io,
						})
					}
					case 'webhook': {
						const webhookName = rest[0]
						if (!webhookName || !bodyPath) {
							throw new Error('Usage: kody dev webhook <name> --body file.json')
						}
						return await runDevWebhook({
							target,
							auth: dryAuth,
							webhookName,
							bodyPath,
							json,
							dryRun: true,
							io,
						})
					}
					case 'emit': {
						const event = rest[0]
						if (!event || !bodyPath) {
							throw new Error('Usage: kody dev emit <event> --body event.json')
						}
						return await runDevEmit({
							target,
							auth: dryAuth,
							event,
							bodyPath,
							json,
							dryRun: true,
							io,
						})
					}
					default: {
						throw new Error(
							'`--dry-run` applies to `kody dev job|webhook|emit` only (shows the plan without invoking).',
						)
					}
				}
			}
			if (
				subcommand === 'fetch' &&
				parsed.values['no-attach'] !== true &&
				rest[0]
			) {
				const attached = await tryAttachedDevFetch({
					target,
					path: rest[0],
					method:
						typeof parsed.values.method === 'string'
							? parsed.values.method
							: undefined,
					body: bodyPath ? await readFile(bodyPath, 'utf8') : undefined,
					json,
					io,
				})
				if (attached !== null) return attached
			}
			const token =
				target === 'prod'
					? await resolveLocalExecuteBearer({
							tokenValues,
							mcpUrl,
							apiUrl: prodApiUrl,
							purpose: 'kody dev',
							...(org ? { org } : {}),
						})
					: 'mock'
			const mockDepResolve =
				target === 'mock'
					? await (
							await import('./mock-dep-resolve.js')
						).tryResolveMockDepResolve({
							tokenValues,
							apiUrl: prodApiUrl,
							mcpUrl,
							...(org ? { org } : {}),
						})
					: undefined
			const { parsePassthroughHosts } =
				await import('./mock/mock-fetch-gateway.js')
			const passthroughHosts = parsePassthroughHosts(
				typeof parsed.values.passthrough === 'string'
					? parsed.values.passthrough
					: undefined,
			)
			if (passthroughHosts.length > 0 && target !== 'mock') {
				writeErr(
					'note: `--passthrough` is ignored on `--target prod` (outbound fetch mocking is mock-only).\n',
				)
			}
			const allowPrivateNetwork =
				parsed.values['allow-private-network'] === true
			let packageId: string | undefined
			try {
				const { loadPackageManifest } = await import('./package-manifest.js')
				const manifest = await loadPackageManifest(process.cwd())
				packageId = `local:${manifest.kodyId}`
			} catch {
				packageId = undefined
			}
			const auth = await resolveDevAuth({
				target,
				token,
				apiUrl: prodApiUrl,
				...(org ? { org } : {}),
				...(mockDepResolve ? { depResolve: mockDepResolve } : {}),
				...(passthroughHosts.length > 0 && target === 'mock'
					? { passthroughHosts }
					: {}),
				resetStorage: parsed.values['reset-storage'] === true,
				...(packageId ? { packageId } : {}),
				...(org && target === 'mock' ? { orgSlug: org } : {}),
			})
			const port =
				typeof parsed.values.port === 'string'
					? parseDevPort(parsed.values.port)
					: undefined
			const appBasePath =
				typeof parsed.values['app-base-path'] === 'string'
					? parsed.values['app-base-path']
					: undefined
			try {
				switch (subcommand) {
					case 'serve':
						return await runDevServe({
							target,
							auth,
							port,
							appBasePath,
							allowPrivateNetwork,
							liveReload: parsed.values['no-live-reload'] !== true,
							json,
							...(typeof parsed.values['ready-file'] === 'string'
								? { readyFile: parsed.values['ready-file'] }
								: {}),
							io,
						})
					case 'fetch': {
						const path = rest[0]
						if (!path) {
							throw new Error(
								'Usage: kody dev fetch <path> [--method GET] [--body file.json]',
							)
						}
						let body: string | undefined
						if (bodyPath) body = await readFile(bodyPath, 'utf8')
						return await runDevFetch({
							target,
							auth,
							path,
							method:
								typeof parsed.values.method === 'string'
									? parsed.values.method
									: undefined,
							body,
							port,
							appBasePath,
							allowPrivateNetwork,
							json,
							io,
						})
					}
					case 'job': {
						const jobName = rest[0]
						if (!jobName) throw new Error('Usage: kody dev job <name>')
						return await runDevJob({
							target,
							auth,
							jobName,
							json,
							allowPrivateNetwork,
							io,
						})
					}
					case 'webhook': {
						const webhookName = rest[0]
						if (!webhookName || !bodyPath) {
							throw new Error('Usage: kody dev webhook <name> --body file.json')
						}
						return await runDevWebhook({
							target,
							auth,
							webhookName,
							bodyPath,
							json,
							allowPrivateNetwork,
							io,
						})
					}
					case 'emit': {
						const event = rest[0]
						if (!event || !bodyPath) {
							throw new Error('Usage: kody dev emit <event> --body event.json')
						}
						return await runDevEmit({
							target,
							auth,
							event,
							bodyPath,
							json,
							allowPrivateNetwork,
							io,
						})
					}
					default: {
						const exhaustive: never = subcommand
						throw new Error(
							`Unhandled kody dev subcommand: ${String(exhaustive)}`,
						)
					}
				}
			} catch (error) {
				// Usage / surface errors after the mock started must still close it,
				// or the listen handle keeps the process alive (same hang as check).
				await auth.closeMock?.()
				throw error
			}
		}
		case 'api': {
			const operationId = parsed.positionals[0]?.trim() ?? ''
			if (!operationId || parsed.positionals.length > 1) {
				throw new Error(
					'Usage: kody api <operationId> [--params <json>] [--token <token>] [--api-url <url>] [--json]',
				)
			}
			const apiUrl = apiUrlFrom({
				apiUrl:
					typeof parsed.values['api-url'] === 'string'
						? parsed.values['api-url']
						: undefined,
			})
			const tokenValues = tokenFlagValues(parsed.values)
			const params = parseApiParamsJson(
				typeof parsed.values.params === 'string'
					? parsed.values.params
					: undefined,
			)
			const { callOpenApiOperation } = await import('./open-api-client.js')
			const result = await callOpenApiOperation({
				operationId,
				params,
				token: await accessTokenForOpenApi({
					tokenValues,
					apiUrl,
					mcpUrl,
					org,
				}),
				apiUrl,
				...(org ? { org } : {}),
			})
			// Always JSON: mirrors MCP `api` structured results for agents/scripts.
			write(`${JSON.stringify(result, null, 2)}\n`)
			return 0
		}
		case 'package': {
			const action = parsed.positionals[0]
			const apiUrl = apiUrlFrom({
				apiUrl:
					typeof parsed.values['api-url'] === 'string'
						? parsed.values['api-url']
						: undefined,
			})
			const tokenValues = tokenFlagValues(parsed.values)
			if (isPackageCollaboratorAction(action)) {
				const plan = parsePackageCollaboratorCommand({
					action,
					positionals: parsed.positionals.slice(1),
					values: parsed.values,
				})
				const token = await accessTokenForOpenApi({
					tokenValues,
					apiUrl,
					mcpUrl,
					org,
				})
				const { callOpenApiOperation } = await import('./open-api-client.js')
				write(
					await runPackageCollaboratorPlan({
						plan,
						json,
						call: (operationId, params) =>
							callOpenApiOperation({
								operationId,
								params,
								token,
								apiUrl,
								...(org ? { org } : {}),
							}),
					}),
				)
				return 0
			}
			if (action !== 'publish') {
				throw new Error(
					`Usage: kody package publish [<@owner/leaf|package_id>] [--params <json>] [--token <token>] [--api-url <url>] [--org <slug>]\n${packageCollaboratorUsage}`,
				)
			}
			const params = packagePublishParams({
				positional: parsed.positionals[1],
				paramsJson:
					typeof parsed.values.params === 'string'
						? parsed.values.params
						: undefined,
			})
			const { callOpenApiOperation } = await import('./open-api-client.js')
			const publishToken = await accessTokenForOpenApi({
				tokenValues,
				apiUrl,
				mcpUrl,
				org,
			})
			const call = (
				operationId: string,
				operationParams: Record<string, unknown>,
			) =>
				callOpenApiOperation({
					operationId,
					params: operationParams,
					token: publishToken,
					apiUrl,
					...(org ? { org } : {}),
				})
			const result = await call(
				'packagePublishExternalPush',
				await resolvePackagePublishTarget(params, call),
			)
			write(`${JSON.stringify(result, null, 2)}\n`)
			return 0
		}
		case 'install': {
			const { runInstall } = await import('./install.js')
			const result = await runInstall(
				{
					mcpUrl,
					clients:
						typeof parsed.values.clients === 'string'
							? parsed.values.clients
							: undefined,
					yes: parsed.values.yes === true,
					project: parsed.values.project === true,
					json,
				},
				{ stdout: write },
			)
			return result.code
		}
		case 'skill': {
			const action = parsed.positionals[0] ?? 'install'
			if (action !== 'install') {
				throw new Error('Usage: kody skill install [--project]')
			}
			const { installSkill } = await import('./skill.js')
			const targets = await installSkill({
				project: parsed.values.project === true,
			})
			write(
				`Installed the Kody skill to:\n${targets.map((target) => `- ${target.host}: ${target.path}`).join('\n')}\n`,
			)
			return 0
		}
		default: {
			const exhaustive: never = parsed.command
			throw new Error(`Unhandled command: ${String(exhaustive)}`)
		}
	}
}

async function readStdin(): Promise<string> {
	const chunks: Array<Buffer> = []
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
	}
	return Buffer.concat(chunks).toString('utf8')
}

async function tryResolveLocalPackageInvoke(
	invoke: string,
): Promise<{ modulePath: string; kodyId: string; packageRoot: string } | null> {
	const trimmed = invoke.trim()
	if (!trimmed) return null
	// Published forms (`kody:@…`, `@scope/pkg#export`) must mint passthrough —
	// never treat them as package.json#exports keys (Bugbot: hash invoke in
	// package dirs threw before resolveExecuteInvokeCode).
	if (isPublishedPackageInvokeSpecifier(trimmed)) return null
	const { loadPackageManifest, resolveExportModulePath } =
		await import('./package-manifest.js')
	const { StructuredCliError } = await import('./structured-error.js')
	let manifest: Awaited<ReturnType<typeof loadPackageManifest>>
	try {
		manifest = await loadPackageManifest(process.cwd())
	} catch {
		return null
	}
	try {
		const modulePath = resolveExportModulePath(manifest, trimmed, {
			exportsOnly: true,
		})
		const { access } = await import('node:fs/promises')
		try {
			await access(modulePath)
		} catch {
			throw new StructuredCliError({
				code: 'dev_surface_missing',
				message: `No package export ${JSON.stringify(trimmed)} (path missing: ${modulePath}).`,
				where: manifest.packageJsonPath,
				fix: `Known exports: ${Object.keys(manifest.exports).join(', ') || '(none)'}.`,
			})
		}
		return { modulePath, kodyId: manifest.kodyId, packageRoot: manifest.root }
	} catch (error) {
		if (error instanceof StructuredCliError) throw error
		return null
	}
}

/** True when --invoke is set alongside any code source (--code, --file, or positional). */
export function executeSourcesConflict(input: {
	invoke?: string
	hasCodeFlag: boolean
	hasFileFlag: boolean
	positionalModule: string
}): boolean {
	return (
		input.invoke !== undefined &&
		(input.hasCodeFlag ||
			input.hasFileFlag ||
			input.positionalModule.length > 0)
	)
}

/**
 * Build MCP `execute` tool args from CLI inputs.
 * Pass either `invoke` or resolved `code` (from --code, --file, or a module string).
 */
export function buildExecuteToolArgs(input: {
	invoke?: string
	code?: string
	paramsJson?: string
	conversationId?: string
	credentials?: CredentialCallMapInput
}): Record<string, unknown> {
	const invoke = input.invoke
	const code = input.code
	if (invoke !== undefined && code !== undefined && code.length > 0) {
		throw new Error(
			'--invoke cannot be combined with --code, --file, or a module string.',
		)
	}
	if (invoke !== undefined) {
		if (!invoke) {
			throw new Error('Provide a non-empty --invoke value.')
		}
		return attachExecuteCommonArgs({ invoke }, input)
	}
	if (code) {
		return attachExecuteCommonArgs({ code }, input)
	}
	throw new Error('Provide --invoke, --code, --file, or a module string.')
}

function attachExecuteCommonArgs(
	args: Record<string, unknown>,
	input: {
		paramsJson?: string
		conversationId?: string
		credentials?: CredentialCallMapInput
	},
): Record<string, unknown> {
	if (input.paramsJson !== undefined) {
		args.params = JSON.parse(input.paramsJson)
	}
	if (input.conversationId !== undefined) {
		args.conversationId = input.conversationId
	}
	if (input.credentials !== undefined) {
		args.credentials = input.credentials
	}
	return args
}

async function runAuthSetupGit(input: {
	values: ReturnType<typeof parseKnown>['values']
	mcpUrl: string
	write: (text: string) => void
	org?: string
}): Promise<number> {
	const { authSetupGit, setupGitDefaultScopes } = await import('./setup-git.js')
	const apiUrl = apiUrlFrom({
		apiUrl:
			typeof input.values['api-url'] === 'string'
				? input.values['api-url']
				: undefined,
	})
	const scopes = parseCliScopesFlag(
		typeof input.values.scopes === 'string' ? input.values.scopes : undefined,
	)
	const lifetime = resolveCliTokenLifetime({
		lifetime:
			typeof input.values.lifetime === 'string'
				? input.values.lifetime
				: 'long',
		idleTtlSeconds: parseCliLifetimeSecondsFlag(
			typeof input.values['idle-ttl-seconds'] === 'string'
				? input.values['idle-ttl-seconds']
				: undefined,
			'--idle-ttl-seconds',
		),
		maxLifetimeSeconds: parseCliLifetimeSecondsFlag(
			typeof input.values['max-lifetime-seconds'] === 'string'
				? input.values['max-lifetime-seconds']
				: undefined,
			'--max-lifetime-seconds',
		),
	})
	const tokenValues = tokenFlagValues(input.values)
	const mintScopes = scopes ?? setupGitDefaultScopes
	const hasLoginSession =
		loadCredentials(input.mcpUrl, undefined, undefined, {
			org: input.org,
		}) != null
	const result = await authSetupGit({
		apiUrl,
		mcpUrl: input.mcpUrl,
		token: tokenValues.token,
		hasLoginSession,
		...(scopes ? { scopesOverride: scopes } : {}),
		lifetime,
		mint: bootstrapMinter({
			scopes: mintScopes,
			lifetime,
			mcpUrl: input.mcpUrl,
			apiUrl,
			tokenValues,
			...(input.org ? { org: input.org } : {}),
		}),
	})
	input.write(
		[
			`Git HTTPS credential helper installed for https://${result.host}/`,
			`helper: ${result.helperCommand}`,
			`token: ${result.minted ? 'minted' : 'reused'} ${result.tokenId} (org_binding=user)`,
			`scopes: ${result.scopes.join(', ') || '(none)'}`,
			`expires: ${result.expiresAt ?? 'unknown'}`,
			result.backendKind === 'file' && result.backendPath
				? `OS keychain was unavailable; token saved at ${result.backendPath} (mode 0600).`
				: result.minted
					? 'Token stored in the OS keychain (or existing store).'
					: 'Using the existing stored API token.',
			'',
			'This user-owned token authorizes every @owner/name.git you can access (all orgs).',
			'Try: git clone https://kody.codes/@owner/name.git',
			'Undo later: kody auth remove-git',
			'',
		].join('\n'),
	)
	return 0
}

async function runAuthRemoveGit(input: {
	values: ReturnType<typeof parseKnown>['values']
	mcpUrl: string
	write: (text: string) => void
}): Promise<number> {
	const { authRemoveGit, formatAuthRemoveGitReport } =
		await import('./setup-git.js')
	const apiUrl = apiUrlFrom({
		apiUrl:
			typeof input.values['api-url'] === 'string'
				? input.values['api-url']
				: undefined,
	})
	const result = await authRemoveGit({
		apiUrl,
		mcpUrl: input.mcpUrl,
	})
	input.write(formatAuthRemoveGitReport(result))
	return 0
}

/**
 * Pick the credential that mints a scoped bootstrap code: `--token`, else the
 * `kody login` session (MCP `api`), else KODY_API_TOKEN / a stored token (Open
 * API). A token can only mint scopes it already holds; a login session can mint
 * any scope the account's org role grants.
 */
function bootstrapMinter(input: {
	scopes: ReadonlyArray<string>
	lifetime: ResolvedCliTokenLifetime
	mcpUrl: string
	apiUrl: string
	tokenValues: { token?: string }
	org?: string
}): (params: Record<string, unknown>) => Promise<unknown> {
	// Resolve credentials lazily so `auth setup-git` can validate login/token
	// presence (and print its own guidance) before mint runs.
	return async (params) => {
		if (
			shouldUseApiToken({
				tokenValues: input.tokenValues,
				mcpUrl: input.mcpUrl,
				apiUrl: input.apiUrl,
				allowEnvWithoutLogin: true,
				...(input.org ? { org: input.org } : {}),
			})
		) {
			const token = requireApiToken(
				input.tokenValues,
				process.env,
				'auth bootstrap --scopes',
				{
					apiUrl: input.apiUrl,
				},
			)
			const { callOpenApiOperation } = await import('./open-api-client.js')
			try {
				return await callOpenApiOperation({
					token,
					apiUrl: input.apiUrl,
					operationId: cliCredentialBootstrapOperationId,
					params,
					...(input.org ? { org: input.org } : {}),
				})
			} catch (error) {
				if (
					error instanceof Error &&
					/cannot grant scopes it does not hold/i.test(error.message)
				) {
					throw new Error(
						`${error.message} A token can only mint scopes it already holds. Run \`kody login\` and retry without --token (a login session can mint any scope your org role grants), or from Kody MCP call \`${cliBootstrapMintCall(input.scopes, bootstrapMintLifetimeFields(input.lifetime))}\` and run the returned cli_command.`,
					)
				}
				throw error
			}
		}
		if (
			loadCredentials(input.mcpUrl, undefined, undefined, {
				org: input.org,
			})
		) {
			const { ensureOpenApiCredentials } = await import('./auth.js')
			const session = await ensureOpenApiCredentials({
				mcpUrl: input.mcpUrl,
				apiUrl: input.apiUrl,
				...(input.org ? { org: input.org } : {}),
			})
			const { callOpenApiOperation } = await import('./open-api-client.js')
			return callOpenApiOperation({
				operationId: cliCredentialBootstrapOperationId,
				params,
				token: session.accessToken,
				apiUrl: input.apiUrl,
				...(input.org ? { org: input.org } : {}),
			})
		}
		throw new Error(
			`auth bootstrap --scopes mints with your current Kody credential, and none was found. Run \`kody login\` and retry, or from Kody MCP call \`${cliBootstrapMintCall(input.scopes, bootstrapMintLifetimeFields(input.lifetime))}\` and run the returned cli_command.`,
		)
	}
}

function tokenFlagValues(values: ReturnType<typeof parseKnown>['values']): {
	token?: string
} {
	return {
		token: typeof values.token === 'string' ? values.token : undefined,
	}
}

/** Explicit token, else the login device token (exchanging OAuth when needed). */
async function accessTokenForOpenApi(input: {
	tokenValues: { token?: string }
	apiUrl: string
	mcpUrl: string
	org?: string
}): Promise<string> {
	const explicit = resolveScopedApiToken({
		tokenValues: input.tokenValues,
		env: process.env,
		apiUrl: input.apiUrl,
	})
	if (explicit) return explicit
	const { ensureOpenApiCredentials } = await import('./auth.js')
	const session = await ensureOpenApiCredentials({
		mcpUrl: input.mcpUrl,
		apiUrl: input.apiUrl,
		...(input.org ? { org: input.org } : {}),
	})
	return session.accessToken
}

/** Parse `--params` JSON for `kody api` (flat object, same as MCP `api`). */
export function parseApiParamsJson(
	paramsJson?: string,
): Record<string, unknown> {
	if (paramsJson === undefined) return {}
	let parsed: unknown
	try {
		parsed = JSON.parse(paramsJson)
	} catch {
		throw new Error('--params must be valid JSON (a flat object).')
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
		throw new Error(
			'--params must be a JSON object (e.g. \'{"query":"email"}\').',
		)
	}
	return parsed as Record<string, unknown>
}

const packageIdUuidPattern =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Build `packagePublishExternalPush` params for `kody package publish`.
 * Optional positional is `package_id` when UUID-shaped, otherwise `kody_id`.
 * Explicit `--params` keys win over the positional.
 */
export function packagePublishParams(input: {
	positional?: string
	paramsJson?: string
}): Record<string, unknown> {
	const params = parseApiParamsJson(input.paramsJson)
	const ref = input.positional?.trim()
	if (!ref) return params
	if (packageIdUuidPattern.test(ref)) {
		if (params.package_id === undefined) params.package_id = ref
	} else if (params.kody_id === undefined) {
		params.kody_id = ref
	}
	return params
}

/**
 * The publish route is `POST /v1/packages/{package_id}/external-push`, so a
 * package name (`@owner/leaf` or bare leaf) is resolved to its `package_id`
 * through `packageList` first.
 */
export async function resolvePackagePublishTarget(
	params: Record<string, unknown>,
	call: (
		operationId: string,
		params: Record<string, unknown>,
	) => Promise<unknown>,
): Promise<Record<string, unknown>> {
	if (params.package_id !== undefined || typeof params.kody_id !== 'string')
		return params
	const ref = params.kody_id.trim()
	const listed = (await call('packageList', {})) as {
		packages?: Array<{ package_id: string; kody_id: string; name: string }>
	}
	const packages = listed.packages ?? []
	const leaf = ref.includes('/') ? ref.slice(ref.lastIndexOf('/') + 1) : ref
	const byName = packages.filter((pkg) => pkg.name === ref)
	const matches =
		byName.length > 0
			? byName
			: ref.startsWith('@')
				? []
				: packages.filter((pkg) => pkg.kody_id === leaf)
	if (matches.length !== 1) {
		const known = packages
			.map((pkg) => pkg.name)
			.slice(0, 20)
			.join(', ')
		throw new Error(
			matches.length === 0
				? `No saved package named "${ref}" in this org.${known ? ` Saved packages: ${known}.` : ''} Pass the scoped name (@owner/leaf), the package_id, or --org <slug> for another org.`
				: `"${ref}" matches several saved packages (${matches.map((pkg) => `${pkg.name} = ${pkg.package_id}`).join(', ')}). Pass the scoped name or the package_id.`,
		)
	}
	const { kody_id: _name, ...rest } = params
	return { ...rest, package_id: matches[0]!.package_id }
}

/**
 * Prefer a scoped API token when the user passed `--token`, or when
 * `KODY_API_TOKEN` / a stored bootstrap token is available and there is no
 * stored `kody login` session. Logged-in MCP OAuth still wins over an
 * env-only or stored token so a leftover token does not hijack cloud MCP
 * commands.
 */
export function shouldUseApiToken(input: {
	tokenValues: { token?: string }
	mcpUrl: string
	allowEnvWithoutLogin: boolean
	env?: NodeJS.ProcessEnv
	apiUrl?: string
	/** When set, only a login for this org counts as a session. */
	org?: string
	/** Override session detection (tests). */
	hasSession?: boolean
	/** Test seam for stored bootstrap/API token lookup. */
	loadApiToken?: NonNullable<
		Parameters<typeof resolveScopedApiToken>[0]
	>['loadApiToken']
}): boolean {
	if (hasExplicitTokenFlag(input.tokenValues)) return true
	if (!input.allowEnvWithoutLogin) return false
	if (
		!resolveScopedApiToken({
			tokenValues: input.tokenValues,
			env: input.env,
			apiUrl: input.apiUrl,
			loadApiToken: input.loadApiToken,
		})
	) {
		return false
	}
	const loggedIn =
		input.hasSession ??
		loadCredentials(input.mcpUrl, undefined, undefined, {
			org: input.org,
		}) != null
	return !loggedIn
}
