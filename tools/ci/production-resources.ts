import { readFile, writeFile } from 'node:fs/promises'
import {
	defaultDmarcReportForwardTo,
	deleteEmailSendingEventSubscriptionIfPresent,
	ensureArtifactsAccountEventSubscription,
	ensureCloudflareQueue,
	ensureD1Database,
	ensureDmarcEmailRoutingRule,
	ensureDmarcReportingTxtRecords,
	ensureEmailSendingEventSubscription,
	ensurePackageAppDnsRecords,
	ensureR2Bucket,
	fail,
	isValidBareHostname,
	listCloudflareQueues,
	listKvNamespaces,
	listPackageAppHostnames,
	parseJsonc,
	runWrangler,
	truncateWithSuffix,
	writeGeneratedWranglerConfig,
} from './resource-utils.ts'
import { parseProductionQueueResources } from './production-queue-resources.ts'
import { defaultProductionEntryPath } from '../check-origin-production-exports.ts'
import { isExecutedDirectly } from '../node-runtime.ts'
import {
	inspectOriginProductionScriptState,
	originBootstrapConfigPath,
	planOriginProductionDeploy,
	stripOriginBindingsForLocallyOwnedClasses,
	stripOriginDurableObjectMigrations,
	writeOriginBootstrapWranglerConfig,
	type OriginProductionScriptState,
} from './origin-production-deploy-state.ts'

type Command = 'ensure'

type CliOptions = {
	wranglerConfigPath: string
	outConfigPath: string
	dryRun: boolean
	d1Location?: string
	kvTitleOverride?: string
}

type ResolvedProductionBindings = {
	workerName: string
	d1DatabaseName: string
	d1ConfiguredId: string
	auditD1DatabaseName: string
	auditD1ConfiguredId: string
	oauthKvTitle: string
	oauthKvConfiguredId: string
	bundleArtifactsKvTitle: string
	bundleArtifactsKvConfiguredId: string
	communityAssetsBucketName: string
	emailBlobsBucketName: string
	repoSessionBlobsBucketName: string
	operatorBackupsBucketName: string
	emailDeliveryQueueName: string
	emailDeliveryDeadLetterQueueName: string
	artifactsRepoEventsQueueName: string
	artifactsRepoEventsDeadLetterQueueName: string
	platformFeedbackDispatchQueueName: string
	platformFeedbackDispatchDeadLetterQueueName: string
	communityActivityDispatchQueueName: string
	communityActivityDispatchDeadLetterQueueName: string
	communityListingPublishedDispatchQueueName: string
	communityListingPublishedDispatchDeadLetterQueueName: string
	packageEventsDispatchQueueName: string
	packageEventsDispatchDeadLetterQueueName: string
	webhookDispatchQueueName: string
	webhookDispatchDeadLetterQueueName: string
	committedUserEmailDomain: string | null
	committedSystemEmailDomain: string | null
	packageAppHostname: string | null
	packageAppLegacyHostnames: Array<string>
}

function parseArgs(argv: Array<string>): {
	command: Command
	options: CliOptions
} {
	const command = argv[0]
	if (command !== 'ensure') {
		fail(
			'Missing or invalid command. Usage: node tools/ci/production-resources.ts ensure [--out-config <path>]',
		)
	}

	const options: CliOptions = {
		wranglerConfigPath: 'packages/worker/wrangler.jsonc',
		outConfigPath: 'packages/worker/wrangler-production.generated.json',
		dryRun: false,
		d1Location: undefined,
		kvTitleOverride: undefined,
	}

	for (let index = 1; index < argv.length; index += 1) {
		const arg = argv[index]
		if (!arg) continue

		switch (arg) {
			case '--wrangler-config': {
				options.wranglerConfigPath = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--out-config': {
				options.outConfigPath = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--d1-location': {
				options.d1Location = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--kv-title': {
				options.kvTitleOverride = argv[index + 1] ?? ''
				index += 1
				break
			}
			case '--dry-run': {
				options.dryRun = true
				break
			}
			default: {
				if (arg.startsWith('-')) {
					fail(`Unknown flag: ${arg}`)
				}
			}
		}
	}

	if (!options.wranglerConfigPath) {
		fail('Missing required flag: --wrangler-config <path>')
	}
	if (!options.outConfigPath) {
		fail('Missing required flag: --out-config <path>')
	}

	return { command, options }
}

export function defaultOauthKvTitle(workerName: string) {
	return truncateWithSuffix(workerName, '-oauth', 63)
}

function defaultBundleArtifactsKvTitle(workerName: string) {
	return truncateWithSuffix(workerName, '-bundle-artifacts', 63)
}

