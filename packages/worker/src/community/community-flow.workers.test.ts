import {
	personIdFromStored,
	type PersonId,
	personalOrgId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { communityForkCapability } from '#mcp/capabilities/community/fork.ts'
import { communityGetCapability } from '#mcp/capabilities/community/get.ts'
import { communityPublishCapability } from '#mcp/capabilities/community/publish.ts'
import { communityRateCapability } from '#mcp/capabilities/community/rate.ts'
import { communityReportCapability } from '#mcp/capabilities/community/report.ts'
import { communitySearchCapability } from '#mcp/capabilities/community/search.ts'
import { communitySetFeaturedCapability } from '#mcp/capabilities/community/set-featured.ts'
import { communityUnpublishCapability } from '#mcp/capabilities/community/unpublish.ts'
import { communityContentWarning } from '#mcp/capabilities/community/shared.ts'
import { getPackageCapability } from '#mcp/capabilities/packages/get-package.ts'
import { listPackagesCapability } from '#mcp/capabilities/packages/list-packages.ts'
import { callerCanAccessCapability } from '#mcp/capabilities/access-control.ts'
import { CommunityActionError } from '#worker/community/errors.ts'
import {
	banCommunityUser,
	listFeaturedCommunityListingsWithAggregates,
	listCommunityActivityForAdmin,
	resolveCommunityReport,
	setCommunityListingFeatured,
} from '#worker/community/service.ts'
import { installCommunityListing } from '#worker/community/install.ts'
import { insertSavedPackage } from '#worker/package-registry/repo.ts'
import { writePublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { writeArtifactSourceSnapshot } from '#worker/repo/artifact-source-snapshot.ts'
import { getArtifactsBinding } from '#worker/repo/artifacts.ts'
import { insertEntitySource } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import { createArtifactsMswHandlers } from '#worker/test-support/artifacts-msw-handlers.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { type CommunityActivityDispatchQueueMessage } from './activity-dispatch-queue-producer.ts'
import {
	type CommunityForkUpstreamUpdatedDispatchQueueMessage,
	type CommunityListingPublishedDispatchQueueMessage,
} from './listing-published-dispatch-queue-producer.ts'
import { createMswWorkerServer } from '#worker/test-support/msw-worker-server.ts'
import { provisionPersonalOrg } from '#worker/orgs/provision.ts'
import { ensureCommunityFlowSchema } from './community-flow-test-schema.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const mockAccountId = 'cf_account_mock_123'
const artifactsApiBaseUrl = 'https://artifacts-mock.test'
const baseUrl = 'https://test.kody.dev'

type TestUser = {
	userId: PersonId
	email: string
	username: string
	displayName: string
}

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

async function insertTestUser(input: {
	email: string
	username: string
}): Promise<TestUser> {
	await ensureCommunityFlowSchema(env.APP_DB)
	const userId = testStableUserIdFromEmail(input.email)
	await runSql(
		`INSERT INTO users
			(username, email, stable_user_id, password_hash)
			VALUES (?, ?, ?, ?)`,
		input.username,
		input.email,
		userId,
		'test-password-hash',
	)
	await provisionPersonalOrg(env.APP_DB, {
		stableUserId: userId,
		username: input.username,
		plan: 'max',
	})
	return {
		userId: personIdFromStored(userId),
		email: input.email,
		username: input.username,
		displayName: input.username,
	}
}

function createCapabilityContext(testEnv: Env, user: TestUser) {
	return {
		env: testEnv,
		callerContext: createMcpCallerContext({
			source: { kind: 'mcp-oauth' },
			baseUrl,
			user,
		}),
	}
}

async function countSavedPackagesForUser(userId: string) {
	const row = await env.APP_DB.prepare(
		`SELECT COUNT(*) AS count FROM saved_packages WHERE user_id = ?`,
	)
		.bind(userId)
		.first<{ count: number }>()
	return row?.count ?? 0
}

function createFlowHarness() {
	// Publish checks and artifact rebuilds run the real worker bundler, which
	// warns that it is experimental.
	silenceIncidentalRuntimeWarnings()
	// Default `onUnhandledFrame: 'error'` keeps workerd off the network.
	// `bypass` attempted real DNS for artifacts-mock.test and flooded the
	// Workers suite.
	const artifactsMock = createMswWorkerServer(
		createArtifactsMswHandlers({
			accountId: mockAccountId,
			apiBaseUrl: artifactsApiBaseUrl,
		}),
	)
	const queuedActivity: Array<CommunityActivityDispatchQueueMessage> = []
	const queuedListingPublished: Array<
		| CommunityListingPublishedDispatchQueueMessage
		| CommunityForkUpstreamUpdatedDispatchQueueMessage
	> = []
	const testEnv: Env = {
		...env,
		CLOUDFLARE_ACCOUNT_ID: mockAccountId,
		CLOUDFLARE_API_TOKEN: 'artifacts-test-token',
		CLOUDFLARE_API_BASE_URL: artifactsApiBaseUrl,
		COMMUNITY_ACTIVITY_DISPATCH_QUEUE: {
			async send(message: CommunityActivityDispatchQueueMessage) {
				queuedActivity.push(message)
			},
		} as unknown as Env['COMMUNITY_ACTIVITY_DISPATCH_QUEUE'],
		COMMUNITY_LISTING_PUBLISHED_DISPATCH_QUEUE: {
			async send(
				message:
					| CommunityListingPublishedDispatchQueueMessage
					| CommunityForkUpstreamUpdatedDispatchQueueMessage,
			) {
				queuedListingPublished.push(message)
			},
		} as unknown as Env['COMMUNITY_LISTING_PUBLISHED_DISPATCH_QUEUE'],
	}
	return {
		testEnv,
		queuedActivity,
		queuedListingPublished,
		[Symbol.dispose]: () => artifactsMock[Symbol.dispose](),
	}
}

async function seedOwnerPackage(input: {
	testEnv: Env
	owner: TestUser
	packageId: string
	sourceId: string
	kodyId: string
	publishedCommit: string
	indexTs?: string
}) {
	const packageName = `@${input.owner.username}/${input.kodyId}`
	const packageJson = `${JSON.stringify(
		{
			name: packageName,
			version: '1.0.4',
			license: 'MIT',
			exports: { '.': './src/index.ts' },
			kody: {
				id: input.kodyId,
				description: 'Community flow integration test package',
			},
		},
		null,
		'\t',
	)}\n`
	const readme =
		'# Community Flow Package\n\n## Intent\n\nDemonstrate community publishing and forking.\n'
	const indexTs =
		input.indexTs ??
		`import { value } from 'kody:@usera/shared-utils/index'\n\nexport default async function main() {\n\treturn { ok: true, value }\n}\n`
	const files = {
		'package.json': packageJson,
		'README.md': readme,
		'AGENTS.md':
			'# Agents\n\nImport the community-flow export and smoke-test it.\n',
		'src/index.ts': indexTs,
	}
	const now = new Date().toISOString()

	await insertSavedPackage(env.APP_DB, {
		id: input.packageId,
		user_id: personalOrgId(input.owner.userId),
		name: packageName,
		kody_id: input.kodyId,
		description: 'Community flow integration test package',
		tags_json: JSON.stringify(['community', 'integration']),
		search_text: 'community flow integration websocket',
		source_id: input.sourceId,
		has_app: 0,
		has_skills: 0,
		hidden: 0,
		is_private: 0,
		created_at: now,
		updated_at: now,
	})

	const entitySource: EntitySourceRow = {
		id: input.sourceId,
		user_id: personalOrgId(input.owner.userId),
		entity_kind: 'package',
		entity_id: input.packageId,
		repo_id: `package-${input.packageId}`,
		published_commit: input.publishedCommit,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: now,
		updated_at: now,
	}
	await insertEntitySource(env.APP_DB, entitySource)
	await writePublishedSourceSnapshot({
		env: input.testEnv,
		source: entitySource,
		files,
	})
	const artifacts = getArtifactsBinding(input.testEnv)
	await artifacts.create(entitySource.repo_id, { readOnly: false })
	await writeArtifactSourceSnapshot({
		env: input.testEnv,
		repoId: entitySource.repo_id,
		files,
	})
	return { entitySource, files }
}

test('public package flow works end-to-end through capability handlers', async () => {
	using harness = createFlowHarness()
	const { testEnv, queuedActivity, queuedListingPublished } = harness
	const unique = crypto.randomUUID()
	const owner = await insertTestUser({
		email: `owner-a-${unique}@example.com`,
		username: 'usera',
	})
	const forker = await insertTestUser({
		email: `forker-b-${unique}@example.com`,
		username: 'userb',
	})
	const reporter = await insertTestUser({
		email: `reporter-c-${unique}@example.com`,
		username: 'userc',
	})
	const admin = await insertTestUser({
		email: `admin-${unique}@example.com`,
		username: 'admin',
	})
	const packageId = `package-${unique}`
	const sourceId = `source-${unique}`
	const kodyId = `community-flow-${unique}`
	const publishedCommit = `commit-${unique}`
	const publicUrl = `${baseUrl}/@usera/${kodyId}`
	const seeded = await seedOwnerPackage({
		testEnv,
		owner,
		packageId,
		sourceId,
		kodyId,
		publishedCommit,
	})
	const ownerCtx = createCapabilityContext(testEnv, owner)
	const forkerCtx = createCapabilityContext(testEnv, forker)
	const reporterCtx = createCapabilityContext(testEnv, reporter)
	const publish = () =>
		communityPublishCapability.handler({ package_id: packageId }, ownerCtx)
	const setFeatured = (featured: boolean) =>
		setCommunityListingFeatured({ env: testEnv, listingId, featured })
	const isFeaturedListed = async () =>
		(
			await listFeaturedCommunityListingsWithAggregates({
				env: testEnv,
				limit: 10,
			})
		).some((row) => row.id === listingId)

	const publishResult = await publish()
	expect(publishResult).toMatchObject({
		name: `@usera/${kodyId}`,
		kody_id: kodyId,
		license: '',
		version: '1.0.4',
		status: 'active',
		pinned_commit: publishedCommit,
		public_url: publicUrl,
	})
	const listingId = publishResult.listing_id
	const getListing = () =>
		communityGetCapability.handler({ listing_id: listingId }, forkerCtx)
	expect(queuedListingPublished).toEqual([
		expect.objectContaining({ listingId, eventId: expect.any(String) }),
	])
	queuedListingPublished.length = 0

	const searchResult = await communitySearchCapability.handler(
		{ query: 'community flow integration', limit: 10 },
		forkerCtx,
	)
	expect(searchResult.outcome).toBe('matches')
	const match = searchResult.matches.find(
		(candidate) => candidate.listing_id === listingId,
	)
	expect(match?.relevance).toBeGreaterThanOrEqual(0.2)
	expect(match?.public_url).toBe(publicUrl)

	const getResult = await getListing()
	expect(getResult.readme_untrusted).toContain('## Intent')
	expect(getResult.content_warning).toBe(communityContentWarning)
	expect(getResult).toMatchObject({
		owner_username: 'usera',
		owner_profile_url: `${baseUrl}/@usera`,
		public_url: publicUrl,
		pinned_commit: publishedCommit,
		featured: false,
	})

	const setProfileVisibility = (visibility: string) =>
		runSql(
			`UPDATE users SET profile_visibility = ? WHERE stable_user_id = ?`,
			visibility,
			owner.userId,
		)
	await setProfileVisibility('private')
	expect((await getListing()).owner_profile_url).toBeNull()
	await setProfileVisibility('public')

	const forkResult = await communityForkCapability.handler(
		{ listing_id: listingId },
		forkerCtx,
	)
	expect(forkResult.target_name).toBe(`@userb/${kodyId}`)
	expect(forkResult.serverTiming?.map((entry) => entry.name)).toEqual(
		expect.arrayContaining([
			'prepare',
			'artifacts-fork',
			'artifacts-repo-ready',
			'fork-row',
		]),
	)
	for (const entry of forkResult.serverTiming ?? []) {
		expect(entry.durationMs).toBeGreaterThanOrEqual(0)
	}
	expect(forkResult.cross_scope_references).toEqual(
		expect.arrayContaining([
			{ file: 'src/index.ts', specifier: 'kody:@usera/' },
		]),
	)
	// Forks are inert sources until adopted: no saved package row yet.
	expect(await countSavedPackagesForUser(forker.userId)).toBe(0)
	const forkActivity = {
		eventId: expect.any(String),
		kind: 'fork',
		activityId: forkResult.fork_id,
	}
	expect(queuedActivity).toEqual([forkActivity])
	const forkedSource = await env.APP_DB.prepare(
		`SELECT id, user_id, entity_id, published_commit FROM entity_sources WHERE id = ?`,
	)
		.bind(forkResult.source_id)
		.first<{ published_commit: string | null }>()
	expect(forkedSource).toMatchObject({
		id: forkResult.source_id,
		user_id: forker.userId,
		entity_id: forkResult.package_id,
	})
	expect(forkedSource?.published_commit).toBeTruthy()

	await expect(
		communityRateCapability.handler(
			{ listing_id: listingId, stars: 4, adaptation_effort: 2 },
			reporterCtx,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof CommunityActionError &&
			error.message === 'Fork this public package before rating it.',
	)
	await communityRateCapability.handler(
		{
			listing_id: listingId,
			stars: 5,
			adaptation_effort: 1,
			note: 'Easy to adapt',
		},
		forkerCtx,
	)
	const ratedListing = await getListing()
	// Forks start private, so the public fork count leaves them out.
	expect(ratedListing).toMatchObject({
		rating_count: 1,
		average_stars: 5,
		fork_count: 0,
	})
	expect(queuedActivity).toEqual([
		forkActivity,
		{
			eventId: expect.any(String),
			kind: 'rating',
			activityId: expect.any(String),
		},
	])
	const activity = await listCommunityActivityForAdmin({
		db: testEnv.APP_DB,
		listingId,
		pageSize: 10,
	})
	expect(activity).toMatchObject({ total: 2, page: 1, pageSize: 10 })
	expect(activity.items).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				kind: 'fork',
				listingId,
				listingName: `@usera/${kodyId}`,
				listingKodyId: kodyId,
				actingUsername: 'userb',
			}),
			expect.objectContaining({
				kind: 'rating',
				listingId,
				actingUsername: 'userb',
				stars: 5,
				adaptationEffort: 1,
			}),
		]),
	)

	// Admin curation: featuring is editorial and does not require trust.
	expect(ratedListing.trusted).toBe(false)
	const featuredListing = await setFeatured(true)
	expect(featuredListing.featured).toBe(true)
	expect(featuredListing.featuredAt).toBeTruthy()
	// Re-featuring is idempotent: the original featured_at is preserved so
	// retries never reshuffle the onboarding order.
	expect((await setFeatured(true)).featuredAt).toBe(featuredListing.featuredAt)
	expect(await isFeaturedListed()).toBe(true)
	expect((await getListing()).featured).toBe(true)

	const republishedCommit = `commit-republished-${unique}`
	await writePublishedSourceSnapshot({
		env: testEnv,
		source: { ...seeded.entitySource, published_commit: republishedCommit },
		files: seeded.files,
	})
	await runSql(
		`UPDATE entity_sources SET published_commit = ? WHERE id = ?`,
		republishedCommit,
		sourceId,
	)
	expect((await publish()).pinned_commit).toBe(republishedCommit)
	// Pin moves notify follows in-process. The retired fork-only queue
	// message is no longer enqueued.
	expect(queuedListingPublished).toEqual([])
	expect((await publish()).pinned_commit).toBe(republishedCommit)
	expect(queuedListingPublished).toEqual([])
	// Featured survives republish — it is editorial placement, not trust.
	expect(await getListing()).toMatchObject({
		pinned_commit: republishedCommit,
		featured: true,
	})
	expect(await isFeaturedListed()).toBe(true)
	const unfeatured = await setFeatured(false)
	expect(unfeatured.featured).toBe(false)
	expect(unfeatured.featuredAt).toBeNull()

	// Access control: only admins may reach the featured curation capability.
	expect(
		callerCanAccessCapability(
			forkerCtx.callerContext,
			communitySetFeaturedCapability,
		),
	).toBe(false)

	const reportResult = await communityReportCapability.handler(
		{ listing_id: listingId, reason: 'Suspicious instructions in README' },
		reporterCtx,
	)
	expect(reportResult.status).toBe('open')
	await resolveCommunityReport({
		env: testEnv,
		adminUserId: admin.userId,
		reportId: reportResult.report_id,
		action: 'delist',
		resolutionNote: 'Confirmed policy violation',
	})
	await expect(getListing()).rejects.toThrow('Catalog entry not found.')
	await expect(publish()).rejects.toThrow(
		'was delisted by an admin and cannot be re-published',
	)
	await expect(setFeatured(true)).rejects.toThrow(
		'Delisted catalog entries cannot be featured.',
	)

	await banCommunityUser({
		env: testEnv,
		adminUserId: admin.userId,
		userId: personalOrgId(reporter.userId),
		reason: 'Repeated abusive reports',
	})
	await expect(
		communityReportCapability.handler(
			{ listing_id: listingId, reason: 'Trying again after ban' },
			reporterCtx,
		),
	).rejects.toThrow('banned from community participation')
}, 120_000)

