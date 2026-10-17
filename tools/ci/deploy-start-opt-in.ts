import {
	assetManifestDigest,
	routerEntrySource,
} from './start-rollout-config.ts'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mapLiveProductionSettings } from './prepare-start-opt-in.ts'
import { assertInactiveConfig } from './start-opt-in-inactive-config.ts'
import { parseJsonc } from './resource-utils.ts'
import { isExecutedDirectly, resolveLocalBinary } from '../node-runtime.ts'

type Config = Record<string, unknown>

/** Object and binding ordering cannot change the meaning of a settings snapshot. */
function normalized(value: unknown): string {
	const bindingSets = new Set([
		'd1_databases',
		'kv_namespaces',
		'r2_buckets',
		'services',
		'workflows',
		'vectorize',
		'analytics_engine_datasets',
		'ratelimits',
		'worker_loaders',
		'send_email',
		'artifacts',
		'durable_objects.bindings',
		'queues.producers',
		'compatibility_flags',
	])
	const normalize = (entry: unknown, location = ''): unknown => {
		if (Array.isArray(entry)) {
			const values = entry.map((child) => normalize(child, `${location}[]`))
			return bindingSets.has(location)
				? values.sort((a, b) =>
						JSON.stringify(a).localeCompare(JSON.stringify(b)),
					)
				: values
		}
		if (entry && typeof entry === 'object')
			return Object.fromEntries(
				Object.entries(entry)
					.filter(([, child]) => child !== undefined)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([key, child]) => [
						key,
						normalize(child, location ? `${location}.${key}` : key),
					]),
			)
		return entry
	}
	return JSON.stringify(normalize(value))
}

/** Compare the entire snapshot, not a handpicked subset of live resource fields. */
export function assertProductionSnapshot(
	snapshot: Config,
	fresh: Config,
	snapshotSecretNames: Array<string>,
	freshSecretNames: Array<string>,
) {
	if (normalized(snapshot) !== normalized(fresh))
		throw new Error(
			'Production configuration changed after the snapshot, prepare again',
		)
	if (
		normalized([...snapshotSecretNames].sort()) !==
		normalized([...freshSecretNames].sort())
	)
		throw new Error(
			'Production secret names changed after the snapshot, prepare again',
		)
}

/** Every copied source field must survive the build, except explicit build/deploy transforms. */
export function assertSharedBindings(candidate: Config, production: Config) {
	const transformed = new Set([
		'$schema',
		'name',
		'main',
		'assets',
		'routes',
		'route',
		'custom_domains',
		'triggers',
		'migrations',
		'email',
		'dispatch_namespaces',
		'tail_consumers',
		'unsafe',
		'workers_dev',
		'preview_urls',
		// Vite owns compilation. The installed Cloudflare plugin removes
		// minify/find_additional_modules and emits its own rules/no_bundle.
		'minify',
		'find_additional_modules',
		'rules',
		'no_bundle',
	])
	for (const [key, expectedValue] of Object.entries(production)) {
		if (transformed.has(key)) continue
		let expected = expectedValue
		let actual = candidate[key]
		if (key === 'vars') {
			const expectedVars = { ...(expected as Config) }
			const actualVars = { ...(actual as Config) }
			// The candidate reports its own immutable release rather than legacy's commit.
			delete expectedVars.APP_COMMIT_SHA
			delete actualVars.APP_COMMIT_SHA
			delete expectedVars.APP_DEPLOY_INFO
			if (actualVars.APP_DEPLOY_INFO !== undefined)
				throw new Error('Candidate must not carry stale production deploy info')
			expected = expectedVars
			actual = actualVars
		}
		if (key === 'queues') {
			expected = { producers: (expected as Config).producers ?? [] }
			actual = { producers: (actual as Config | undefined)?.producers ?? [] }
		}
		if (normalized({ [key]: actual }) !== normalized({ [key]: expected }))
			throw new Error(`Shared ${key} configuration changed`)
	}
	if (
		(candidate.vars as Config)?.APP_BASE_URL !== 'https://kody.codes' ||
		(production.vars as Config)?.APP_BASE_URL !== 'https://kody.codes'
	)
		throw new Error('Production origin must remain unchanged')
}

