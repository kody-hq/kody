import {
	assetManifestDigest,
	reviewedRouterName,
} from './start-rollout-config.ts'
import { readFile, writeFile, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import {
	approvedPeople,
	mapLiveProductionSettings,
} from './prepare-start-opt-in.ts'
import { assertSharedBindings } from './deploy-start-opt-in.ts'
import {
	rolloutAccount,
	rolloutApi,
	workerEvidence,
	type JsonRecord,
} from './start-opt-in-cloudflare.ts'
import { parseJsonc } from './resource-utils.ts'
import { isExecutedDirectly } from '../node-runtime.ts'

type Route = { id: string; pattern: string; script?: string | null }
type Domain = {
	id: string
	hostname: string
	service: string
	zone_id: string
	environment?: string
}
type Version = Awaited<ReturnType<typeof workerEvidence>>
type Proof = {
	release: string
	candidateName: string
	routerName: string
	checkedAt: string
	versions: { candidate: Version; router: Version }
	health: string
	publicDocuments: string
	exactAssets: string
	anonymousDenial: string
	invalidPreference: string
}
type Review = {
	candidate: JsonRecord
	router: JsonRecord
	manifest: {
		release: string
		candidateName: string
		legacyName: string
		routerName?: string
		allowedPersonIds: Array<string>
		assetPaths: Array<string>
	}
}
type Receipt = {
	accountId: string
	zoneId: string
	release: string
	route: Route
	beforeRoutes: Array<Route>
	beforeDomain: Domain
	versions: Proof['versions']
	status: string
}

async function writeRoutingReceipt(
	file: string,
	contents: string,
	options?: { mode: number },
) {
	const temporary = `${file}.${randomUUID()}.tmp`
	try {
		await writeFile(temporary, contents, { mode: options?.mode ?? 0o600 })
		await rename(temporary, file)
	} finally {
		await rm(temporary, { force: true })
	}
}

const pattern = 'kody.codes/*'
function requireValue(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}
export function overlapsRolloutHost(value: string) {
	if (value.includes('://') && !/^https?:\/\//.test(value))
		throw new Error('Unrecognized zone route scheme')
	const host = value.replace(/^https?:\/\//, '').split('/')[0]
	if (!host || !/^[*.a-z0-9-]+$/i.test(host))
		throw new Error('Unrecognized zone route pattern')
	const escaped = host
		.split('*')
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.join('.*')
	return new RegExp(`^${escaped}$`, 'i').test('kody.codes')
}
export function validateRouteSnapshot(
	routes: Array<Route>,
	domains: Array<Domain>,
	zoneId: string,
) {
	const matching = domains.filter((domain) => domain.hostname === 'kody.codes')
	requireValue(
		matching.length === 1 &&
			matching[0]!.service === 'kody-production' &&
			matching[0]!.zone_id === zoneId &&
			(!matching[0]!.environment || matching[0]!.environment === 'production'),
		'The existing kody.codes custom domain must belong to kody-production in this zone',
	)
	for (const route of routes)
		requireValue(
			!overlapsRolloutHost(route.pattern),
			`Conflicting existing zone route: ${route.pattern}`,
		)
	return matching[0]!
}
export function validateRuntimeProof(
	proof: Proof,
	release: string,
	now = Date.now(),
) {
	requireValue(
		/^[a-f0-9]{40}$/.test(release) &&
			proof.release === release &&
			proof.candidateName === `kody-start-${release}` &&
			proof.routerName === `kody-start-router-${release}`,
		'Runtime proof must pin the exact approved release',
	)
	const age = now - Date.parse(proof.checkedAt)
	requireValue(
		Number.isFinite(age) && age >= 0 && age <= 60 * 60 * 1000,
		'Private runtime proof must be less than one hour old',
	)
	requireValue(
		[
			proof.health,
			proof.publicDocuments,
			proof.exactAssets,
			proof.anonymousDenial,
		].every((value) => value === 'passed') &&
			proof.invalidPreference === 'legacy',
		'All private runtime checks must pass',
	)
}
export function validateRollbackRoute(actual: Route, receipt: Receipt) {
	const routerName = `kody-start-router-${receipt.release}`
	requireValue(
		/^[a-f0-9]{40}$/.test(receipt.release) &&
			receipt.route.pattern === pattern &&
			receipt.route.script === routerName &&
			/^[a-f0-9]{32}$/.test(receipt.route.id),
		'Receipt must identify the exact created rollout route',
	)
	requireValue(
		actual.id === receipt.route.id &&
			actual.pattern === pattern &&
			actual.script === routerName,
		'Refusing to delete a route whose identity or ownership changed',
	)
}
async function topology(zoneId: string) {
	const accountId = rolloutAccount()
	const zone = (await rolloutApi(`/zones/${zoneId}`)) as {
		name?: string
		account?: { id?: string }
	}
	requireValue(
		zone.name === 'kody.codes' && zone.account?.id === accountId,
		'Zone must be kody.codes in the approved account',
	)
	const routes = await rolloutApi(`/zones/${zoneId}/workers/routes`)
	const domains = await rolloutApi(`/accounts/${accountId}/workers/domains`)
	requireValue(
		Array.isArray(routes) && Array.isArray(domains),
		'Complete zone route and custom-domain lists required',
	)
	return { routes: routes as Array<Route>, domains: domains as Array<Domain> }
}
async function verifyLiveRelease(review: Review, proof: Proof) {
	const routerName = reviewedRouterName(
		review.manifest.release,
		review.manifest.routerName,
	)
	const account = rolloutAccount()
	const versions = {
		candidate: await workerEvidence(review.manifest.candidateName),
		router: await workerEvidence(routerName),
	}
	requireValue(
		JSON.stringify(versions) === JSON.stringify(proof.versions),
		'Candidate or router changed since private runtime verification',
	)
	const settings = async (name: string) =>
		(await rolloutApi(
			`/accounts/${account}/workers/scripts/${name}/settings`,
		)) as JsonRecord
	const candidate = await settings(review.manifest.candidateName)
	const router = await settings(routerName)
	const production = await settings('kody-production')
	const routerBindings = router.bindings as Array<JsonRecord>
	const vars = Object.fromEntries(
		routerBindings
			.filter(
				(binding) => binding.type === 'plain_text' || binding.type === 'json',
			)
			.map((binding) => [
				String(binding.name),
				binding.type === 'json' ? binding.json : binding.text,
			]),
	)
	requireValue(
		vars.START_RELEASE === review.manifest.release &&
			vars.APP_BASE_URL === 'https://kody.codes',
		'Router must select only the reviewed release on the production origin',
	)
	const allowed = JSON.parse(String(vars.START_ALLOWED_PERSON_IDS)) as unknown
	requireValue(
		Array.isArray(allowed) &&
			allowed.length === 2 &&
			allowed.every(
				(id) => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id),
			) &&
			new Set(allowed).size === 2 &&
			JSON.stringify([...allowed].sort()) ===
				JSON.stringify([...review.manifest.allowedPersonIds].sort()),
		'Router must allow exactly the two reviewed stable person IDs',
	)
	requireValue(
		vars.START_ASSET_MANIFEST_SHA256 ===
			assetManifestDigest(review.manifest.assetPaths),
		'Router asset manifest changed',
	)
	const services = routerBindings.filter(
		(binding) => binding.type === 'service',
	)
	requireValue(
		services.length === 2 &&
			services.some(
				(binding) =>
					binding.name === 'LEGACY' &&
					binding.service === 'kody-production' &&
					!binding.entrypoint &&
					(!binding.environment || binding.environment === 'production'),
			) &&
			services.some(
				(binding) =>
					binding.name === 'START' &&
					binding.service === review.manifest.candidateName &&
					!binding.entrypoint &&
					(!binding.environment || binding.environment === 'production'),
			),
		'Router service targets must stay pinned to legacy and reviewed candidate',
	)
	const app = (production.bindings as Array<JsonRecord>).find(
		(binding) => binding.type === 'd1' && binding.name === 'APP_DB',
	)
	const routerApp = routerBindings.filter((binding) => binding.type === 'd1')
	requireValue(
		app &&
			typeof app.id === 'string' &&
			/^[a-f0-9-]{36}$/.test(app.id) &&
			routerApp.length === 1 &&
			routerApp[0]!.name === 'APP_DB' &&
			routerApp[0]!.id === app.id,
		'Router must use the existing production APP_DB',
	)
	const query = (await rolloutApi(
		`/accounts/${account}/d1/database/${app.id}/query`,
		'POST',
		{
			sql: 'SELECT username, stable_user_id FROM users WHERE username IN (?, ?) AND suspended_at IS NULL AND deleting_at IS NULL AND deleted_at IS NULL',
			params: ['tannerlinsley', 'kentcdodds'],
		},
	)) as Array<{ success?: boolean; results?: Array<JsonRecord> }>
	requireValue(
		query.length === 1 &&
			query[0]?.success === true &&
			Array.isArray(query[0].results),
		'Approved production account verification failed',
	)
	requireValue(
		JSON.stringify(approvedPeople(query[0].results).sort()) ===
			JSON.stringify([...allowed].sort()),
		'Approved account identities changed',
	)
	const base = parseJsonc<JsonRecord>(
		await readFile('packages/worker/wrangler.jsonc', 'utf8'),
	)
	const candidateConfig = mapLiveProductionSettings(base, candidate)
	requireValue(
		(candidateConfig.vars as JsonRecord).APP_COMMIT_SHA ===
			review.manifest.release &&
			(candidateConfig.vars as JsonRecord).APP_DEPLOY_INFO === undefined,
		'Candidate release metadata is not pinned',
	)
	assertSharedBindings(candidateConfig, review.candidate)
	for (const name of [review.manifest.candidateName, routerName]) {
		const subdomain = (await rolloutApi(
			`/accounts/${account}/workers/scripts/${name}/subdomain`,
		)) as { enabled?: boolean; previews_enabled?: boolean }
		requireValue(
			subdomain.enabled === false && subdomain.previews_enabled === false,
			'Inactive workers must not expose public preview domains',
		)
	}
}
if (isExecutedDirectly(import.meta.url)) {
	const [mode, receiptPath = '.tmp/start-opt-in/route-receipt.json'] =
		process.argv.slice(2)
	const accountId = rolloutAccount()
	const zoneId = process.env.CLOUDFLARE_ZONE_ID ?? ''
	requireValue(
		/^[a-f0-9]{32}$/.test(zoneId),
		'Exact production zone ID required',
	)
	if (mode === 'activate') {
		const review = JSON.parse(
			await readFile('.tmp/start-opt-in/review.json', 'utf8'),
		) as Review
		const proof = JSON.parse(
			await readFile('.tmp/start-opt-in/runtime-proof.json', 'utf8'),
		) as Proof
		const release = process.env.KODY_START_RELEASE ?? ''
		const routerName = reviewedRouterName(release, review.manifest.routerName)
		validateRuntimeProof(proof, release)
		requireValue(
			review.manifest.release === release &&
				review.manifest.legacyName === 'kody-production' &&
				review.manifest.candidateName === `kody-start-${release}`,
			'Review bundle must match exact release',
		)
		await verifyLiveRelease(review, proof)
		const before = await topology(zoneId)
		const beforeDomain = validateRouteSnapshot(
			before.routes,
			before.domains,
			zoneId,
		)
		// Persist the existing topology before the sole routing mutation.
		const snapshot = {
			accountId,
			zoneId,
			release,
			beforeRoutes: before.routes,
			beforeDomain,
			versions: proof.versions,
			status: 'before-activation',
		}
		await writeRoutingReceipt(
			receiptPath,
			JSON.stringify(snapshot, null, '\t'),
			{
				mode: 0o600,
			},
		)
		let created: Route
		try {
			created = (await rolloutApi(`/zones/${zoneId}/workers/routes`, 'POST', {
				pattern,
				script: routerName,
			})) as Route
		} catch {
			throw new Error(
				'Route creation outcome could not be confirmed. The pre-activation snapshot is retained. Verify the exact kody.codes/* route and script before recovery, do not retry creation blindly.',
			)
		}
		const receipt: Receipt = {
			...snapshot,
			route: created,
			status: 'created-unverified',
		}
		try {
			await writeRoutingReceipt(
				receiptPath,
				JSON.stringify(receipt, null, '\t'),
				{
					mode: 0o600,
				},
			)
			validateRollbackRoute(created, receipt)
			const after = await topology(zoneId)
			requireValue(
				after.domains.some(
					(domain) => JSON.stringify(domain) === JSON.stringify(beforeDomain),
				),
				'Legacy custom domain changed during activation',
			)
			requireValue(
				after.routes.some(
					(route) =>
						route.id === created.id &&
						route.pattern === pattern &&
						route.script === routerName,
				),
				'Created overlay route could not be verified',
			)
			await verifyLiveRelease(review, proof)
			receipt.status = 'activated'
			await writeRoutingReceipt(
				receiptPath,
				JSON.stringify(receipt, null, '\t'),
				{
					mode: 0o600,
				},
			)
		} catch {
			// A failed post-activation check can remove only the route just created.
			try {
				const current = await topology(zoneId)
				const actual = current.routes.find((route) => route.id === created.id)
				if (actual) {
					validateRollbackRoute(actual, receipt)
					await rolloutApi(
						`/zones/${zoneId}/workers/routes/${created.id}`,
						'DELETE',
					)
				}
				receipt.status = 'rolled-back-after-verification-failure'
				await writeRoutingReceipt(
					receiptPath,
					JSON.stringify(receipt, null, '\t'),
					{
						mode: 0o600,
					},
				)
			} catch {
				throw new Error(
					'Activation verification failed and rollback could not be confirmed. Use the retained exact route receipt for recovery.',
				)
			}
			throw new Error(
				'Activation verification failed. Only the recorded overlay was removed.',
			)
		}
		console.log(
			`Activated only ${pattern} through ${routerName}. Receipt: ${receiptPath}`,
		)
	} else if (mode === 'rollback') {
		const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as Receipt
		requireValue(
			receipt.accountId === accountId && receipt.zoneId === zoneId,
			'Rollback account and zone must match the captured receipt',
		)
		const current = await topology(zoneId)
		const actual = current.routes.find(
			(route) => route.id === receipt.route?.id,
		)
		requireValue(actual, 'Exact created rollout route is no longer present')
		validateRollbackRoute(actual, receipt)
		requireValue(
			current.domains.some(
				(domain) =>
					domain.id === receipt.beforeDomain.id &&
					domain.hostname === 'kody.codes' &&
					domain.service === 'kody-production',
			),
			'Legacy custom-domain ownership changed, review before rollback',
		)
		await rolloutApi(
			`/zones/${zoneId}/workers/routes/${receipt.route.id}`,
			'DELETE',
		)
		const after = await topology(zoneId)
		requireValue(
			!after.routes.some((route) => route.id === receipt.route.id),
			'Rollout route deletion could not be verified',
		)
		await writeRoutingReceipt(
			receiptPath,
			JSON.stringify({ ...receipt, status: 'rolled-back' }, null, '\t'),
			{ mode: 0o600 },
		)
		console.log(
			'Removed only the recorded rollout overlay. Legacy worker and custom domain remain unchanged.',
		)
	} else throw new Error('Use activate or rollback')
}