function resolveEmailSendingDomain(input: {
	dryRun: boolean
	committedUserEmailDomain: string | null
}) {
	const configured = process.env.USER_EMAIL_DOMAIN?.trim()
		.toLowerCase()
		.replace(/\.$/, '')
	// An invalid explicit value fails the deploy instead of silently falling
	// through: falling back would rederive the domain from APP_BASE_URL and
	// could repoint the Email Sending subscription at an unverified domain.
	if (configured && !isValidBareHostname(configured)) {
		fail(`USER_EMAIL_DOMAIN is not a valid bare hostname: ${configured}`)
	}
	if (configured) return configured
	// The committed wrangler.jsonc var pins the user email domain across a
	// domain migration: without it, flipping the APP_BASE_URL repository
	// variable would rederive the domain from the new hostname and repoint
	// the Email Sending event subscription at an unverified domain.
	if (input.committedUserEmailDomain) {
		if (!isValidBareHostname(input.committedUserEmailDomain)) {
			fail(
				`Committed USER_EMAIL_DOMAIN in wrangler.jsonc is not a valid bare hostname: ${input.committedUserEmailDomain}`,
			)
		}
		return input.committedUserEmailDomain
	}
	const appBaseUrl = process.env.APP_BASE_URL?.trim()
	if (!appBaseUrl) {
		if (input.dryRun) return 'inbox.example.com'
		fail(
			'Missing APP_BASE_URL or USER_EMAIL_DOMAIN; cannot configure Email Sending event subscription.',
		)
	}
	return `inbox.${new URL(appBaseUrl).hostname.toLowerCase()}`
}

/**
 * System/transactional mail (`kody@<SYSTEM_EMAIL_DOMAIN>`) is a separate
 * Email Sending domain from user inboxes. Cloudflare event subscriptions are
 * domain-scoped, so signup/password-reset/email-change lifecycle events only
 * arrive when this domain also has a subscription on `kody-email-delivery`.
 */
function resolveSystemEmailSendingDomain(input: {
	dryRun: boolean
	committedSystemEmailDomain: string | null
}) {
	const configured = process.env.SYSTEM_EMAIL_DOMAIN?.trim()
		.toLowerCase()
		.replace(/\.$/, '')
	if (configured && !isValidBareHostname(configured)) {
		fail(`SYSTEM_EMAIL_DOMAIN is not a valid bare hostname: ${configured}`)
	}
	if (configured) return configured
	if (input.committedSystemEmailDomain) {
		if (!isValidBareHostname(input.committedSystemEmailDomain)) {
			fail(
				`Committed SYSTEM_EMAIL_DOMAIN in wrangler.jsonc is not a valid bare hostname: ${input.committedSystemEmailDomain}`,
			)
		}
		return input.committedSystemEmailDomain
	}
	const appBaseUrl = process.env.APP_BASE_URL?.trim()
	if (!appBaseUrl) {
		if (input.dryRun) return 'example.com'
		fail(
			'Missing APP_BASE_URL or SYSTEM_EMAIL_DOMAIN; cannot configure Email Sending event subscription.',
		)
	}
	return new URL(appBaseUrl).hostname.toLowerCase()
}

/**
 * Unique Email Sending domains that need an `email.sending` queue
 * subscription. User inbox and system/transactional domains are often
 * different (`inbox.kody.codes` vs `kody.codes`); subscribing only to the
 * inbox domain leaves verification mail stuck at `accepted`.
 */
export function resolveEmailSendingEventSubscriptionDomains(input: {
	userDomain: string
	systemDomain: string
}): Array<{ domain: string; kind: 'user' | 'system' }> {
	const user = input.userDomain.trim().toLowerCase().replace(/\.$/, '')
	const system = input.systemDomain.trim().toLowerCase().replace(/\.$/, '')
	if (user === system) {
		return [{ domain: user, kind: 'user' }]
	}
	return [
		{ domain: user, kind: 'user' },
		{ domain: system, kind: 'system' },
	]
}

function emailSendingEventSubscriptionName(input: {
	workerName: string
	kind: 'user' | 'system'
}) {
	const suffix =
		input.kind === 'system'
			? '-system-email-delivery-events'
			: '-email-delivery-events'
	return truncateWithSuffix(input.workerName, suffix, 63)
}

function ensureKvNamespace({
	title,
	configuredId,
	dryRun,
}: {
	title: string
	configuredId: string
	dryRun: boolean
}) {
	if (dryRun) {
		console.error(`[dry-run] ensure KV namespace: ${title}`)
		return { title, id: `dry-run-${title}` }
	}

	const namespaces = listKvNamespaces()

	if (configuredId) {
		const byId = namespaces.find((entry) => entry.id === configuredId)
		if (byId) {
			console.error(`KV namespace exists by id: ${byId.title} (${byId.id})`)
			return { title: byId.title, id: byId.id }
		}
	}

	const byTitle = namespaces.find((entry) => entry.title === title)
	if (byTitle) {
		console.error(`KV namespace exists by title: ${title} (${byTitle.id})`)
		return { title: byTitle.title, id: byTitle.id }
	}

	// If Wrangler prompts to update config, always answer "no".
	const createResult = runWrangler(['kv', 'namespace', 'create', title], {
		input: 'n\n',
		quiet: true,
	})
	if (createResult.status !== 0) {
		fail(`Failed to create KV namespace: ${title}`)
	}

	const created = listKvNamespaces().find((entry) => entry.title === title)
	if (!created) {
		fail(`Created KV namespace "${title}" but could not find it via list.`)
	}

	console.error(`Created KV namespace: ${title} (${created.id})`)
	return { title: created.title, id: created.id }
}

