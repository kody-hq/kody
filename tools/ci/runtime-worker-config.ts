import { readFile, writeFile } from 'node:fs/promises'
import {
	dynamicCallableWorkflowName,
	listPackageAppHostnames,
	packageAppApexRoutePattern,
	packageAppCustomHostnameCatchAllRoutePattern,
	packageAppWildcardRoutePattern,
	parseJsonc,
	readPackageAppZoneName,
	setArtifactsNamespaceOnWranglerEnv,
} from './resource-utils.ts'
import { isExecutedDirectly } from '../node-runtime.ts'

/**
 * Generate deployable Wrangler configs for the package runtime Worker
 * (ADR 0016) from the committed base config plus the main Worker's generated
 * config.
 *
 * The runtime Worker shares the main Worker's data plane (same D1 databases,
 * KV namespaces, R2 buckets, queues), so resource identifiers are copied
 * from the main Worker's already-provisioned generated config rather than
 * re-provisioned. Cross-script references (`script_name`, `from_script`,
 * `service`) committed as `kody`/`kody-runtime` are rewritten to the actual
 * worker names, which lets preview deploys use per-PR names.
 *
 * The runtime Worker never binds the main Worker, so it deploys before the
 * main Worker in every environment (callee-first). Its only circular edge is
 * with the platform Worker; `tools/ci/platform-worker-config.ts` breaks that
 * with a platform bootstrap config.
 */

const defaultBaseConfigPath = 'packages/runtime-worker/wrangler.jsonc'
const committedRuntimeName = 'kody-runtime'
const committedPlatformName = 'kody-platform'
const committedMainName = 'kody'

type JsonRecord = Record<string, unknown>

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

function asRecord(value: unknown, label: string): JsonRecord {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		fail(`${label} is not an object.`)
	}
	return value as JsonRecord
}

function getEnvSection(config: JsonRecord, envName: string, label: string) {
	const env = asRecord(config.env, `${label} "env"`)
	return asRecord(env[envName], `${label} "env.${envName}"`)
}

/**
 * Rewrite committed worker-name references (`script_name`, `from_script`,
 * `service` values) to the resolved deploy names, anywhere in the config.
 */
function rewriteWorkerNameReferences(
	value: unknown,
	names: {
		runtimeWorkerName: string
		platformWorkerName: string
		mainWorkerName: string
	},
): void {
	if (Array.isArray(value)) {
		for (const entry of value) rewriteWorkerNameReferences(entry, names)
		return
	}
	if (!value || typeof value !== 'object') return
	const record = value as JsonRecord
	for (const key of ['script_name', 'from_script', 'service']) {
		if (record[key] === committedRuntimeName) {
			record[key] = names.runtimeWorkerName
		} else if (record[key] === committedPlatformName) {
			record[key] = names.platformWorkerName
		} else if (record[key] === committedMainName) {
			record[key] = names.mainWorkerName
		}
	}
	for (const child of Object.values(record)) {
		rewriteWorkerNameReferences(child, names)
	}
}

function findByKey(
	entries: unknown,
	key: string,
	value: string,
): JsonRecord | undefined {
	if (!Array.isArray(entries)) return undefined
	return entries.find(
		(entry) =>
			entry &&
			typeof entry === 'object' &&
			(entry as JsonRecord)[key] === value,
	) as JsonRecord | undefined
}

/**
 * Copy provisioned resource identifiers from the main Worker's generated env
 * into the runtime env, matched by binding name. The runtime Worker binds a
 * strict subset of the main Worker's resources; every runtime binding must
 * resolve or the deploy would target the wrong (or a nonexistent) resource.
 */
