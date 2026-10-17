import { platformIntegrationSaveSchema } from '#universal/admin-provider-mutations.ts'
import type * as AuthenticatedUser from '#app/authenticated-user.ts'
import { type PermissionString, type RoleName } from '#universal/permissions.ts'
import type * as AuditLog from '#worker/audit-log.ts'
import { adminOperationOutcome } from '#worker/test-support/admin-operation-outcome.ts'
import { applyAllMigrations as applyRepositoryMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createFakeImagesBinding } from '#worker/test-support/images-binding.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser:
		vi.fn<typeof AuthenticatedUser.readAuthenticatedAppUser>(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof AuthenticatedUser.readAuthenticatedAppUser>
	) => mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		getRequestIp: () => '127.0.0.1',
		logAuditEvent: (...args: Parameters<typeof actual.logAuditEvent>) =>
			logAuditEventSpy(...args),
	}
})

const { saveAdminPlatformIntegration, deleteAdminPlatformIntegration } =
	await import('#worker/admin/platform-integrations-operations.ts')

const migrationsDirectory = new URL('../../../migrations/', import.meta.url)

type AppsPayload = { apps: Array<{ slug: string; label?: string }> }

function createActor(
	roles: Array<RoleName>,
): AuthenticatedUser.AuthenticatedAppUser {
	const permissions: Array<PermissionString> = roles.includes('admin')
		? ['read:user:any', 'update:user:any']
		: ['read:user:own']
	return {
		sessionUserId: '1',
		userId: 1,
		email: 'admin@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		username: 'admin-user',
		displayName: 'admin-user',
		roles,
		permissions,
		artifactOwnerIds: ['1'],
		mcpUser: {
			userId: personIdFromStored('1'.padStart(64, '0')),
			email: 'admin@example.com',
			username: 'admin-user',
			displayName: 'admin-user',
		},
		request: sessionRequestContext('1'.padStart(64, '0')),
	}
}

function createHarness() {
	const sqlite = new DatabaseSync(':memory:')
	applyRepositoryMigrations(sqlite, migrationsDirectory)
	const objects = new Map<string, Uint8Array>()
	const env = {
		APP_DB: createD1FromSqlite(sqlite),
		SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
		COMMUNITY_ASSETS: {
			async put(key: string, bytes: Uint8Array) {
				objects.set(key, bytes)
			},
			async get(key: string) {
				return objects.has(key) ? { body: objects.get(key) } : null
			},
			async delete(key: string) {
				objects.delete(key)
			},
		} as unknown as R2Bucket,
		IMAGES: createFakeImagesBinding(),
	} as unknown as Env
	mockModule.readAuthenticatedAppUser.mockResolvedValue(createActor(['admin']))
	const url = new URL('https://example.com/admin/platform-integrations')
	const invoke = (body: Record<string, unknown>) =>
		adminOperationOutcome(() =>
			body.action === 'delete'
				? deleteAdminPlatformIntegration({
						env,
						request: new Request(url, {
							headers: { Accept: 'application/json' },
						}),
						slug: String(body.slug ?? ''),
					})
				: saveAdminPlatformIntegration({
						env,
						request: new Request(url, {
							headers: { Accept: 'application/json' },
						}),
						data: platformIntegrationSaveSchema.parse(body),
					}),
		)
	const connectGithubUser = () =>
		sqlite
			.prepare(
				`INSERT INTO user_integrations (
					user_id, name, app_slug, platform_app_slug
				) VALUES (?, ?, NULL, ?)`,
			)
			.run('user-1', 'github', 'github')
	const read = async () => {
		const { loadAdminPlatformIntegrationsData } =
			await import('#app/admin-platform-integrations-data.ts')
		return loadAdminPlatformIntegrationsData(env)
	}
	return { sqlite, invoke, connectGithubUser, read }
}

const saveGithubBody = {
	action: 'save',
	slug: 'github',
	clientId: 'platform-github-client-id',
	clientSecret: 'platform-github-client-secret-value',
	tokenUrl: 'https://github.com/login/oauth/access_token',
	authorizeUrl: 'https://github.com/login/oauth/authorize',
	flow: 'confidential',
	allowedScopes: ['repo', 'read:user'],
	defaultScopes: ['read:user'],
	requiredHosts: ['api.github.com'],
}

const editGithubBody = {
	action: 'save',
	clientId: saveGithubBody.clientId,
	tokenUrl: saveGithubBody.tokenUrl,
	authorizeUrl: saveGithubBody.authorizeUrl,
	flow: 'confidential',
}

