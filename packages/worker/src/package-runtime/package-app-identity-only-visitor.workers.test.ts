import {
	mintPersonId,
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type RuntimePackageAppVisitor } from '@kody-internal/shared/runtime-worker.ts'
import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { ensureCreditWalletTestSchema } from '#worker/billing/test-schema.ts'
import { ensureCommunityFlowSchema } from '#worker/community/community-flow-test-schema.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensurePersonalOrg } from '#worker/orgs/provision.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { ensureSecretBucketsTestSchema } from '#worker/secrets-test-schema.ts'
import { ensureSoftDeleteTestColumns } from '#worker/soft-delete/test-schema.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import {
	createPackageAppSessionCookie,
	readPackageAppSession,
} from '#app/package-app-session.ts'
import { handlePackageAppRequest } from '#app/handlers/package-app.ts'
import { authorizePackageAppVisitorForOrg } from '#app/package-app-origin.ts'
import {
	buildPackageAppWorker,
	createPackageAppCallerContext,
} from './package-app.ts'
import { createPackageCodeRequest } from './package-app-serve.ts'
import { withPackageAppVisitTicket } from './package-app-visit-ticket.ts'
import {
	packageAppVisitorHeaderName,
	withPackageAppVisitorHeader,
} from './package-app-visitor-header.ts'
import { persistPublishedSourceSnapshot } from './published-runtime-artifacts.ts'

/**
 * A signed-in person who cannot run an internet-visible app is served as an
 * anonymous visitor with a read-only identity. Real boundaries: the
 * production `buildPackageAppWorker` wrapper served from `APP_LOADER`, the
 * real runtime bridge and capability registry, and the same request shaping
 * `servePackageAppRequest` does (`createPackageCodeRequest`, then the visitor
 * header).
 */

async function runSql(sql: string, ...values: Array<unknown>) {
	await env.APP_DB.prepare(sql)
		.bind(...values)
		.run()
}

async function ensureSchema() {
	await ensureEntitlementTestSchema(env.APP_DB)
	await ensureOrgsTestSchema(env.APP_DB)
	await ensureCreditWalletTestSchema(env.APP_DB)
	await ensureUsageRollupsTestSchema(env.APP_DB)
	await runSql(`CREATE TABLE IF NOT EXISTS entity_sources (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		entity_kind TEXT NOT NULL,
		entity_id TEXT NOT NULL,
		repo_id TEXT NOT NULL,
		published_commit TEXT,
		indexed_commit TEXT,
		manifest_path TEXT NOT NULL DEFAULT 'package.json',
		source_root TEXT NOT NULL DEFAULT '/',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`)
	await runSql(`CREATE TABLE IF NOT EXISTS saved_packages (
		id TEXT PRIMARY KEY NOT NULL,
		user_id TEXT NOT NULL,
		name TEXT NOT NULL,
		kody_id TEXT NOT NULL,
		description TEXT NOT NULL,
		tags_json TEXT NOT NULL DEFAULT '[]',
		search_text TEXT,
		source_id TEXT NOT NULL,
		has_app INTEGER NOT NULL DEFAULT 0 CHECK (has_app IN (0, 1)),
		has_skills INTEGER NOT NULL DEFAULT 0 CHECK (has_skills IN (0, 1)),
		hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
		is_private INTEGER NOT NULL DEFAULT 1 CHECK (is_private IN (0, 1)),
		is_internet_visible INTEGER NOT NULL DEFAULT 0,
		locked_at TEXT,
		created_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP),
		updated_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP)
	)`)
	await runSql(`CREATE TABLE IF NOT EXISTS package_app_oauth_grants (
		id TEXT PRIMARY KEY,
		person_id TEXT NOT NULL,
		org_username TEXT NOT NULL,
		kody_id TEXT NOT NULL,
		scopes TEXT NOT NULL,
		created_at TEXT NOT NULL,
		revoked_at TEXT,
		last_used_at TEXT,
		UNIQUE (person_id, org_username, kody_id)
	)`)
	await runSql(`CREATE TABLE IF NOT EXISTS published_bundle_artifacts (
		id TEXT PRIMARY KEY,
		user_id TEXT NOT NULL,
		source_id TEXT NOT NULL,
		published_commit TEXT NOT NULL,
		artifact_kind TEXT NOT NULL,
		artifact_name TEXT,
		entry_point TEXT NOT NULL,
		kv_key TEXT NOT NULL,
		dependencies_json TEXT NOT NULL DEFAULT '[]',
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	)`)
	await runSql(`CREATE TABLE IF NOT EXISTS package_capability_approvals (
		id TEXT PRIMARY KEY NOT NULL,
		package_id TEXT NOT NULL,
		owner_user_id TEXT NOT NULL,
		published_commit TEXT NOT NULL,
		fingerprint TEXT NOT NULL,
		capability_set_json TEXT NOT NULL,
		dependency_snapshot_json TEXT NOT NULL DEFAULT '{}',
		approved_by_user_id TEXT NOT NULL,
		approved_at TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`)
	await ensureSecretBucketsTestSchema(env.APP_DB)
	await ensureSoftDeleteTestColumns(env.APP_DB)
}

