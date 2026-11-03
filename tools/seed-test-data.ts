import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fail, runWrangler } from './ci/resource-utils.ts'
import { createPasswordHash } from '@kody-internal/shared/password-hash.ts'
import {
	localPersistEnv,
	resolveLocalD1PersistPath,
} from './local-d1-persist.ts'
import { isExecutedDirectly } from './node-runtime.ts'
import {
	buildClearUnrequestedPreviewSeedFlagsSql,
	buildSeedFeatureFlagOverrideSql,
	buildSeedIntegrationSql,
	buildSeedSavedPackagesSql,
	buildSeedTeamOrgSql,
	buildSeedUserSql,
} from './seed-sql.ts'
import { parsePlanName, planNames, type PlanName } from '#universal/plans.ts'
import { usernameFromEmail } from '../packages/worker/src/identity/username.ts'
import {
	isFeatureFlagKey,
	type FeatureFlagKey,
} from '#universal/feature-flags/registry.ts'
import {
	isPreviewSeedFlagKey,
	previewSeedFlagRejection,
} from './preview-seed-flag-allowlist.ts'
import {
	getDefaultWranglerConfigPath,
	resolveWranglerConfigPath,
} from './wrangler-env-config.ts'

type CliOptions = {
	email: string
	username: string
	password: string
	local: boolean
	remote: boolean
	admin: boolean
	env?: string
	config?: string
	persistTo?: string
	/** Local-only: metadata-only saved_packages per seeded account. */
	savedPackages?: number
	/**
	 * Per-user feature flag overrides forced on. Any registry key locally.
	 * With `--remote`, only preview env and the committed preview allowlist.
	 */
	enableFlags: Array<FeatureFlagKey>
	/** Second verified non-admin account, same password as the primary. */
	memberEmail?: string
	/** Team org owned by the primary with the member account and one team. */
	teamOrg?: string
	/** Forces the primary personal org plan (remote: preview only). */
	plan?: PlanName
}

const defaultTestEmail = 'kody@example.com'
const defaultTestUsername = 'kody'
const defaultTestPassword = 'ilikecode'
// Companion non-admin fixture so RBAC flows can be tested from both sides.
const regularTestEmail = 'jane@example.com'
const regularTestUsername = 'jane'

const usageLine = `Usage: node tools/seed-test-data.ts [--local|--remote] [--admin|--no-admin] [--env <name>] [--config <path>] [--persist-to <path>] [--email <email>] [--username <username>] [--password <password>] [--saved-packages <n>] [--enable-flag <key>]... [--member-email <email>] [--team-org <slug>] [--plan <${planNames.join('|')}>]`

const maxSavedPackages = 1_000