const candidateSecretNames = [
	'COOKIE_SECRET',
	'SECRET_STORE_KEY',
	'AI_GATEWAY_ID',
	'SENTRY_DSN',
	'CAPABILITY_REINDEX_SECRET',
	'GITHUB_CLIENT_ID',
	'GITHUB_CLIENT_SECRET',
	'GOOGLE_CLIENT_ID',
	'GOOGLE_CLIENT_SECRET',
	'X_CLIENT_ID',
	'X_CLIENT_SECRET',
	'DISCORD_CLIENT_ID',
	'DISCORD_CLIENT_SECRET',
	'DISCORD_BOT_TOKEN',
	'DISCORD_GUILD_ID',
	'DISCORD_MEMBER_ROLE_ID',
	'DISCORD_STANDARD_ROLE_ID',
	'DISCORD_PRO_ROLE_ID',
	'KIT_API_KEY',
	'STRIPE_SECRET_KEY',
	'STRIPE_WEBHOOK_SECRET',
	'STATUS_INCIDENT_EVENT_SECRET',
	'YOUTUBE_DATA_API_KEY',
	'OIDC_SIGNING_PRIVATE_KEY_PEM',
	'OIDC_SIGNING_KEY_ID',
	'CLOUDFLARE_CUSTOM_HOSTNAMES_API_TOKEN',
	'PACKAGE_APP_TICKET_KEYS',
	'TURNSTILE_SITE_KEY',
	'TURNSTILE_SECRET_KEY',
] as const

// These credentials belong only to legacy /__maintenance protocols and the
// legacy scheduled exporter. Start website/server routes do not import DR;
// the routing worker always sends maintenance requests to legacy, and the
// candidate declares no scheduled triggers or queue consumers.
const legacyProtocolOnlySecrets = new Set([
	'DR_RESTORE_SECRET',
	'DR_BACKUP_ACCESS_KEY_ID',
	'DR_BACKUP_SECRET_ACCESS_KEY',
	'DR_BACKUP_ACCOUNT_ID',
	'DR_BACKUP_BUCKET_NAME',
])

export function collectCandidateSecrets(
	liveNames: Array<string>,
	environment: NodeJS.ProcessEnv,
) {
	const secrets: Record<string, string> = {}
	const allowed = new Set<string>([
		...candidateSecretNames,
		'CLOUDFLARE_API_TOKEN',
	])
	if (
		!Array.isArray(liveNames) ||
		liveNames.some(
			(name) =>
				typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
		)
	)
		throw new Error('Live secret-name inventory is invalid')
	const unmapped = new Set<string>()
	const unavailable = new Set<string>()
	for (const name of liveNames) {
		if (legacyProtocolOnlySecrets.has(name)) continue
		if (!allowed.has(name)) {
			unmapped.add(name)
			continue
		}
		const value =
			environment[
				name === 'CLOUDFLARE_API_TOKEN' ? 'CLOUDFLARE_APP_API_TOKEN' : name
			]
		if (!value) unavailable.add(name)
		else secrets[name] = value
	}
	for (const name of [
		'COOKIE_SECRET',
		'SECRET_STORE_KEY',
		'TURNSTILE_SITE_KEY',
		'TURNSTILE_SECRET_KEY',
	]) {
		if (!environment[name]?.trim()) unavailable.add(name)
		else secrets[name] = environment[name]!
	}
	const failures = [
		...(unmapped.size
			? [`Missing reviewed secret mappings: ${[...unmapped].sort().join(', ')}`]
			: []),
		...(unavailable.size
			? [
					`Trusted production secrets unavailable: ${[...unavailable].sort().join(', ')}`,
				]
			: []),
	]
	if (failures.length) throw new Error(failures.join('; '))
	return secrets
}