const appSource = `import { hasScope, hasVisitorCredential, kody } from 'kody:runtime'
export default {
	async fetch(request) {
		const msg = (e) => String(e?.message ?? e).slice(0, 200)
		const out = {
			header: request.headers.get('X-Kody-Visitor'),
			cookie: request.headers.get('Cookie'),
			ticketKind: (request.headers.get('X-Kody-Visit-Ticket') ?? '').slice(0, 5),
		}
		out.scopes = {
			profile: hasScope(request, 'profile'),
			email: hasScope(request, 'email'),
			calendar: hasVisitorCredential(request, 'calendar'),
		}
		try { out.me = await kody.metaGetCurrentUser({}) } catch (e) { out.meError = msg(e) }
		try { out.secrets = await kody.secretList({}) } catch (e) { out.secretsError = msg(e) }
		try { out.packages = await kody.packageList({}) } catch (e) { out.packagesError = msg(e) }
		return Response.json(out)
	},
}`

const notDeclared = /not listed in kody\.app\.capabilities/

async function setup(input: { capabilities?: Array<string> } = {}) {
	silenceIncidentalRuntimeWarnings()
	await ensureSchema()
	const ownerId = mintPersonId() as string
	const username = `wt-${ownerId.slice(-12)}`
	await ensureUsersTestSchema({ db: env.APP_DB })
	await ensureCommunityFlowSchema(env.APP_DB)
	await env.APP_DB.prepare(
		`INSERT INTO users (username, email, password_hash, stable_user_id)
		 VALUES (?, ?, 'hash', ?)`,
	)
		.bind(username, `${username}@example.com`, ownerId)
		.run()
	await ensurePersonalOrg(env.APP_DB, { stableUserId: ownerId, username })
	const unique = crypto.randomUUID()
	const savedPackage = {
		id: `pkg-${unique}`,
		kodyId: 'visitor-app',
		name: `@${username}/visitor-app`,
		sourceId: `source-${unique}`,
		publishedCommit: `commit-${unique}`,
		manifestPath: 'package.json',
		sourceRoot: '/',
	}
	const now = new Date().toISOString()
	await runSql(
		`INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, source_id, has_app,
			is_internet_visible, created_at, updated_at
		) VALUES (?, ?, ?, ?, 'Visitor app', ?, 1, 1, ?, ?)`,
		savedPackage.id,
		ownerId,
		savedPackage.name,
		savedPackage.kodyId,
		savedPackage.sourceId,
		now,
		now,
	)
	await runSql(
		`INSERT INTO entity_sources (
			id, user_id, entity_kind, entity_id, repo_id, published_commit,
			indexed_commit, manifest_path, source_root, created_at, updated_at
		) VALUES (?, ?, 'package', ?, ?, ?, NULL, 'package.json', '/', ?, ?)`,
		savedPackage.sourceId,
		ownerId,
		savedPackage.id,
		`repo-${savedPackage.sourceId}`,
		savedPackage.publishedCommit,
		now,
		now,
	)
	const source = {
		id: savedPackage.sourceId,
		user_id: ownerIdFromStored(ownerId),
		entity_kind: 'package' as const,
		entity_id: savedPackage.id,
		repo_id: `repo-${savedPackage.sourceId}`,
		published_commit: savedPackage.publishedCommit,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		last_external_check_at: null,
		external_check_until: null,
		created_at: now,
		updated_at: now,
	}
	const sourceFiles = {
		'package.json': JSON.stringify({
			name: savedPackage.name,
			exports: {},
			kody: {
				id: savedPackage.kodyId,
				description: 'Visitor app',
				app: { entry: 'src/app.ts', capabilities: input.capabilities },
			},
		}),
		'src/app.ts': appSource,
	}
	await persistPublishedSourceSnapshot({
		env,
		userId: ownerId,
		source,
		snapshot: { files: sourceFiles },
	})
	const owner = {
		userId: ownerIdFromStored(ownerId),
		username,
		email: 'owner@example.com',
	}

	async function serve(input: {
		visitor: RuntimePackageAppVisitor | null
		identity?: { userId: string; username: string } | null
		inboundHeaders?: Record<string, string>
	}) {
		const callerContext = await createPackageAppCallerContext({
			baseUrl: 'https://kody.dev',
			owner,
			visitor: input.visitor,
			packageId: savedPackage.id,
		})
		const appWorker = await buildPackageAppWorker({
			env,
			baseUrl: 'https://kody.dev',
			userId: owner.userId,
			surface: 'app_fetch',
			savedPackage,
			source,
			sourceFiles,
			waitUntil: (promise) => {
				void promise.catch(() => {})
			},
			runtime: { callerContext, servingUsername: username },
		})
		const inbound = new Request(`https://${username}.packages.isolated.test/`, {
			headers: input.inboundHeaders,
		})
		const identity = input.identity
			? {
					userId: personIdFromStored(input.identity.userId),
					username: input.identity.username,
				}
			: null
		const request = withPackageAppVisitTicket(
			withPackageAppVisitorHeader(createPackageCodeRequest(inbound), {
				visitor: input.visitor,
				identity: input.visitor ? null : identity,
			}),
			appWorker.visit.ticket,
		)
		const response = await appWorker.stub
			.getEntrypoint(appWorker.entrypointName)
			.fetch(request)
		const text = await response.text()
		expect(response.status).toBe(200)
		return JSON.parse(text) as Record<string, unknown>
	}

	return { ownerId, username, packageId: savedPackage.id, serve }
}