test('one-click install publishes clean listings and keeps unresolvable forks inert', async () => {
	using harness = createFlowHarness()
	const { testEnv } = harness
	const unique = crypto.randomUUID()
	const owner = await insertTestUser({
		email: `install-owner-${unique}@example.com`,
		username: 'installowner',
	})
	const installer = await insertTestUser({
		email: `installer-${unique}@example.com`,
		username: 'installer',
	})
	const ownerCtx = createCapabilityContext(testEnv, owner)
	const installerCtx = createCapabilityContext(testEnv, installer)
	const seedAndPublish = async (name: string, indexTs?: string) => {
		const packageId = `package-${name}-${unique}`
		await seedOwnerPackage({
			testEnv,
			owner,
			packageId,
			sourceId: `source-${name}-${unique}`,
			kodyId: `install-${name}-${unique}`,
			publishedCommit: `commit-${name}-${unique}`,
			indexTs,
		})
		return communityPublishCapability.handler(
			{ package_id: packageId },
			ownerCtx,
		)
	}
	const install = (listingId: string, expectedPinnedCommit: string) =>
		installCommunityListing({
			env: testEnv,
			baseUrl,
			userId: personalOrgId(installer.userId),
			userEmail: installer.email,
			expectedPackageScope: installer.username,
			listingId,
			expectedPinnedCommit,
		})

	// A listing with no cross-scope imports installs end-to-end: the fork
	// passes publish checks and immediately becomes a live saved package.
	const cleanKodyId = `install-clean-${unique}`
	const cleanListing = await seedAndPublish(
		'clean',
		'export default async function main() {\n\treturn { ok: true }\n}\n',
	)

	// A stale acknowledgement (from before a hypothetical republish) is
	// rejected before anything is forked.
	await expect(
		install(cleanListing.listing_id, 'stale-commit-from-before-republish'),
	).rejects.toThrow('This listing changed after you confirmed')

	const installed = await install(
		cleanListing.listing_id,
		cleanListing.pinned_commit,
	)
	expect(installed.status).toBe('installed')
	expect(installed.targetName).toBe(`@installer/${cleanKodyId}`)
	expect(await countSavedPackagesForUser(installer.userId)).toBe(1)
	const savedRow = await env.APP_DB.prepare(
		`SELECT name, kody_id, source_id FROM saved_packages WHERE user_id = ?`,
	)
		.bind(installer.userId)
		.first()
	expect(savedRow).toEqual({
		name: `@installer/${cleanKodyId}`,
		kody_id: cleanKodyId,
		source_id: installed.sourceId,
	})
	const getInstalled = () =>
		getPackageCapability.handler(
			{ package_id: installed.packageId },
			installerCtx,
		)
	const listingLink = (listingId: string, current: boolean) => ({
		source_listing_id: listingId,
		listing_current: current,
		listing_kody_id: cleanKodyId,
	})
	expect(await getInstalled()).toMatchObject(
		listingLink(cleanListing.listing_id, true),
	)
	expect(
		(await listPackagesCapability.handler({}, installerCtx)).packages,
	).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				package_id: installed.packageId,
				...listingLink(cleanListing.listing_id, true),
			}),
		]),
	)

	// A listing whose code imports another user's scope cannot auto-publish:
	// the fork stays inert with the failing checks reported for follow-up.
	const messyListing = await seedAndPublish('messy')
	const adaptationRequired = await install(
		messyListing.listing_id,
		messyListing.pinned_commit,
	)
	expect(adaptationRequired.status).toBe('adaptation_required')
	if (adaptationRequired.status !== 'adaptation_required') return
	expect(adaptationRequired.crossScopeReferences).toEqual(
		expect.arrayContaining([
			{ file: 'src/index.ts', specifier: 'kody:@usera/' },
		]),
	)
	expect(adaptationRequired.failedChecks.map((check) => check.kind)).toContain(
		'bundle',
	)
	// Only the clean install produced a live package; the messy fork is inert.
	expect(await countSavedPackagesForUser(installer.userId)).toBe(1)
	const inertSource = await env.APP_DB.prepare(
		`SELECT id, user_id FROM entity_sources WHERE id = ?`,
	)
		.bind(adaptationRequired.sourceId)
		.first()
	expect(inertSource).toEqual({
		id: adaptationRequired.sourceId,
		user_id: installer.userId,
	})

	await communityUnpublishCapability.handler(
		{ listing_id: cleanListing.listing_id, confirm_name: cleanKodyId },
		ownerCtx,
	)
	expect(await getInstalled()).toMatchObject(
		listingLink(cleanListing.listing_id, false),
	)

	const republishedListing = await communityPublishCapability.handler(
		{ package_id: `package-clean-${unique}` },
		ownerCtx,
	)
	expect(republishedListing.listing_id).not.toBe(cleanListing.listing_id)
	expect(await getInstalled()).toMatchObject(
		listingLink(republishedListing.listing_id, true),
	)
	await communityRateCapability.handler(
		{
			listing_id: republishedListing.listing_id,
			stars: 5,
			adaptation_effort: 1,
			note: 'Still useful after republishing',
		},
		installerCtx,
	)
	// The installer's fork is private, so the public count stays at zero.
	expect(
		await communityGetCapability.handler(
			{ listing_id: republishedListing.listing_id },
			installerCtx,
		),
	).toMatchObject({ rating_count: 1, average_stars: 5, fork_count: 0 })
}, 120_000)
