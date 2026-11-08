import {
	mintPersonId,
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import type { RuntimePackageAppVisitor } from '@kody-internal/shared/runtime-worker.ts'
import { env } from 'cloudflare:workers'
import { expect } from 'vitest'
import { ensureCreditWalletTestSchema } from '#worker/billing/test-schema.ts'
import { ensureCommunityFlowSchema } from '#worker/community/community-flow-test-schema.ts'
import { ensureEntitlementTestSchema } from '#worker/entitlements/test-schema.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import { ensurePersonalOrg } from '#worker/orgs/provision.ts'
import {
	buildPackageAppWorker,
	createPackageAppCallerContext,
} from '#worker/package-runtime/package-app.ts'
import { createPackageCodeRequest } from '#worker/package-runtime/package-app-serve.ts'
import { withPackageAppVisitTicket } from '#worker/package-runtime/package-app-visit-ticket.ts'
import { withPackageAppVisitorHeader } from '#worker/package-runtime/package-app-visitor-header.ts'
import { persistPublishedSourceSnapshot } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { entitySourcesTableSql } from '#worker/repo/entity-sources-test-schema.ts'
import { ensureSecretBucketsTestSchema } from '#worker/secrets-test-schema.ts'
import { ensureSoftDeleteTestColumns } from '#worker/soft-delete/test-schema.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { ensureUsageRollupsTestSchema } from '#worker/usage/test-schema.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'

/**
 * A saved package app served through the real boundaries: the production
 * `buildPackageAppWorker` wrapper served from `APP_LOADER`, the real runtime
 * bridge and capability registry, and the same request shaping
 * `servePackageAppRequest` does (`createPackageCodeRequest`, then the visitor
 * header). `appSource` is the app's `src/app.ts`.
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
	await runSql(entitySourcesTableSql)
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
	await runSql(`CREATE TABLE IF NOT EXISTS package_app_rate_limits (
		bucket_key TEXT PRIMARY KEY,
		window_start INTEGER NOT NULL,
		count INTEGER NOT NULL
	)`)
	await ensureSecretBucketsTestSchema(env.APP_DB)
	await ensureSoftDeleteTestColumns(env.APP_DB)
}

export async function setupServedPackageApp(input: {
	appSource: string
	capabilities?: Array<string>
	credentials?: Record<string, unknown>
	visitorNeeds?: Array<unknown>
	/** Owned by a team org (the owner person is its Owner) instead of a personal org. */
	teamOrg?: boolean
}) {
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
	// A team org app: the owner is an Owner member and the app runs as them.
	const appOwnerId = input.teamOrg ? (mintPersonId() as string) : ownerId
	const appSlug = input.teamOrg ? `team-${appOwnerId.slice(-12)}` : username
	if (input.teamOrg) {
		const createdAt = new Date().toISOString()
		await env.APP_DB.prepare(
			`INSERT INTO orgs (id, slug, display_name, plan, created_at, updated_at)
			 VALUES (?, ?, 'Team app org', 'free', ?, ?)`,
		)
			.bind(appOwnerId, appSlug, createdAt, createdAt)
			.run()
		await env.APP_DB.prepare(
			`INSERT INTO handles (handle, org_id, created_at) VALUES (?, ?, ?)`,
		)
			.bind(appSlug, appOwnerId, createdAt)
			.run()
		await env.APP_DB.prepare(
			`INSERT INTO org_memberships (org_id, user_id, role, created_at)
			 VALUES (?, ?, 'owner', ?)`,
		)
			.bind(appOwnerId, ownerId, createdAt)
			.run()
	}
	const unique = crypto.randomUUID()
	const savedPackage = {
		id: `pkg-${unique}`,
		kodyId: 'visitor-app',
		name: `@${appSlug}/visitor-app`,
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
		appOwnerId,
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
		appOwnerId,
		savedPackage.id,
		`repo-${savedPackage.sourceId}`,
		savedPackage.publishedCommit,
		now,
		now,
	)
	const source = {
		id: savedPackage.sourceId,
		user_id: ownerIdFromStored(appOwnerId),
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
				...(input.credentials ? { credentials: input.credentials } : {}),
				app: {
					entry: 'src/app.ts',
					capabilities: input.capabilities,
					...(input.visitorNeeds ? { visitorNeeds: input.visitorNeeds } : {}),
				},
			},
		}),
		'src/app.ts': input.appSource,
	}
	await persistPublishedSourceSnapshot({
		env,
		userId: appOwnerId,
		source,
		snapshot: { files: sourceFiles },
	})
	const owner = {
		userId: ownerIdFromStored(appOwnerId),
		username: appSlug,
		email: 'owner@example.com',
	}

	async function serve(input: {
		visitor: RuntimePackageAppVisitor | null
		identity?: { userId: string; username: string } | null
		inboundHeaders?: Record<string, string>
		executorVisit?: {
			visitor: RuntimePackageAppVisitor
			grantId: string
			scopes: ReadonlyArray<string>
		} | null
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
			runtime: {
				callerContext,
				servingUsername: appSlug,
				executorVisit: input.executorVisit ?? null,
			},
		})
		const inbound = new Request(`https://${appSlug}.packages.isolated.test/`, {
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

	return {
		ownerId,
		username,
		appOwnerId,
		appSlug,
		packageId: savedPackage.id,
		savedPackage,
		serve,
	}
}