function copyResourceIdentifiers(input: {
	runtimeEnv: JsonRecord
	mainEnv: JsonRecord
	envName: string
}) {
	const { runtimeEnv, mainEnv, envName } = input

	const copies: Array<{
		section: string
		key: string
		fields: Array<string>
		/** The base config's value is complete when the main Worker lacks it. */
		mainOptional?: boolean
	}> = [
		{
			section: 'd1_databases',
			key: 'binding',
			fields: ['database_name', 'database_id'],
		},
		{ section: 'kv_namespaces', key: 'binding', fields: ['id', 'title'] },
		{ section: 'r2_buckets', key: 'binding', fields: ['bucket_name'] },
		{ section: 'vectorize', key: 'binding', fields: ['index_name'] },
		{
			section: 'analytics_engine_datasets',
			key: 'binding',
			fields: ['dataset'],
			// Analytics Engine datasets are created on first write, so a
			// runtime-only dataset (one only this Worker writes) needs nothing
			// provisioned by the main Worker.
			mainOptional: true,
		},
		// Service bindings (the JOBS binding to the jobs worker): the main
		// generated config carries the resolved per-environment worker name
		// (`kody-jobs` in production, `<worker>-jobs` in preview).
		{ section: 'services', key: 'binding', fields: ['service'] },
	]
	for (const { section, key, fields, mainOptional } of copies) {
		const runtimeEntries = runtimeEnv[section]
		if (!Array.isArray(runtimeEntries)) continue
		for (const entry of runtimeEntries) {
			const record = asRecord(entry, `runtime env.${envName}.${section} entry`)
			const bindingName = record[key]
			if (typeof bindingName !== 'string') {
				fail(`runtime env.${envName}.${section} entry is missing "${key}".`)
			}
			const mainEntry = findByKey(mainEnv[section], key, bindingName)
			if (!mainEntry) {
				if (mainOptional) continue
				fail(
					`main generated config env.${envName}.${section} has no entry for binding "${bindingName}" required by the runtime worker.`,
				)
			}
			for (const field of fields) {
				if (mainEntry[field] !== undefined) record[field] = mainEntry[field]
			}
		}
	}

	const runtimeQueues = runtimeEnv.queues
	if (runtimeQueues && typeof runtimeQueues === 'object') {
		const runtimeProducers = (runtimeQueues as JsonRecord).producers
		const mainProducers =
			mainEnv.queues && typeof mainEnv.queues === 'object'
				? (mainEnv.queues as JsonRecord).producers
				: undefined
		if (Array.isArray(runtimeProducers)) {
			for (const entry of runtimeProducers) {
				const record = asRecord(
					entry,
					`runtime env.${envName}.queues.producers entry`,
				)
				const bindingName = record.binding
				if (typeof bindingName !== 'string') {
					fail(`runtime env.${envName}.queues.producers entry missing binding.`)
				}
				const mainEntry = findByKey(mainProducers, 'binding', bindingName)
				if (!mainEntry) {
					fail(
						`main generated config env.${envName}.queues.producers has no entry for binding "${bindingName}" required by the runtime worker.`,
					)
				}
				record.queue = mainEntry.queue
			}
		}
	}

	// The runtime Worker needs the main Worker's resolved app config (base
	// URLs, email domains, deploy environment) plus its own overrides.
	const mainVars =
		mainEnv.vars && typeof mainEnv.vars === 'object'
			? (mainEnv.vars as JsonRecord)
			: {}
	const runtimeVars =
		runtimeEnv.vars && typeof runtimeEnv.vars === 'object'
			? (runtimeEnv.vars as JsonRecord)
			: {}
	const mergedVars: JsonRecord = { ...mainVars, ...runtimeVars }
	runtimeEnv.vars = mergedVars
	// GitHub deploy overlays (`PACKAGE_APP_LEGACY_*`) land on the main
	// Worker's generated config. Runtime committed vars then overwrite the
	// merge, which would discard a non-empty overlay and publish zone routes
	// for the committed list only. Prefer the main Worker's already-overlaid
	// values for those keys so dual-serve hosts stay in lockstep.
	applyMainWorkerPackageAppOverlayVars({
		mergedVars,
		mainVars,
	})

	// Same as platform: prefer the origin-generated per-PR Artifacts namespace
	// over the committed preview template value.
	const artifactsNamespace = mainVars.ARTIFACTS_NAMESPACE
	if (typeof artifactsNamespace === 'string' && artifactsNamespace.length > 0) {
		setArtifactsNamespaceOnWranglerEnv(runtimeEnv, artifactsNamespace)
	}
}

const packageAppOverlayVarNames = [
	'PACKAGE_APP_LEGACY_HOSTS',
	'PACKAGE_APP_LEGACY_REDIRECT',
] as const

function applyMainWorkerPackageAppOverlayVars(input: {
	mergedVars: JsonRecord
	mainVars: JsonRecord
}) {
	for (const key of packageAppOverlayVarNames) {
		const mainValue = input.mainVars[key]
		if (typeof mainValue === 'string' && mainValue.length > 0) {
			input.mergedVars[key] = mainValue
		}
	}
}

/**
 * Attach the package-app apex and the per-user subdomain wildcard as **zone
 * routes** on this Worker (decision 0017). The main Worker's generated config
 * does not list the package-app host (see tools/ci/resource-utils.ts), so
 * the runtime Worker owns both routes.
 *
 * Neither may be a Cloudflare custom domain. Wildcards cannot be custom
 * domains at all, and a custom domain must not coexist with published zone
 * routes in the same zone: replacing a zone's route table during deploy
 * detaches any Workers custom domain in that zone and deletes its DNS
 * record. Both hostnames are instead served by proxied placeholder DNS
 * records that production CI ensures separately (zone routes do not create
 * DNS records).
 *
 * `PACKAGE_APP_LEGACY_HOSTS` entries get the same apex + wildcard zone
 * routes so the dual-served package-app zone stays in the published set
 * alongside `PACKAGE_APP_BASE_URL` (omitting a listed host detaches it).
 */