async function cf(endpoint: string, allowMissing = false) {
	const response = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/${endpoint}`,
		{
			headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` },
		},
	)
	const body = (await response.json()) as {
		success?: boolean
		result?: unknown
		errors?: Array<{ code: number }>
	}
	if (
		allowMissing &&
		response.status === 404 &&
		body.errors?.some((error) => error.code === 10007)
	)
		return null
	if (!response.ok || body.success !== true)
		throw new Error(`Cloudflare verification failed: ${response.status}`)
	return body.result
}

/** Wrangler resolves tsconfig against cwd, then esbuild uses the source project root. */
export function inactiveDeployInvocation(
	config: string,
	name: string,
	secretsFile: string,
	repositoryRoot = process.cwd(),
) {
	const absoluteConfig = path.resolve(repositoryRoot, config)
	// Keep the router source config and its main/tsconfig paths in one directory.
	// The emitted candidate is already bundled and keeps its existing invocation.
	const cwd = /^kody-start-router-[a-f0-9]{40}$/.test(name)
		? path.dirname(absoluteConfig)
		: repositoryRoot
	return {
		cwd,
		args: [
			'deploy',
			'--config',
			path.relative(cwd, absoluteConfig),
			'--name',
			name,
			'--secrets-file',
			path.resolve(repositoryRoot, secretsFile),
		],
	}
}

export function assertBindingSizes(
	config: Config,
	secrets: Record<string, string>,
) {
	const vars = (config.vars ?? {}) as Config
	for (const [name, value] of [
		...Object.entries(vars),
		...Object.entries(secrets),
	]) {
		const text = typeof value === 'string' ? value : JSON.stringify(value)
		if (Buffer.byteLength(text, 'utf8') > 5120)
			throw new Error(`Cloudflare text binding exceeds 5120 bytes: ${name}`)
	}
}