test(
	'a package-app session becomes a verified visitor header without exposing its cookie',
	{ timeout: 120_000 },
	async () => {
		const t = await setup()
		const [setCookie] = await createPackageAppSessionCookie({
			env,
			session: { stableUserId: t.ownerId, username: t.username },
			slug: 'visitor-app',
			secure: true,
			expiresAt: Date.now() + 60_000,
		})
		const request = new Request(
			`https://kody.dev/@${t.username}/packages/visitor-app`,
			{ headers: { Cookie: setCookie?.split(';')[0] ?? '' } },
		)
		const parsedSession = await readPackageAppSession({
			request,
			env,
			slug: 'visitor-app',
		})
		expect(parsedSession?.session.stableUserId).toBe(t.ownerId)
		const authorized = parsedSession
			? await authorizePackageAppVisitorForOrg({
					env,
					stableUserId: parsedSession.session.stableUserId,
					issuedAt: parsedSession.issuedAt,
					handle: t.username,
					kodyId: 'visitor-app',
				})
			: null
		expect(authorized?.kind).toBe('ok')
		const response = await handlePackageAppRequest(request, env)
		expect(
			response.status,
			response.headers.get('Location') ?? 'no redirect location',
		).toBe(200)
		const body = (await response.json()) as {
			header: string
			cookie: string | null
		}
		expect(JSON.parse(body.header)).toEqual({
			userId: t.ownerId,
			username: t.username,
			role: 'owner',
			scopes: ['profile'],
		})
		expect(body.cookie).toBeNull()
	},
)

