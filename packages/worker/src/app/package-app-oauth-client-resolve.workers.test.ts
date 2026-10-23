import { env } from 'cloudflare:workers'
import { expect, test } from 'vitest'
import { resolvePackageAppOauthClient } from '#app/package-app-oauth-client-resolve.ts'
import { ensureOrgsTestSchema } from '#worker/orgs/orgs-test-schema.ts'
import {
	ensurePackageSubscriptionTestSchema,
	ensureRbacTestSchema,
	seedAccount,
} from '#worker/test-support/workers-seed.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const ownerEmail = 'oauth-resolve-owner@example.com'
const ownerUsername = 'oauthresolve'
const appSlug = 'demo-app'

async function seedOwnerWithApp(input?: {
	hasApp?: boolean
	slug?: string
	packageId?: string
}) {
	await ensureRbacTestSchema(env.APP_DB)
	await ensureOrgsTestSchema(env.APP_DB)
	await ensurePackageSubscriptionTestSchema(env.APP_DB)
	await seedAccount({
		db: env.APP_DB,
		email: ownerEmail,
		username: ownerUsername,
	})
	const ownerId = testStableUserIdFromEmail(ownerEmail)
	const now = '2026-10-16T00:00:00.000Z'
	const hasApp = input?.hasApp === false ? 0 : 1
	const slug = input?.slug ?? appSlug
	const packageId = input?.packageId ?? `pkg-oauth-resolve-${slug}`
	await env.APP_DB.prepare(
		`INSERT OR REPLACE INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, search_text,
			source_id, has_app, hidden, is_private, is_internet_visible,
			created_at, updated_at
		) VALUES (?, ?, ?, ?, '', '[]', NULL, ?, ?, 0, 1, 0, ?, ?)`,
	)
		.bind(
			packageId,
			ownerId,
			`@${ownerUsername}/${slug}`,
			slug,
			`src-oauth-resolve-${slug}`,
			hasApp,
			now,
			now,
		)
		.run()
	return slug
}

test('resolvePackageAppOauthClient accepts a real owner/leaf with has_app', async () => {
	await seedOwnerWithApp()
	const resolved = await resolvePackageAppOauthClient({
		env,
		username: ownerUsername,
		kodyId: appSlug,
	})
	expect(resolved).not.toBeNull()
	expect(resolved?.client).toEqual({
		username: ownerUsername,
		kodyId: appSlug,
		clientId: `${ownerUsername}/${appSlug}`,
	})
	expect(resolved?.savedPackage.hasApp).toBe(true)
})

test('resolvePackageAppOauthClient rejects packages without has_app', async () => {
	// Distinct slug so the invoke freshness cache from the has_app=1 case
	// cannot mask this row.
	const slug = await seedOwnerWithApp({
		hasApp: false,
		slug: 'library-only',
		packageId: 'pkg-oauth-resolve-library-only',
	})
	await expect(
		resolvePackageAppOauthClient({
			env,
			username: ownerUsername,
			kodyId: slug,
		}),
	).resolves.toBeNull()
})

test('resolvePackageAppOauthClient rejects unknown owner labels', async () => {
	await seedOwnerWithApp()
	await expect(
		resolvePackageAppOauthClient({
			env,
			username: 'kentcdodds-world-builder',
			kodyId: 'world-builder',
		}),
	).resolves.toBeNull()
})

test('resolvePackageAppOauthClient rejects missing leaf under a real owner', async () => {
	await seedOwnerWithApp()
	await expect(
		resolvePackageAppOauthClient({
			env,
			username: ownerUsername,
			kodyId: 'no-such-app',
		}),
	).resolves.toBeNull()
})

test('resolvePackageAppOauthClient rejects a retired slug instead of rewriting client_id', async () => {
	const liveSlug = await seedOwnerWithApp({
		slug: 'live-leaf',
		packageId: 'pkg-oauth-resolve-live-leaf',
	})
	const ownerId = testStableUserIdFromEmail(ownerEmail)
	const now = '2026-10-16T00:00:00.000Z'
	await env.APP_DB.prepare(
		`INSERT OR REPLACE INTO package_slug_redirects (
			user_id, old_slug, package_id, created_at
		) VALUES (?, ?, ?, ?)`,
	)
		.bind(ownerId, 'retired-leaf', 'pkg-oauth-resolve-live-leaf', now)
		.run()
	await expect(
		resolvePackageAppOauthClient({
			env,
			username: ownerUsername,
			kodyId: 'retired-leaf',
		}),
	).resolves.toBeNull()
	await expect(
		resolvePackageAppOauthClient({
			env,
			username: ownerUsername,
			kodyId: liveSlug,
		}),
	).resolves.toMatchObject({
		client: { clientId: `${ownerUsername}/${liveSlug}` },
	})
})
