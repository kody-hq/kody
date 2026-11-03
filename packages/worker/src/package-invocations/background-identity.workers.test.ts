import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { env } from 'cloudflare:workers'
import { expect, test, vi } from 'vitest'
import { metaGetCurrentUserCapability } from '#mcp/capabilities/meta/meta-get-current-user.ts'
import type { McpCallerContext } from '@kody-internal/shared/chat.ts'
import { ensureUsersTestSchema } from '#worker/users-test-schema.ts'
import { runSavedPackageModuleOnce } from './module-execution.ts'
import type * as ModuleArtifacts from './module-artifacts.ts'
import type * as RunKodyRegistry from '#mcp/run-kody-registry.ts'

const mocks = vi.hoisted(() => ({
	ensureModuleArtifact: vi.fn(),
	runBundledModuleWithRegistry: vi.fn(),
}))

vi.mock('./module-artifacts.ts', async (importOriginal) => ({
	...(await importOriginal<typeof ModuleArtifacts>()),
	ensureModuleArtifact: mocks.ensureModuleArtifact,
}))

vi.mock('#mcp/run-kody-registry.ts', async (importOriginal) => ({
	...(await importOriginal<typeof RunKodyRegistry>()),
	runBundledModuleWithRegistry: mocks.runBundledModuleWithRegistry,
}))

test('subscription execution exposes the owner account identity to metaGetCurrentUser', async () => {
	const userId = ownerIdFromStored('a').repeat(64)
	const email = 'subscription-owner@example.com'
	const displayName = 'Subscription Owner'
	await ensureUsersTestSchema({
		db: env.APP_DB,
		columns: ['email_verified_at'],
	})
	await env.APP_DB.prepare(
		`INSERT INTO users (
			username,
			email,
			display_name,
			password_hash,
			stable_user_id
		) VALUES (?, ?, ?, ?, ?)`,
	)
		.bind(
			'subscription-owner',
			email,
			displayName,
			'test-password-hash',
			userId,
		)
		.run()

	mocks.ensureModuleArtifact.mockResolvedValue({
		artifact: {
			version: 1,
			kind: 'module',
			artifactName: 'subscription:email.message.received',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			entryPoint: 'src/email-message-received.ts',
			mainModule: 'dist/subscription.js',
			modules: {
				'dist/subscription.js':
					'export default async function main() { return null }',
			},
			dependencies: [],
			packageContext: {
				packageId: 'package-1',
				kodyId: 'article-to-audio',
				sourceId: 'source-1',
			},
			createdAt: '2026-08-08T00:00:00.000Z',
		},
		source: {
			id: 'source-1',
			user_id: userId,
			entity_kind: 'package',
			entity_id: 'package-1',
			repo_id: 'repo-1',
			published_commit: 'commit-1',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			created_at: '2026-08-08T00:00:00.000Z',
			updated_at: '2026-08-08T00:00:00.000Z',
		},
	})
	mocks.runBundledModuleWithRegistry.mockImplementation(
		async (_env: Env, callerContext: McpCallerContext) => ({
			result: await metaGetCurrentUserCapability.handler(
				{},
				{ env, callerContext },
			),
			logs: [],
		}),
	)

	const outcome = await runSavedPackageModuleOnce({
		env,
		baseUrl: 'https://kody.dev',
		actor: {
			sourceId: 'internal:email-subscriptions',
			orgId: ownerIdFromStored(userId),
			request: {
				kind: 'inbound-email',
				sourceId: 'inbox-1',
				sender: { kind: 'inbox-owner' },
			},
		},
		savedPackage: {
			id: 'package-1',
			userId: ownerIdFromStored(userId),
			name: '@example/article-to-audio',
			kodyId: 'article-to-audio',
			description: 'Article to audio',
			tags: [],
			searchText: null,
			sourceId: 'source-1',
			hasApp: false,
			hasSkills: false,
			hidden: false,
			isPrivate: true,
			isInternetVisible: false,
			createdAt: '2026-08-08T00:00:00.000Z',
			updatedAt: '2026-08-08T00:00:00.000Z',
			lockedAt: null,
		},
		invocationName: 'subscription:email.message.received',
		moduleSelector: {
			kind: 'subscription',
			topic: 'email.message.received',
		},
		params: { event: 'email.message.received' },
		idempotencyKey: null,
		invocationId: null,
		source: 'email',
		topic: 'email.message.received',
		notFoundCode: 'subscription_not_found',
		toolFactories: {
			createPackageEventTools: vi.fn(() => ({}) as never),
		},
	})

	expect(outcome).toMatchObject({
		kind: 'completed',
		response: {
			status: 200,
			body: {
				result: {
					user_id: userId,
					email,
					display_name: displayName,
				},
			},
		},
	})
})