function readProductionR2BucketName(input: {
	r2Buckets: Array<unknown>
	binding: string
	wranglerConfigPath: string
}) {
	const entry = input.r2Buckets.find((item) => {
		if (!item || typeof item !== 'object') return false
		return (item as Record<string, unknown>).binding === input.binding
	}) as Record<string, unknown> | undefined
	if (!entry) {
		fail(
			`wrangler config "${input.wranglerConfigPath}" has no production R2 binding for "${input.binding}".`,
		)
	}
	const bucketName = entry.bucket_name
	if (typeof bucketName !== 'string' || bucketName.length === 0) {
		fail(
			`wrangler config "${input.wranglerConfigPath}" is missing "bucket_name" for production "${input.binding}".`,
		)
	}
	return bucketName
}

async function resolveProductionBindings({
	wranglerConfigPath,
	kvTitleOverride,
}: {
	wranglerConfigPath: string
	kvTitleOverride?: string
}) {
	const baseText = await readFile(wranglerConfigPath, 'utf8')
	const config = parseJsonc<Record<string, unknown>>(baseText)

	const workerName = config.name
	if (typeof workerName !== 'string' || workerName.length === 0) {
		fail(
			`wrangler config "${wranglerConfigPath}" is missing top-level "name" (worker name).`,
		)
	}

	const env = config.env
	if (!env || typeof env !== 'object') {
		fail(`wrangler config "${wranglerConfigPath}" is missing "env".`)
	}

	const productionEnv = (env as Record<string, unknown>).production
	if (!productionEnv || typeof productionEnv !== 'object') {
		fail(`wrangler config "${wranglerConfigPath}" is missing "env.production".`)
	}

	const d1Databases = (productionEnv as Record<string, unknown>).d1_databases
	if (!Array.isArray(d1Databases)) {
		fail(
			`wrangler config "${wranglerConfigPath}" is missing "env.production.d1_databases".`,
		)
	}

	const d1Entry = d1Databases.find((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'APP_DB'
	}) as Record<string, unknown> | undefined
	if (!d1Entry) {
		fail(
			`wrangler config "${wranglerConfigPath}" has no production D1 binding for "APP_DB".`,
		)
	}

	const d1DatabaseName = d1Entry.database_name
	if (typeof d1DatabaseName !== 'string' || d1DatabaseName.length === 0) {
		fail(
			`wrangler config "${wranglerConfigPath}" is missing "database_name" for production "APP_DB".`,
		)
	}
	const d1ConfiguredId =
		typeof d1Entry.database_id === 'string' ? d1Entry.database_id : ''
	const auditD1Entry = d1Databases.find((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'AUDIT_DB'
	}) as Record<string, unknown> | undefined
	if (!auditD1Entry) {
		fail(
			`wrangler config "${wranglerConfigPath}" has no production D1 binding for "AUDIT_DB".`,
		)
	}
	const auditD1DatabaseName = auditD1Entry.database_name
	if (
		typeof auditD1DatabaseName !== 'string' ||
		auditD1DatabaseName.length === 0
	) {
		fail(
			`wrangler config "${wranglerConfigPath}" is missing "database_name" for production "AUDIT_DB".`,
		)
	}
	const auditD1ConfiguredId =
		typeof auditD1Entry.database_id === 'string' ? auditD1Entry.database_id : ''

	const kvNamespaces = (productionEnv as Record<string, unknown>).kv_namespaces
	if (!Array.isArray(kvNamespaces)) {
		fail(
			`wrangler config "${wranglerConfigPath}" is missing "env.production.kv_namespaces".`,
		)
	}

	const oauthKvEntry = kvNamespaces.find((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'OAUTH_KV'
	}) as Record<string, unknown> | undefined
	if (!oauthKvEntry) {
		fail(
			`wrangler config "${wranglerConfigPath}" has no production KV binding for "OAUTH_KV".`,
		)
	}

	const bundleArtifactsKvEntry = kvNamespaces.find((entry) => {
		if (!entry || typeof entry !== 'object') return false
		return (entry as Record<string, unknown>).binding === 'BUNDLE_ARTIFACTS_KV'
	}) as Record<string, unknown> | undefined
	if (!bundleArtifactsKvEntry) {
		fail(
			`wrangler config "${wranglerConfigPath}" has no production KV binding for "BUNDLE_ARTIFACTS_KV".`,
		)
	}

	const oauthKvConfiguredId =
		typeof oauthKvEntry.id === 'string' ? oauthKvEntry.id : ''
	const oauthKvTitleFromConfig =
		typeof oauthKvEntry.title === 'string' && oauthKvEntry.title.length > 0
			? oauthKvEntry.title
			: ''
	const oauthKvTitle =
		(kvTitleOverride && kvTitleOverride.length > 0 && kvTitleOverride) ||
		oauthKvTitleFromConfig ||
		defaultOauthKvTitle(workerName)
	const bundleArtifactsKvConfiguredId =
		typeof bundleArtifactsKvEntry.id === 'string'
			? bundleArtifactsKvEntry.id
			: ''
	const bundleArtifactsKvTitleFromConfig =
		typeof bundleArtifactsKvEntry.title === 'string' &&
		bundleArtifactsKvEntry.title.length > 0
			? bundleArtifactsKvEntry.title
			: ''
	const bundleArtifactsKvTitle =
		bundleArtifactsKvTitleFromConfig ||
		defaultBundleArtifactsKvTitle(workerName)

	const r2Buckets = (productionEnv as Record<string, unknown>).r2_buckets
	if (!Array.isArray(r2Buckets)) {
		fail(
			`wrangler config "${wranglerConfigPath}" is missing "env.production.r2_buckets".`,
		)
	}

	const emailBlobsBucketName = readProductionR2BucketName({
		r2Buckets,
		binding: 'EMAIL_BLOBS',
		wranglerConfigPath,
	})
	const communityAssetsBucketName = readProductionR2BucketName({
		r2Buckets,
		binding: 'COMMUNITY_ASSETS',
		wranglerConfigPath,
	})
	const repoSessionBlobsBucketName = readProductionR2BucketName({
		r2Buckets,
		binding: 'REPO_SESSION_BLOBS',
		wranglerConfigPath,
	})
	const operatorBackupsBucketName = readProductionR2BucketName({
		r2Buckets,
		binding: 'OPERATOR_BACKUPS',
		wranglerConfigPath,
	})

	let queueResources: ReturnType<typeof parseProductionQueueResources>
	try {
		queueResources = parseProductionQueueResources({
			productionEnv: productionEnv as Record<string, unknown>,
			configPath: wranglerConfigPath,
		})
	} catch (error) {
		fail(
			error instanceof Error
				? error.message
				: `wrangler config "${wranglerConfigPath}" has invalid production Queue configuration.`,
		)
	}

	const productionVars = (productionEnv as Record<string, unknown>).vars
	const committedUserEmailDomainRaw =
		productionVars && typeof productionVars === 'object'
			? (productionVars as Record<string, unknown>).USER_EMAIL_DOMAIN
			: undefined
	const committedUserEmailDomain =
		typeof committedUserEmailDomainRaw === 'string' &&
		committedUserEmailDomainRaw.trim().length > 0
			? committedUserEmailDomainRaw.trim().toLowerCase().replace(/\.$/, '')
			: null
	const committedSystemEmailDomainRaw =
		productionVars && typeof productionVars === 'object'
			? (productionVars as Record<string, unknown>).SYSTEM_EMAIL_DOMAIN
			: undefined
	const committedSystemEmailDomain =
		typeof committedSystemEmailDomainRaw === 'string' &&
		committedSystemEmailDomainRaw.trim().length > 0
			? committedSystemEmailDomainRaw.trim().toLowerCase().replace(/\.$/, '')
			: null

	const packageAppBaseUrlRaw =
		productionVars && typeof productionVars === 'object'
			? (productionVars as Record<string, unknown>).PACKAGE_APP_BASE_URL
			: undefined
	const committedPackageAppLegacyHostsRaw =
		productionVars && typeof productionVars === 'object'
			? (productionVars as Record<string, unknown>).PACKAGE_APP_LEGACY_HOSTS
			: undefined
	const overlayPackageAppLegacyHosts = process.env.PACKAGE_APP_LEGACY_HOSTS
	const packageAppLegacyHostsRaw =
		typeof overlayPackageAppLegacyHosts === 'string' &&
		overlayPackageAppLegacyHosts.length > 0
			? overlayPackageAppLegacyHosts
			: committedPackageAppLegacyHostsRaw
	let packageAppHostname: string | null = null
	if (
		typeof packageAppBaseUrlRaw === 'string' &&
		packageAppBaseUrlRaw.trim().length > 0
	) {
		try {
			packageAppHostname = new URL(packageAppBaseUrlRaw.trim()).hostname
		} catch {
			fail(
				`wrangler config "${wranglerConfigPath}" has an invalid "env.production.vars.PACKAGE_APP_BASE_URL": ${packageAppBaseUrlRaw}`,
			)
		}
		if (!packageAppHostname) {
			fail(
				`wrangler config "${wranglerConfigPath}" has "env.production.vars.PACKAGE_APP_BASE_URL" without a hostname: ${packageAppBaseUrlRaw}`,
			)
		}
	}
	let packageAppLegacyHostnames: Array<string> = []
	try {
		packageAppLegacyHostnames = listPackageAppHostnames({
			packageAppBaseUrl: null,
			packageAppLegacyHosts:
				typeof packageAppLegacyHostsRaw === 'string'
					? packageAppLegacyHostsRaw
					: null,
		}).filter((hostname) => hostname !== packageAppHostname)
	} catch {
		fail(
			`wrangler config "${wranglerConfigPath}" has an invalid "env.production.vars.PACKAGE_APP_LEGACY_HOSTS": ${String(packageAppLegacyHostsRaw)}`,
		)
	}
	for (const hostname of packageAppLegacyHostnames) {
		if (!isValidBareHostname(hostname)) {
			fail(
				`wrangler config "${wranglerConfigPath}" has an invalid hostname in "env.production.vars.PACKAGE_APP_LEGACY_HOSTS": ${hostname}. Use bare hostnames (no scheme), comma-separated.`,
			)
		}
	}

	const resolved: ResolvedProductionBindings = {
		workerName,
		d1DatabaseName,
		d1ConfiguredId,
		auditD1DatabaseName,
		auditD1ConfiguredId,
		oauthKvTitle,
		oauthKvConfiguredId,
		bundleArtifactsKvTitle,
		bundleArtifactsKvConfiguredId,
		communityAssetsBucketName,
		emailBlobsBucketName,
		repoSessionBlobsBucketName,
		operatorBackupsBucketName,
		committedUserEmailDomain,
		committedSystemEmailDomain,
		packageAppHostname,
		packageAppLegacyHostnames,
		...queueResources,
	}

	return resolved
}