export function parseArgs(argv: Array<string>): CliOptions {
	const options: CliOptions = {
		email: defaultTestEmail,
		username: defaultTestUsername,
		password: defaultTestPassword,
		local: false,
		remote: false,
		admin: false,
		env: undefined,
		config: undefined,
		persistTo: undefined,
		savedPackages: undefined,
		enableFlags: [],
		memberEmail: undefined,
		teamOrg: undefined,
		plan: undefined,
	}
	let usernameProvided = false
	let adminProvided = false

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index]
		if (!arg) continue

		switch (arg) {
			case '--email': {
				options.email = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--username': {
				usernameProvided = true
				options.username = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--password': {
				options.password = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--local': {
				options.local = true
				break
			}
			case '--remote': {
				options.remote = true
				break
			}
			case '--admin': {
				adminProvided = true
				options.admin = true
				break
			}
			case '--no-admin': {
				adminProvided = true
				options.admin = false
				break
			}
			case '--env': {
				options.env = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--config': {
				options.config = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--persist-to': {
				options.persistTo = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--saved-packages': {
				const raw = argv[index + 1] ?? ''
				index += 1
				if (!/^\d+$/.test(raw)) {
					fail(
						`Invalid --saved-packages value ${JSON.stringify(raw)}. Pass a positive integer.`,
					)
				}
				const count = Number(raw)
				if (!Number.isInteger(count) || count < 1 || count > maxSavedPackages) {
					fail(
						`--saved-packages must be an integer from 1 to ${maxSavedPackages}.`,
					)
				}
				options.savedPackages = count
				break
			}
			case '--enable-flag': {
				const key = argv[index + 1] ?? ''
				index += 1
				if (!key) {
					fail('Missing value for --enable-flag <key>.')
				}
				if (!isFeatureFlagKey(key)) {
					fail(
						`Unknown feature flag key ${JSON.stringify(key)}. Use a key from packages/worker/universal/feature-flags/registry.ts.`,
					)
				}
				if (!options.enableFlags.includes(key)) {
					options.enableFlags.push(key)
				}
				break
			}
			case '--member-email': {
				options.memberEmail = argv[index + 1] ?? ''
				index += 1
				if (!options.memberEmail)
					fail('Missing value for --member-email <email>.')
				break
			}
			case '--team-org': {
				options.teamOrg = argv[index + 1] ?? ''
				index += 1
				if (!options.teamOrg) fail('Missing value for --team-org <slug>.')
				break
			}
			case '--plan': {
				const raw = argv[index + 1] ?? ''
				index += 1
				const plan = parsePlanName(raw)
				if (!plan) {
					fail(
						`Invalid --plan value ${JSON.stringify(raw)}. Use one of: ${planNames.join(', ')}.`,
					)
				}
				options.plan = plan
				break
			}
			default: {
				if (arg.startsWith('-')) {
					fail([`Unknown flag: ${arg}`, usageLine].join('\n'))
				}
			}
		}
	}

	if (options.local && options.remote) {
		fail('Choose only one target mode: --local or --remote.')
	}
	if (!options.local && !options.remote) {
		options.local = true
	}
	if (!options.email) {
		fail('Missing required --email <email> value.')
	}
	const effectiveEmail = options.email
	if (!usernameProvided) {
		options.username =
			effectiveEmail === defaultTestEmail
				? defaultTestUsername
				: usernameFromEmail(effectiveEmail)
	}
	// The default fixture account is an admin so RBAC features are testable
	// out of the box; custom accounts stay non-admin unless requested.
	if (!adminProvided) {
		options.admin = effectiveEmail === defaultTestEmail
	}
	if (!options.username) {
		fail('Missing required --username <username> value.')
	}
	if (!options.password) {
		fail('Missing required --password <password> value.')
	}
	if (options.remote && options.persistTo) {
		fail('--persist-to is only valid with --local.')
	}
	if (options.env !== undefined && options.env.length === 0) {
		fail('Missing value for --env <name>.')
	}
	if (options.config !== undefined && options.config.length === 0) {
		fail('Missing value for --config <path>.')
	}
	if (options.persistTo !== undefined && options.persistTo.length === 0) {
		fail('Missing value for --persist-to <path>.')
	}
	options.env = resolveWranglerEnv(options)
	if (options.remote && options.savedPackages !== undefined) {
		fail(
			'--saved-packages is local-only (metadata fixtures for local account UI).',
		)
	}
	if (options.teamOrg !== undefined && !options.memberEmail) {
		fail('--team-org needs --member-email <email> for the member account.')
	}
	if (
		options.memberEmail !== undefined &&
		options.memberEmail.toLowerCase() === options.email.toLowerCase()
	) {
		fail('--member-email must differ from --email.')
	}
	if (
		options.remote &&
		options.env !== 'preview' &&
		(options.memberEmail !== undefined ||
			options.teamOrg !== undefined ||
			options.plan !== undefined)
	) {
		fail(
			`--member-email, --team-org, and --plan with --remote are only allowed when the wrangler env is preview. Refusing env ${JSON.stringify(options.env)}.`,
		)
	}
	if (options.remote && options.enableFlags.length > 0) {
		if (options.env !== 'preview') {
			fail(
				`--enable-flag with --remote is only allowed when the wrangler env is preview. Refusing env ${JSON.stringify(options.env)}.`,
			)
		}
		for (const key of options.enableFlags) {
			if (!isPreviewSeedFlagKey(key)) {
				fail(previewSeedFlagRejection(key))
			}
		}
	}

	return options
}

export function resolveWranglerEnv({
	env,
	config,
}: {
	env?: string
	config?: string
}) {
	if (env && env.length > 0) return env

	const configBaseName = basename(config ?? '').toLowerCase()
	if (configBaseName.includes('preview')) return 'preview'
	if (configBaseName.includes('test')) return 'test'
	if (configBaseName.includes('production')) return 'production'

	return process.env.CLOUDFLARE_ENV ?? 'production'
}

type SeedAccount = {
	email: string
	username: string
	passwordHash: string
	admin: boolean
	plan?: PlanName
}

export function buildSeedSql(
	accounts: Array<SeedAccount>,
	options: {
		savedPackages?: number
		enableFlags?: ReadonlyArray<FeatureFlagKey>
		/** Preview reseeds delete allowlisted flags this run is not enabling. */
		reconcilePreviewFlags?: boolean
		teamOrg?: { slug: string; ownerEmail: string; memberEmail: string }
	} = {},
) {
	const accountSql = accounts
		.flatMap((account) => {
			const parts = [
				buildSeedUserSql(account),
				buildSeedIntegrationSql(account.email),
			]
			if (options.reconcilePreviewFlags) {
				const clearSql = buildClearUnrequestedPreviewSeedFlagsSql({
					email: account.email,
					enableFlags: options.enableFlags ?? [],
				})
				if (clearSql) parts.push(clearSql)
			}
			if (options.savedPackages !== undefined) {
				parts.push(
					buildSeedSavedPackagesSql({
						email: account.email,
						count: options.savedPackages,
					}),
				)
			}
			for (const flagKey of options.enableFlags ?? []) {
				parts.push(
					buildSeedFeatureFlagOverrideSql({
						email: account.email,
						flagKey,
					}),
				)
			}
			return parts
		})
		.join('\n')
	return options.teamOrg
		? `${accountSql}\n${buildSeedTeamOrgSql(options.teamOrg)}`
		: accountSql
}