test('admin save and delete require admin and return HTTP shapes without echoing secrets', async () => {
	const { sqlite, invoke, connectGithubUser, read } = createHarness()

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(
		createActor(['user']),
	)
	expect((await invoke(saveGithubBody)).status).toBe(403)

	const created = await invoke(saveGithubBody)
	expect(created.status).toBe(200)
	expect(created.data).toEqual({ ok: true })
	const createdPayload = (await read()) as AppsPayload
	expect(createdPayload.apps[0]).toMatchObject({
		slug: 'github',
		hasClientSecret: true,
		enabled: true,
		visibility: 'draft',
	})
	expect(JSON.stringify(createdPayload)).not.toContain(
		'platform-github-client-secret-value',
	)

	// The admin UI's Publish / Move to draft buttons post the edit shape plus
	// `visibility`; enable/disable is untouched.
	const publish = await invoke({
		...editGithubBody,
		slug: 'github',
		visibility: 'published',
	})
	expect(publish.status).toBe(200)
	expect(publish.data).toEqual({ ok: true })
	expect(((await read()) as AppsPayload).apps[0]).toMatchObject({
		enabled: true,
		visibility: 'published',
	})
	const kept = await invoke({ ...editGithubBody, slug: 'github' })
	expect(kept.data).toEqual({ ok: true })
	expect(((await read()) as AppsPayload).apps[0]).toMatchObject({
		visibility: 'published',
	})
	expect(
		platformIntegrationSaveSchema.safeParse({
			...editGithubBody,
			slug: 'github',
			visibility: 'Draft',
		}).success,
	).toBe(false)
	const unpublish = await invoke({
		...editGithubBody,
		slug: 'github',
		visibility: 'draft',
	})
	expect(unpublish.data).toEqual({ ok: true })
	expect(((await read()) as AppsPayload).apps[0]).toMatchObject({
		enabled: true,
		visibility: 'draft',
	})

	connectGithubUser()
	const blocked = await invoke({ action: 'delete', slug: 'github' })
	expect(blocked.status).toBe(400)
	await expect(Promise.resolve(blocked.data)).resolves.toMatchObject({
		ok: false,
		error: expect.stringContaining('still has 1 user connection'),
	})

	sqlite.prepare('DELETE FROM user_integrations').run()
	const deleted = await invoke({ action: 'delete', slug: 'github' })
	expect(deleted.status).toBe(200)
	expect(deleted.data).toEqual({ ok: true })
	expect((await read()).apps).toEqual([])
})

test('save with newSlug renames in place, keeping the secret and connections', async () => {
	const { sqlite, invoke, connectGithubUser, read } = createHarness()

	await invoke(saveGithubBody)
	connectGithubUser()

	// Rename plus a same-call edit; clientSecret omitted → retained.
	const renamed = await invoke({
		...editGithubBody,
		slug: 'github',
		newSlug: 'github-platform',
		label: 'GitHub',
	})
	expect(renamed.status).toBe(200)
	expect(renamed.data).toEqual({ ok: true })
	const payload = (await read()) as AppsPayload
	expect(payload.apps.map((app: { slug: string }) => app.slug)).toEqual([
		'github-platform',
	])
	expect(payload.apps[0]).toMatchObject({
		slug: 'github-platform',
		label: 'GitHub',
		hasClientSecret: true,
		connectionCount: 1,
	})
	// The connection moved lanes-intact: same name, new app reference.
	expect(
		sqlite
			.prepare(`SELECT name, platform_app_slug FROM user_integrations`)
			.get(),
	).toEqual({ name: 'github', platform_app_slug: 'github-platform' })

	// Renaming onto an occupied slug is a clean 400.
	await invoke({ ...saveGithubBody, slug: 'occupied' })
	const collision = await invoke({
		...editGithubBody,
		slug: 'github-platform',
		newSlug: 'occupied',
	})
	expect(collision.status).toBe(400)
	await expect(Promise.resolve(collision.data)).resolves.toMatchObject({
		ok: false,
		error: expect.stringContaining('already exists'),
	})

	// A case-only slug edit is not a rename: the save applies normally.
	const caseOnly = await invoke({
		...editGithubBody,
		slug: 'github-platform',
		newSlug: 'GitHub-Platform',
		label: 'GitHub (case-only edit)',
	})
	expect(caseOnly.status).toBe(200)
	expect(caseOnly.data).toEqual({ ok: true })
	const caseOnlyPayload = (await read()) as AppsPayload
	expect(
		caseOnlyPayload.apps.find(
			(app: { slug: string }) => app.slug === 'github-platform',
		)?.label,
	).toBe('GitHub (case-only edit)')

	// When the post-rename upsert rejects, the rename rolls back so the row
	// never sticks under a half-applied slug.
	const failedEdit = await invoke({
		...editGithubBody,
		slug: 'github-platform',
		newSlug: 'github-hosted',
		// Explicit null clears the stored secret while enabled → rejected.
		clientSecret: null,
		enabled: true,
	})
	expect(failedEdit.status).toBe(400)
	const after = await invoke({ ...editGithubBody, slug: 'github-platform' })
	expect(after.data).toEqual({ ok: true })
	const slugs = ((await read()) as AppsPayload).apps.map(
		(app: { slug: string }) => app.slug,
	)
	expect(slugs).toContain('github-platform')
	expect(slugs).not.toContain('github-hosted')
})