async function ensureProductionResources(options: CliOptions) {
	const bindings = await resolveProductionBindings({
		wranglerConfigPath: options.wranglerConfigPath,
		kvTitleOverride: options.kvTitleOverride,
	})
	console.error(
		`Ensuring production resources for worker: ${bindings.workerName} (D1: ${bindings.d1DatabaseName}, OAuth KV: ${bindings.oauthKvTitle}, Bundle KV: ${bindings.bundleArtifactsKvTitle}, Community R2: ${bindings.communityAssetsBucketName}, Email R2: ${bindings.emailBlobsBucketName}, Email Queue: ${bindings.emailDeliveryQueueName}, Email DLQ: ${bindings.emailDeliveryDeadLetterQueueName}, Artifacts Repo Events Queue: ${bindings.artifactsRepoEventsQueueName}, Artifacts Repo Events DLQ: ${bindings.artifactsRepoEventsDeadLetterQueueName}, Platform Feedback Queue: ${bindings.platformFeedbackDispatchQueueName}, Platform Feedback DLQ: ${bindings.platformFeedbackDispatchDeadLetterQueueName}, Community Activity Queue: ${bindings.communityActivityDispatchQueueName}, Community Activity DLQ: ${bindings.communityActivityDispatchDeadLetterQueueName}, Community Listing Published Queue: ${bindings.communityListingPublishedDispatchQueueName}, Community Listing Published DLQ: ${bindings.communityListingPublishedDispatchDeadLetterQueueName}, Package Events Queue: ${bindings.packageEventsDispatchQueueName}, Package Events DLQ: ${bindings.packageEventsDispatchDeadLetterQueueName}, Webhook Dispatch Queue: ${bindings.webhookDispatchQueueName}, Webhook Dispatch DLQ: ${bindings.webhookDispatchDeadLetterQueueName})`,
	)

	const d1 = await ensureD1Database({
		name: bindings.d1DatabaseName,
		configuredId: bindings.d1ConfiguredId,
		location: options.d1Location,
		dryRun: options.dryRun,
	})
	const auditD1 = await ensureD1Database({
		name: bindings.auditD1DatabaseName,
		configuredId: bindings.auditD1ConfiguredId,
		location: options.d1Location,
		dryRun: options.dryRun,
	})
	const oauthKv = ensureKvNamespace({
		title: bindings.oauthKvTitle,
		configuredId: bindings.oauthKvConfiguredId,
		dryRun: options.dryRun,
	})
	const bundleArtifactsKv = ensureKvNamespace({
		title: bindings.bundleArtifactsKvTitle,
		configuredId: bindings.bundleArtifactsKvConfiguredId,
		dryRun: options.dryRun,
	})
	const emailBlobs = await ensureR2Bucket({
		name: bindings.emailBlobsBucketName,
		dryRun: options.dryRun,
	})
	const repoSessionBlobs = await ensureR2Bucket({
		name: bindings.repoSessionBlobsBucketName,
		dryRun: options.dryRun,
	})
	const operatorBackups = await ensureR2Bucket({
		name: bindings.operatorBackupsBucketName,
		dryRun: options.dryRun,
	})
	const communityAssets = await ensureR2Bucket({
		name: bindings.communityAssetsBucketName,
		dryRun: options.dryRun,
	})
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim()
	const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim()
	const zoneId = process.env.CLOUDFLARE_ZONE_ID?.trim()
	if ((!accountId || !apiToken || !zoneId) && !options.dryRun) {
		fail(
			'Missing CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ZONE_ID, or CLOUDFLARE_API_TOKEN for Queue provisioning.',
		)
	}
	const queueClient = {
		accountId: accountId ?? 'dry-run-account',
		apiToken: apiToken ?? 'dry-run-token',
		dryRun: options.dryRun,
	}
	const existingQueues = options.dryRun
		? []
		: await listCloudflareQueues(queueClient)
	const emailDeliveryQueue = await ensureCloudflareQueue({
		...queueClient,
		name: bindings.emailDeliveryQueueName,
		existingQueues,
	})
	const emailDeliveryDeadLetterQueue = await ensureCloudflareQueue({
		...queueClient,
		name: bindings.emailDeliveryDeadLetterQueueName,
		existingQueues,
	})
	const artifactsRepoEventsQueue = await ensureCloudflareQueue({
		...queueClient,
		name: bindings.artifactsRepoEventsQueueName,
		existingQueues,
	})
	const artifactsRepoEventsDeadLetterQueue = await ensureCloudflareQueue({
		...queueClient,
		name: bindings.artifactsRepoEventsDeadLetterQueueName,
		existingQueues,
	})
	const platformFeedbackDispatchQueue = await ensureCloudflareQueue({
		...queueClient,
		name: bindings.platformFeedbackDispatchQueueName,
		existingQueues,
	})
	const platformFeedbackDispatchDeadLetterQueue = await ensureCloudflareQueue({
		...queueClient,
		name: bindings.platformFeedbackDispatchDeadLetterQueueName,
		existingQueues,
	})
	const communityActivityDispatchQueue = await ensureCloudflareQueue({
		...queueClient,
		name: bindings.communityActivityDispatchQueueName,
		existingQueues,
	})
	const communityActivityDispatchDeadLetterQueue = await ensureCloudflareQueue({
		...queueClient,
		name: bindings.communityActivityDispatchDeadLetterQueueName,
		existingQueues,
	})
	const communityListingPublishedDispatchQueue = await ensureCloudflareQueue({
		...queueClient,
		name: bindings.communityListingPublishedDispatchQueueName,
		existingQueues,
	})
	const communityListingPublishedDispatchDeadLetterQueue =
		await ensureCloudflareQueue({
			...queueClient,
			name: bindings.communityListingPublishedDispatchDeadLetterQueueName,
			existingQueues,
		})
	const packageEventsDispatchQueue = await ensureCloudflareQueue({
		...queueClient,
		name: bindings.packageEventsDispatchQueueName,
		existingQueues,
	})
	const packageEventsDispatchDeadLetterQueue = await ensureCloudflareQueue({
		...queueClient,
		name: bindings.packageEventsDispatchDeadLetterQueueName,
		existingQueues,
	})
	await ensureCloudflareQueue({
		...queueClient,
		name: bindings.webhookDispatchQueueName,
		existingQueues,
	})
	await ensureCloudflareQueue({
		...queueClient,
		name: bindings.webhookDispatchDeadLetterQueueName,
		existingQueues,
	})
	const emailSendingUserDomain = resolveEmailSendingDomain({
		dryRun: options.dryRun,
		committedUserEmailDomain: bindings.committedUserEmailDomain,
	})
	const emailSendingSystemDomain = resolveSystemEmailSendingDomain({
		dryRun: options.dryRun,
		committedSystemEmailDomain: bindings.committedSystemEmailDomain,
	})
	const emailSendingSubscriptionDomains =
		resolveEmailSendingEventSubscriptionDomains({
			userDomain: emailSendingUserDomain,
			systemDomain: emailSendingSystemDomain,
		})
	const emailEventSubscriptions: Array<{
		id: string
		name: string
		domain: string
		kind: 'user' | 'system'
	}> = []
	for (const entry of emailSendingSubscriptionDomains) {
		const subscription = await ensureEmailSendingEventSubscription({
			accountId: accountId ?? 'dry-run-account',
			apiToken: apiToken ?? 'dry-run-token',
			name: emailSendingEventSubscriptionName({
				workerName: bindings.workerName,
				kind: entry.kind,
			}),
			queueId: emailDeliveryQueue.id,
			domain: entry.domain,
			zoneId: zoneId ?? 'dry-run-zone',
			dryRun: options.dryRun,
		})
		emailEventSubscriptions.push({
			id: subscription.id,
			name: subscription.name,
			domain: entry.domain,
			kind: entry.kind,
		})
	}
	// When user and system domains collapse to one hostname, stop ensuring a
	// separate system subscription and delete any leftover so the queue does
	// not keep receiving events for an obsolete domain or duplicates.
	const needsSystemEmailSubscription = emailSendingSubscriptionDomains.some(
		(entry) => entry.kind === 'system',
	)
	if (!needsSystemEmailSubscription) {
		await deleteEmailSendingEventSubscriptionIfPresent({
			accountId: accountId ?? 'dry-run-account',
			apiToken: apiToken ?? 'dry-run-token',
			name: emailSendingEventSubscriptionName({
				workerName: bindings.workerName,
				kind: 'system',
			}),
			dryRun: options.dryRun,
		})
	}
	const dmarcForwardTo =
		process.env.DMARC_REPORT_FORWARD_TO?.trim() || defaultDmarcReportForwardTo
	await ensureDmarcReportingTxtRecords({
		apiToken: apiToken ?? 'dry-run-token',
		zoneId: zoneId ?? 'dry-run-zone',
		systemEmailDomain: emailSendingSystemDomain,
		userEmailDomain: emailSendingUserDomain,
		dryRun: options.dryRun,
	})
	await ensureDmarcEmailRoutingRule({
		accountId: accountId ?? 'dry-run-account',
		apiToken: apiToken ?? 'dry-run-token',
		zoneId: zoneId ?? 'dry-run-zone',
		systemEmailDomain: emailSendingSystemDomain,
		forwardTo: dmarcForwardTo,
		dryRun: options.dryRun,
	})
	const artifactsEventSubscription =
		await ensureArtifactsAccountEventSubscription({
			accountId: accountId ?? 'dry-run-account',
			apiToken: apiToken ?? 'dry-run-token',
			name: truncateWithSuffix(
				bindings.workerName,
				'-artifacts-lifecycle-events',
				63,
			),
			queueId: artifactsRepoEventsQueue.id,
			dryRun: options.dryRun,
		})

	const packageAppHostnames = [
		bindings.packageAppHostname,
		...bindings.packageAppLegacyHostnames,
	].filter((hostname): hostname is string => Boolean(hostname))
	for (const packageAppHostname of new Set(packageAppHostnames)) {
		await ensurePackageAppDnsRecords({
			accountId: accountId ?? 'dry-run-account',
			apiToken: apiToken ?? 'dry-run-token',
			packageAppHostname,
			dryRun: options.dryRun,
		})
	}

	const deployState: OriginProductionScriptState =
		options.dryRun || !accountId || !apiToken
			? {
					mode: 'ambiguous',
					reason:
						'Dry-run or missing Cloudflare credentials; keep the full origin entry and do not bootstrap transfers.',
					originOwnedTransferredClassNames: [],
				}
			: await inspectOriginProductionScriptState({
					accountId,
					apiToken,
				})
	const deployPlan = planOriginProductionDeploy(deployState)
	console.error(
		`Origin production deploy state: ${deployPlan.mode} (${deployPlan.originEntry} entry${deployPlan.runOriginBootstrap ? ', bootstrap then transfer' : ''}). ${deployPlan.reason}`,
	)

	const generatedConfigPath = await writeGeneratedWranglerConfig({
		baseConfigPath: options.wranglerConfigPath,
		outConfigPath: options.outConfigPath,
		envName: 'production',
		workerName: bindings.workerName,
		// The committed config keeps env.production on the dev/test/preview
		// entry. Only this generated config — the one the production deploy
		// actually runs against — points top-level `main` at the slim
		// production origin entry, and only after the live script is
		// classified as steady-state or a fresh bootstrap that will transfer
		// before the slim upload.
		...(deployPlan.originEntry === 'slim'
			? { mainEntryPath: defaultProductionEntryPath }
			: {}),
		d1DatabaseName: d1.name,
		d1DatabaseId: d1.id,
		auditD1DatabaseName: auditD1.name,
		auditD1DatabaseId: auditD1.id,
		oauthKvId: oauthKv.id,
		bundleArtifactsKvId: bundleArtifactsKv.id,
		communityAssetsBucketName: communityAssets.name,
		emailBlobsBucketName: emailBlobs.name,
		repoSessionBlobsBucketName: repoSessionBlobs.name,
		operatorBackupsBucketName: operatorBackups.name,
		workerVars: {
			APP_BASE_URL: process.env.APP_BASE_URL,
			APP_LEGACY_HOSTS: process.env.APP_LEGACY_HOSTS,
			APP_LEGACY_REDIRECT: process.env.APP_LEGACY_REDIRECT,
			PACKAGE_APP_LEGACY_HOSTS: process.env.PACKAGE_APP_LEGACY_HOSTS,
			PACKAGE_APP_LEGACY_REDIRECT: process.env.PACKAGE_APP_LEGACY_REDIRECT,
			CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
			USER_EMAIL_DOMAIN: process.env.USER_EMAIL_DOMAIN,
			SYSTEM_EMAIL_DOMAIN: process.env.SYSTEM_EMAIL_DOMAIN,
			LEGACY_USER_EMAIL_DOMAINS: process.env.LEGACY_USER_EMAIL_DOMAINS,
			LEGACY_SYSTEM_EMAIL_DOMAINS: process.env.LEGACY_SYSTEM_EMAIL_DOMAINS,
			PACKAGE_APP_ZONE_ID: process.env.PACKAGE_APP_ZONE_ID,
		},
	})

	let bootstrapConfigPath = ''
	if (deployPlan.runOriginBootstrap) {
		const generatedConfig = parseJsonc<Record<string, unknown>>(
			await readFile(generatedConfigPath, 'utf8'),
		)
		bootstrapConfigPath = await writeOriginBootstrapWranglerConfig({
			generatedConfig,
			outConfigPath: originBootstrapConfigPath(options.outConfigPath),
		})
	} else if (
		deployPlan.originEntry === 'full' &&
		deployState.originOwnedTransferredClassNames.length > 0
	) {
		const generatedConfig = parseJsonc<Record<string, unknown>>(
			await readFile(generatedConfigPath, 'utf8'),
		)
		stripOriginBindingsForLocallyOwnedClasses(
			generatedConfig,
			deployState.originOwnedTransferredClassNames,
		)
		await writeFile(
			generatedConfigPath,
			`${JSON.stringify(generatedConfig, null, '\t')}\n`,
			'utf8',
		)
	}

	// After the full-entry bootstrap clone is written. Fresh production
	// still needs historical `new_sqlite_classes` on that bootstrap file;
	// the slim upload that follows must not replay them.
	if (deployPlan.originEntry === 'slim') {
		const generatedConfig = parseJsonc<Record<string, unknown>>(
			await readFile(generatedConfigPath, 'utf8'),
		)
		stripOriginDurableObjectMigrations(generatedConfig, 'production')
		await writeFile(
			generatedConfigPath,
			`${JSON.stringify(generatedConfig, null, '\t')}\n`,
			'utf8',
		)
	}

	// Emit GitHub Actions-friendly outputs (stdout only).
	console.log(`wrangler_config=${generatedConfigPath}`)
	console.log(`origin_deploy_mode=${deployPlan.mode}`)
	console.log(`origin_entry=${deployPlan.originEntry}`)
	console.log(
		`origin_bootstrap=${deployPlan.runOriginBootstrap ? 'true' : 'false'}`,
	)
	console.log(
		`origin_force_platform_runtime=${deployPlan.forcePlatformAndRuntime ? 'true' : 'false'}`,
	)
	if (bootstrapConfigPath) {
		console.log(`origin_bootstrap_wrangler_config=${bootstrapConfigPath}`)
	}
	console.log(`d1_database_name=${d1.name}`)
	console.log(`d1_database_id=${d1.id}`)
	console.log(`audit_d1_database_name=${auditD1.name}`)
	console.log(`audit_d1_database_id=${auditD1.id}`)
	console.log(`oauth_kv_title=${oauthKv.title}`)
	console.log(`oauth_kv_id=${oauthKv.id}`)
	console.log(`bundle_artifacts_kv_title=${bundleArtifactsKv.title}`)
	console.log(`bundle_artifacts_kv_id=${bundleArtifactsKv.id}`)
	console.log(`community_assets_bucket_name=${communityAssets.name}`)
	console.log(`email_blobs_bucket_name=${emailBlobs.name}`)
	console.log(`repo_session_blobs_bucket_name=${repoSessionBlobs.name}`)
	console.log(`operator_backups_bucket_name=${operatorBackups.name}`)
	console.log(`email_delivery_queue_name=${emailDeliveryQueue.name}`)
	console.log(
		`email_delivery_dead_letter_queue_name=${emailDeliveryDeadLetterQueue.name}`,
	)
	console.log(
		`artifacts_repo_events_queue_name=${artifactsRepoEventsQueue.name}`,
	)
	console.log(
		`artifacts_repo_events_dead_letter_queue_name=${artifactsRepoEventsDeadLetterQueue.name}`,
	)
	console.log(
		`platform_feedback_dispatch_queue_name=${platformFeedbackDispatchQueue.name}`,
	)
	console.log(
		`platform_feedback_dispatch_dead_letter_queue_name=${platformFeedbackDispatchDeadLetterQueue.name}`,
	)
	console.log(
		`community_activity_dispatch_queue_name=${communityActivityDispatchQueue.name}`,
	)
	console.log(
		`community_activity_dispatch_dead_letter_queue_name=${communityActivityDispatchDeadLetterQueue.name}`,
	)
	console.log(
		`community_listing_published_dispatch_queue_name=${communityListingPublishedDispatchQueue.name}`,
	)
	console.log(
		`community_listing_published_dispatch_dead_letter_queue_name=${communityListingPublishedDispatchDeadLetterQueue.name}`,
	)
	console.log(
		`package_events_dispatch_queue_name=${packageEventsDispatchQueue.name}`,
	)
	console.log(
		`package_events_dispatch_dead_letter_queue_name=${packageEventsDispatchDeadLetterQueue.name}`,
	)
	for (const subscription of emailEventSubscriptions) {
		console.log(
			`email_event_subscription_id_${subscription.kind}=${subscription.id}`,
		)
		console.log(
			`email_event_subscription_domain_${subscription.kind}=${subscription.domain}`,
		)
	}
	console.log(
		`artifacts_event_subscription_id=${artifactsEventSubscription.id}`,
	)
}

async function main() {
	const { command, options } = parseArgs(process.argv.slice(2))

	if (!process.env.CLOUDFLARE_API_TOKEN && !options.dryRun) {
		fail(
			'Missing CLOUDFLARE_API_TOKEN (required for Wrangler resource operations).',
		)
	}

	if (command === 'ensure') {
		await ensureProductionResources(options)
		return
	}
}

if (isExecutedDirectly(import.meta.url)) {
	await main()
}