async function deploy(
	config: string,
	name: string,
	secrets: Record<string, string>,
	dryRun = false,
) {
	const directory = await mkdtemp(path.join(tmpdir(), 'kody-start-secrets-'))
	try {
		const file = path.join(directory, 'secrets.json')
		await writeFile(file, JSON.stringify(secrets), { mode: 0o600 })
		// Do not expose application secrets as build-time environment variables.
		const env = Object.fromEntries(
			[
				'PATH',
				'HOME',
				'CI',
				'CLOUDFLARE_API_TOKEN',
				'CLOUDFLARE_ACCOUNT_ID',
			].flatMap((key) => (process.env[key] ? [[key, process.env[key]!]] : [])),
		)
		const binary = resolveLocalBinary('wrangler')
		const invocation = inactiveDeployInvocation(config, name, file)
		if (dryRun)
			invocation.args.push(
				'--dry-run',
				'--outdir',
				path.join(directory, 'build'),
			)
		await new Promise<void>((resolve, reject) => {
			const child = spawn(binary, invocation.args, {
				cwd: invocation.cwd,
				env,
				stdio: 'inherit',
			})
			child.once('error', reject)
			child.once('close', (code) =>
				code === 0
					? resolve()
					: reject(new Error(`Inactive deployment failed: ${code}`)),
			)
		})
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
}

if (isExecutedDirectly(import.meta.url)) {
	const release = process.env.KODY_START_RELEASE ?? ''
	if (!/^[a-f0-9]{40}$/.test(release))
		throw new Error('Pinned release required')
	if (
		!/^[a-f0-9]{32}$/.test(process.env.CLOUDFLARE_ACCOUNT_ID ?? '') ||
		!process.env.CLOUDFLARE_API_TOKEN
	)
		throw new Error('Cloudflare deployment credentials required')
	const candidateName = `kody-start-${release}`
	const routerName = `kody-start-router-${release}`
	const candidate = JSON.parse(
		await readFile('dist/server/wrangler.json', 'utf8'),
	) as Config
	const router = JSON.parse(
		await readFile('.tmp/start-opt-in/router.json', 'utf8'),
	) as Config
	assertInactiveConfig(candidate, candidateName)
	assertInactiveConfig(router, routerName)
	if (router.main !== './start-entry.generated.ts')
		throw new Error('Router must use the reviewed compiled manifest entry')
	const liveNames = JSON.parse(
		await readFile('.tmp/start-opt-in/secret-names.json', 'utf8'),
	) as Array<string>
	const candidateSecrets = collectCandidateSecrets(liveNames, process.env)
	// Read the known production worker first. Permission failures must never mean absent.
	const production = JSON.parse(
		await readFile('.tmp/start-opt-in/production.json', 'utf8'),
	) as Config
	assertSharedBindings(candidate, production)
	const liveSettings = (await cf(
		'workers/scripts/kody-production/settings',
	)) as Config
	const base = parseJsonc<Config>(
		await readFile('packages/worker/wrangler.jsonc', 'utf8'),
	)
	assertProductionSnapshot(
		production,
		mapLiveProductionSettings(base, liveSettings),
		liveNames,
		(liveSettings.bindings as Array<Config>)
			.filter((binding) => binding.type === 'secret_text')
			.map((binding) => String(binding.name)),
	)
	for (const name of [candidateName, routerName]) {
		if ((await cf(`workers/scripts/${name}/settings`, true)) !== null)
			throw new Error(`Refusing to overwrite existing worker ${name}`)
	}
	const rolloutSecret = randomBytes(32).toString('hex')
	console.log(`::add-mask::${rolloutSecret}`)
	if (rolloutSecret === candidateSecrets.COOKIE_SECRET)
		throw new Error('Rollout secret must be distinct')
	const routerConfig =
		'packages/start-routing-worker/wrangler-start.generated.json'
	await writeFile(routerConfig, JSON.stringify(router, null, '\t'))
	const review = JSON.parse(
		await readFile('.tmp/start-opt-in/review.json', 'utf8'),
	) as { manifest: { release: string; assetPaths: string[] } }
	if (
		review.manifest.release !== release ||
		(router.vars as Config).START_ASSET_MANIFEST_SHA256 !==
			assetManifestDigest(review.manifest.assetPaths)
	)
		throw new Error('Router compiled manifest does not match reviewed release')
	await writeFile(
		'packages/start-routing-worker/start-entry.generated.ts',
		routerEntrySource(release, review.manifest.assetPaths),
	)
	const routerSecrets = {
		COOKIE_SECRET: candidateSecrets.COOKIE_SECRET!,
		START_ROLLOUT_SECRET: rolloutSecret,
	}
	assertBindingSizes(candidate, candidateSecrets)
	assertBindingSizes(router, routerSecrets)
	// Compile all router source before creating either immutable worker.
	await deploy(routerConfig, routerName, routerSecrets, true)
	await deploy('dist/server/wrangler.json', candidateName, candidateSecrets)
	await deploy(routerConfig, routerName, routerSecrets)
	for (const name of [candidateName, routerName]) {
		const subdomain = (await cf(`workers/scripts/${name}/subdomain`)) as {
			enabled?: boolean
			previews_enabled?: boolean
		}
		if (subdomain.enabled !== false || subdomain.previews_enabled !== false)
			throw new Error(`Worker ${name} unexpectedly exposes a public preview`)
	}
	await writeFile(
		'.tmp/start-opt-in/deployed.json',
		JSON.stringify(
			{ release, candidateName, routerName, activated: false },
			null,
			'\t',
		),
	)
	await writeFile(
		'.tmp/start-opt-in/controller.json',
		JSON.stringify({
			controller: process.env.GITHUB_SHA,
			release,
			deploymentRun: process.env.GITHUB_RUN_ID,
			verificationRun: process.env.GITHUB_RUN_ID,
		}),
	)
	console.log(
		'Deployed isolated workers without activating routes. Live production traffic is unchanged.',
	)
}