/**
 * The companion fixture uses a fixed, public password, so it is seeded for
 * local development only — never into remote (deployed) environments.
 */
export function shouldSeedCompanionAccount(
	options: Pick<CliOptions, 'local' | 'email'>,
) {
	return options.local && options.email !== regularTestEmail
}

/**
 * Build wrangler d1 execute args. Prefer `{ file }` for seed SQL — large
 * `--saved-packages` payloads exceed process argv limits when passed via
 * `--command`.
 */
export function buildSeedWranglerArgs(
	options: CliOptions,
	input: { command: string } | { file: string },
	env: NodeJS.ProcessEnv = process.env,
) {
	const args = ['d1', 'execute', 'APP_DB']
	if ('file' in input) {
		args.push('--file', input.file)
	} else {
		args.push('--command', input.command)
	}
	if (options.local) {
		args.push(
			'--local',
			'--persist-to',
			resolveLocalD1PersistPath({ explicit: options.persistTo, env }),
		)
	}
	if (options.remote) {
		args.push('--remote')
	}
	if (options.env) {
		args.push('--env', options.env)
	}
	// Wrangler cannot resolve APP_DB without the worker config; fall back to
	// the repo default (same behavior as wrangler-env.ts) when none is given.
	const configPath = options.config ?? getDefaultWranglerConfigPath()
	if (existsSync(resolveWranglerConfigPath(configPath, process.cwd()))) {
		args.push('--config', configPath)
	}
	return args
}

function executeSeedSql(
	sql: string,
	options: CliOptions,
	env: NodeJS.ProcessEnv = process.env,
) {
	// Always write SQL to a temp file so `--saved-packages N` stays under the
	// process argument size limit (wrangler --command puts the whole string
	// on argv).
	const tempDir = mkdtempSync(join(tmpdir(), 'kody-seed-sql-'))
	const sqlPath = join(tempDir, 'seed.sql')
	try {
		writeFileSync(sqlPath, sql, 'utf8')
		const result = runWrangler(
			buildSeedWranglerArgs(options, { file: sqlPath }, env),
		)
		if (result.status !== 0) {
			fail('Failed to write seed user directly to D1.')
		}
	} finally {
		rmSync(tempDir, { recursive: true, force: true })
	}
}

async function main() {
	const options = parseArgs(process.argv.slice(2))
	const passwordHash = await createPasswordHash(options.password)
	const accounts: Array<SeedAccount> = [
		{
			email: options.email,
			username: options.username,
			passwordHash,
			admin: options.admin,
			plan: options.plan,
		},
	]
	if (options.memberEmail) {
		accounts.push({
			email: options.memberEmail,
			username: usernameFromEmail(options.memberEmail),
			passwordHash,
			admin: false,
		})
	}
	if (shouldSeedCompanionAccount(options)) {
		accounts.push({
			email: regularTestEmail,
			username: regularTestUsername,
			passwordHash: await createPasswordHash(defaultTestPassword),
			admin: false,
		})
	}
	const sql = buildSeedSql(accounts, {
		savedPackages: options.savedPackages,
		enableFlags: options.enableFlags,
		reconcilePreviewFlags: options.remote && options.env === 'preview',
		teamOrg:
			options.teamOrg && options.memberEmail
				? {
						slug: options.teamOrg,
						ownerEmail: options.email,
						memberEmail: options.memberEmail,
					}
				: undefined,
	})
	executeSeedSql(sql, options, localPersistEnv())

	const primaryLabel = options.admin ? 'admin' : 'regular'
	const companionSuffix =
		accounts.length > 1 ? ` + ${accounts.length - 1} regular` : ''
	const extras: Array<string> = []
	if (options.savedPackages !== undefined) {
		extras.push(
			`${options.savedPackages} metadata-only saved package${options.savedPackages === 1 ? '' : 's'} per account`,
		)
	}
	if (options.plan) extras.push(`plan ${options.plan}`)
	if (options.teamOrg) extras.push(`team org ${options.teamOrg}`)
	if (options.enableFlags.length > 0) {
		extras.push(`flags on: ${options.enableFlags.join(', ')}`)
	}
	const extrasSuffix = extras.length > 0 ? `; ${extras.join('; ')}` : ''
	console.log(
		`Seeded ${accounts.length} test account${accounts.length > 1 ? 's' : ''} in D1 (${options.local ? 'local' : 'remote'}): 1 ${primaryLabel}${companionSuffix}${extrasSuffix}`,
	)
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