function addPackageAppRoute(runtimeEnv: JsonRecord, envName: string) {
	const vars =
		runtimeEnv.vars && typeof runtimeEnv.vars === 'object'
			? (runtimeEnv.vars as JsonRecord)
			: {}
	const packageAppBaseUrl = vars.PACKAGE_APP_BASE_URL
	if (typeof packageAppBaseUrl !== 'string' || !packageAppBaseUrl.trim()) {
		return
	}
	let hostnames: Array<string>
	try {
		hostnames = listPackageAppHostnames({
			packageAppBaseUrl,
			packageAppLegacyHosts:
				typeof vars.PACKAGE_APP_LEGACY_HOSTS === 'string'
					? vars.PACKAGE_APP_LEGACY_HOSTS
					: null,
		})
	} catch {
		fail(
			`runtime env.${envName}.vars.PACKAGE_APP_BASE_URL is not a valid URL: ${packageAppBaseUrl}`,
		)
	}
	if (hostnames.length === 0) return

	const publishedPatterns = new Set<string>()
	const newRoutes: Array<Record<string, unknown>> = []
	const catchAllPattern = packageAppCustomHostnameCatchAllRoutePattern()
	// Catch-all only on the canonical SaaS zone. Legacy dual-served hosts may
	// sit in a shared zone (e.g. legacy-apps.example.org → example.org); a
	// `*/*` there would steal unrelated hostnames without more-specific routes.
	// Remove when: production `PACKAGE_APP_LEGACY_HOSTS` is empty and legacy `/packages` mount and `/_kody/auth` hits stay at zero.
	const canonicalHostname = hostnames[0]
	if (!canonicalHostname) return
	const canonicalZoneName = readPackageAppZoneName(canonicalHostname)
	if (!canonicalZoneName) {
		fail(
			`runtime env.${envName}.vars package-app host "${canonicalHostname}" has no registrable zone name. Use a hostname on a public suffix (for example kody.run).`,
		)
	}
	for (const hostname of hostnames) {
		const zoneName = readPackageAppZoneName(hostname)
		if (!zoneName) {
			fail(
				`runtime env.${envName}.vars package-app host "${hostname}" has no registrable zone name. Use a hostname on a public suffix (for example kody.run).`,
			)
		}
		const apexPattern = packageAppApexRoutePattern(hostname)
		const wildcardPattern = packageAppWildcardRoutePattern(hostname)
		publishedPatterns.add(hostname)
		publishedPatterns.add(apexPattern)
		publishedPatterns.add(wildcardPattern)
		newRoutes.push(
			{ pattern: apexPattern, zone_name: zoneName },
			{ pattern: wildcardPattern, zone_name: zoneName },
		)
	}
	// Cloudflare for SaaS custom hostnames on the canonical zone (ADR 0071).
	// Apex/wildcard routes stay more specific for first-party package-app traffic.
	publishedPatterns.add(catchAllPattern)
	newRoutes.push({
		pattern: catchAllPattern,
		zone_name: canonicalZoneName,
	})
	const existingRoutes = Array.isArray(runtimeEnv.routes)
		? runtimeEnv.routes.filter((route) => {
				if (!route || typeof route !== 'object') return true
				const pattern = (route as JsonRecord).pattern
				if (typeof pattern !== 'string') return true
				// Replace `*/*` only on the canonical SaaS zone so a base config
				// (or `--base-config`) can keep a different-zone catch-all.
				if (pattern === catchAllPattern) {
					const zoneName = (route as JsonRecord).zone_name
					return zoneName !== canonicalZoneName
				}
				return !publishedPatterns.has(pattern)
			})
		: []
	runtimeEnv.routes = [...existingRoutes, ...newRoutes]
	// Keep the workers.dev trigger as the deploy healthcheck target and a
	// backup access path (publishing routes would otherwise disable it).
	runtimeEnv.workers_dev = true
}

export type CliOptions = {
	envName: string
	mainConfigPath: string
	runtimeWorkerName: string
	platformWorkerName: string
	mainWorkerName: string
	baseConfigPath: string
	outConfigPath: string
}