test(
	'a signed-in outsider gets their identity from metaGetCurrentUser and nothing else',
	{ timeout: 120_000 },
	async () => {
		const t = await setup()
		const outsiderId = `user-${crypto.randomUUID()}`
		const body = await t.serve({
			visitor: null,
			identity: { userId: outsiderId, username: 'outside-visitor' },
		})
		expect(body.me).toEqual({
			user_id: outsiderId,
			username: 'outside-visitor',
			email: '',
			display_name: 'outside-visitor',
			org: { slug: t.username },
			scopes: ['profile'],
		})
		expect(body.scopes).toEqual({
			profile: true,
			email: false,
			calendar: false,
		})
		expect(body.meError).toBeUndefined()
		expect(JSON.parse(String(body.header))).toEqual({
			userId: outsiderId,
			username: 'outside-visitor',
			role: null,
			scopes: ['profile'],
		})
		// No new access: undeclared calls never run as the publisher, and the
		// visitor's own identity grants nothing.
		expect(body.secrets).toBeUndefined()
		expect(String(body.secretsError)).toMatch(notDeclared)
		expect(body.packages).toBeUndefined()
		expect(String(body.packagesError)).toMatch(notDeclared)
		// Both refusals reached the app, so both count as hard rejections.
		await expect
			.poll(
				async () =>
					(
						await env.APP_DB.prepare(
							`SELECT call_name, difference_kind, visitor_hash
							 FROM package_app_authority_rejections
							 WHERE package_id = ? ORDER BY call_name`,
						)
							.bind(t.packageId)
							.all()
					).results,
				{ timeout: 15_000 },
			)
			.toEqual([
				{
					call_name: 'packageList',
					difference_kind: 'capability_not_declared',
					visitor_hash: 'anonymous',
				},
				{
					call_name: 'secretList',
					difference_kind: 'capability_not_declared',
					visitor_hash: 'anonymous',
				},
			])
	},
)

test(
	'an anonymous visitor still has no identity, even with a forged visitor header',
	{ timeout: 120_000 },
	async () => {
		const t = await setup()
		const forged = JSON.stringify({
			userId: `user-${crypto.randomUUID()}`,
			username: 'forged',
			role: 'owner',
		})
		for (const inboundHeaders of [
			undefined,
			{ [packageAppVisitorHeaderName]: forged },
		]) {
			const body = await t.serve({ visitor: null, inboundHeaders })
			// An anonymous ticket scopes credential clients to this request
			// and names nobody.
			expect(body.ticketKind).toBe('kva1.')
			expect(body.header).toBeNull()
			expect(body.me).toBeUndefined()
			expect(String(body.meError)).toMatch(/Authenticated MCP user is required/)
			expect(String(body.secretsError)).toMatch(notDeclared)
		}
	},
)

test(
	'the owner is unchanged: the bridge answers as them with their role',
	{ timeout: 120_000 },
	async () => {
		const t = await setup()
		const body = await t.serve({
			visitor: {
				userId: personIdFromStored(t.ownerId),
				username: t.username,
				role: 'owner',
			},
			// Ignored with a visitor.
			identity: { userId: `user-${crypto.randomUUID()}`, username: 'nope' },
		})
		expect(body.meError).toBeUndefined()
		expect(body.me).toMatchObject({
			user_id: t.ownerId,
			username: t.username,
			org: { slug: t.username },
		})
		expect(JSON.parse(String(body.header))).toEqual({
			userId: t.ownerId,
			username: t.username,
			role: 'owner',
			scopes: ['profile'],
		})
	},
)

test(
	'a declared capability runs as the publisher for every visitor, and nothing else does',
	{ timeout: 120_000 },
	async () => {
		const t = await setup({ capabilities: ['secretList'] })
		for (const input of [
			{ visitor: null, identity: null },
			{
				visitor: null,
				identity: {
					userId: `user-${crypto.randomUUID()}`,
					username: 'outsider',
				},
			},
		]) {
			const body = await t.serve(input)
			expect(body.secretsError).toBeUndefined()
			expect(body.secrets).toBeDefined()
			expect(body.packages).toBeUndefined()
			expect(String(body.packagesError)).toMatch(notDeclared)
		}
	},
)