function parseArgs(argv: Array<string>): CliOptions {
	const options: Record<string, string> = {}
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index]
		const value = argv[index + 1]
		if (!flag?.startsWith('--') || value === undefined) {
			fail(`Invalid argument pair: ${flag ?? ''} ${value ?? ''}`)
		}
		options[flag.slice(2)] = value
	}
	const envName = options.env
	const mainConfigPath = options['main-config']
	const runtimeWorkerName = options['worker-name']
	const mainWorkerName = options['main-worker-name']
	const outConfigPath = options['out-config']
	if (
		!envName ||
		!mainConfigPath ||
		!runtimeWorkerName ||
		!mainWorkerName ||
		!outConfigPath
	) {
		fail(
			'Usage: node tools/ci/runtime-worker-config.ts generate --env <production|preview> --main-config <path> --worker-name <runtime worker name> --main-worker-name <main worker name> --out-config <path> [--base-config <path>] [--platform-worker-name <platform worker name>]',
		)
	}
	return {
		envName,
		mainConfigPath,
		runtimeWorkerName,
		platformWorkerName:
			options['platform-worker-name'] ?? committedPlatformName,
		mainWorkerName,
		baseConfigPath: options['base-config'] ?? defaultBaseConfigPath,
		outConfigPath,
	}
}

export async function generate(options: CliOptions) {
	const names = {
		runtimeWorkerName: options.runtimeWorkerName,
		platformWorkerName: options.platformWorkerName,
		mainWorkerName: options.mainWorkerName,
	}

	const runtimeConfig = parseJsonc<JsonRecord>(
		await readFile(options.baseConfigPath, 'utf8'),
	)
	const mainConfig = parseJsonc<JsonRecord>(
		await readFile(options.mainConfigPath, 'utf8'),
	)

	const runtimeEnv = getEnvSection(
		runtimeConfig,
		options.envName,
		`runtime config "${options.baseConfigPath}"`,
	)
	const mainEnv = getEnvSection(
		mainConfig,
		options.envName,
		`main generated config "${options.mainConfigPath}"`,
	)

	runtimeConfig.name = options.runtimeWorkerName
	// Pin the selected env's name too. Wrangler otherwise deploys and
	// secret-bulks `--env production` as `<name>-production`, which would not
	// match the main worker's cross-script bindings (`kody-runtime`).
	runtimeEnv.name = options.runtimeWorkerName
	delete runtimeConfig.$schema
	copyResourceIdentifiers({
		runtimeEnv,
		mainEnv,
		envName: options.envName,
	})
	rewriteWorkerNameReferences(runtimeConfig, names)
	if (Array.isArray(runtimeEnv.workflows)) {
		// Renaming assumes the single dynamic-callable workflow; a second
		// entry would silently receive the same name and bind the wrong
		// workflow, so fail loudly instead.
		if (runtimeEnv.workflows.length > 1) {
			fail(
				`runtime env.${options.envName}.workflows declares ${String(runtimeEnv.workflows.length)} entries; the generator only knows how to name the single dynamic-callable workflow. Extend the naming logic before adding workflows.`,
			)
		}
		const workflowName = dynamicCallableWorkflowName(options.runtimeWorkerName)
		for (const entry of runtimeEnv.workflows) {
			if (entry && typeof entry === 'object') {
				;(entry as JsonRecord).name = workflowName
			}
		}
	}
	addPackageAppRoute(runtimeEnv, options.envName)
	await writeFile(
		options.outConfigPath,
		`${JSON.stringify(runtimeConfig, null, '\t')}\n`,
	)
	console.error(`Wrote runtime worker config: ${options.outConfigPath}`)

	// Point the main Worker's generated config at the resolved runtime worker
	// name (in place), and align the cross-script workflow name.
	rewriteWorkerNameReferences(mainConfig, names)
	const mainEnvAfterRewrite = getEnvSection(
		mainConfig,
		options.envName,
		`main generated config "${options.mainConfigPath}"`,
	)
	if (Array.isArray(mainEnvAfterRewrite.workflows)) {
		const workflowName = dynamicCallableWorkflowName(options.runtimeWorkerName)
		for (const entry of mainEnvAfterRewrite.workflows) {
			if (
				entry &&
				typeof entry === 'object' &&
				(entry as JsonRecord).script_name === options.runtimeWorkerName
			) {
				;(entry as JsonRecord).name = workflowName
			}
		}
	}
	await writeFile(
		options.mainConfigPath,
		`${JSON.stringify(mainConfig, null, '\t')}\n`,
	)
	console.error(
		`Patched main worker config in place: ${options.mainConfigPath}`,
	)

	console.log(`runtime_wrangler_config=${options.outConfigPath}`)
}

export async function main() {
	const [command, ...rest] = process.argv.slice(2)
	if (command !== 'generate') {
		fail('Usage: node tools/ci/runtime-worker-config.ts generate ...')
	}
	await generate(parseArgs(rest))
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
