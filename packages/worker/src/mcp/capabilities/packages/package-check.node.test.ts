import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { createSnapshotFilesWorkspace } from '#worker/repo/checks.ts'
import { runAuthoringPublishChecks } from '#worker/repo/authoring-publish-checks.ts'

const mockModule = vi.hoisted(() => ({
	resolvePackageOwnerContext: vi.fn(),
	resolveOwnedPackageSource: vi.fn(),
}))

vi.mock('#worker/package-registry/package-owner.ts', () => ({
	resolvePackageOwnerContext: (...args: Array<unknown>) =>
		mockModule.resolvePackageOwnerContext(...args),
}))

vi.mock('./resolve-package-source.ts', () => ({
	resolveOwnedPackageSource: (...args: Array<unknown>) =>
		mockModule.resolveOwnedPackageSource(...args),
}))

const { packageCheckCapability } = await import('./package-check.ts')

const owner = {
	ownerUserId: ownerIdFromStored('user-1'),
	ownerScope: 'acme',
	ownerEmail: 'user-1@example.com',
	actorUserId: 'user-1',
}
const env = { APP_DB: {} } as unknown as Env

function callerContext() {
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://kody.test',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'user-1@example.com',
			displayName: 'user-1',
		},
	})
}

/**
 * The reported case: a stamped package (kody.credentials declared, so the
 * credential stamp gate applies) whose fetch uses a `|scope=package`
 * placeholder. Local bundling is happy with it; publish refuses it.
 */
function stampedScopePackageFiles(): Record<string, string> {
	return {
		'package.json': JSON.stringify({
			name: '@acme/poll',
			type: 'module',
			exports: { '.': './src/index.ts' },
			kody: {
				id: 'poll',
				description: 'Polls an API.',
				credentials: {
					TOKEN: { kind: 'secret', description: 'API token for the poll.' },
				},
			},
		}),
		'README.md': '# poll\n\nPolls an API.\n',
		'AGENTS.md': '# Agents\n\nCall the default export.\n',
		'src/index.ts': [
			'export default async function poll() {',
			"\tconst response = await fetch('https://api.example.com/poll', {",
			"\t\theaders: { Authorization: 'Bearer {{secret:TOKEN|scope=package}}' },",
			'\t})',
			'\treturn response.status',
			'}',
		].join('\n'),
	}
}

async function check(files: Record<string, string>) {
	return (await packageCheckCapability.handler(
		{ files },
		{ env, callerContext: callerContext() },
	)) as {
		ok: boolean
		package_name: string | null
		checks: Array<{ kind: string; ok: boolean; message: string }>
	}
}

function resetMocks() {
	mockModule.resolvePackageOwnerContext.mockReset()
	mockModule.resolveOwnedPackageSource.mockReset()
	mockModule.resolvePackageOwnerContext.mockResolvedValue(owner)
	mockModule.resolveOwnedPackageSource.mockRejectedValue(
		new Error('Package not found.'),
	)
}

test('packageCheck refuses a stamped package that uses |scope=package, with the publish gate message', async () => {
	resetMocks()
	const result = await check(stampedScopePackageFiles())
	expect(result.ok).toBe(false)
	expect(result.package_name).toBe('@acme/poll')
	const credentials = result.checks.find(
		(entry) => entry.kind === 'credentials',
	)
	expect(credentials?.ok).toBe(false)
	expect(credentials?.message).toMatch(/Credential stamp publish gate/)
	expect(credentials?.message).toMatch(/\|scope=/)
	// The gate stops the run, exactly as publish does.
	expect(result.checks.some((entry) => entry.kind === 'bundle')).toBe(false)
	expect(mockModule.resolveOwnedPackageSource).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: owner.ownerUserId,
			ownerScope: 'acme',
			args: { kody_id: 'poll' },
		}),
	)
})

test('packageCheck reports the same results publish computes for the same tree', async () => {
	resetMocks()
	const files = stampedScopePackageFiles()
	const viaCapability = await check(files)
	// Publish (publishFromExternalRef) calls runAuthoringPublishChecks on its
	// cloned workspace with the owner scope. Same tree, same answer.
	const viaPublish = await runAuthoringPublishChecks({
		workspace: createSnapshotFilesWorkspace(files),
		manifestPath: 'package.json',
		sourceRoot: '/',
		env,
		baseUrl: 'https://kody.test',
		userId: owner.ownerUserId,
		expectedPackageScope: 'acme',
	})
	expect(viaCapability.ok).toBe(viaPublish.ok)
	expect(viaCapability.checks).toEqual(
		viaPublish.results.map((entry) => ({
			kind: entry.kind,
			ok: entry.ok,
			message: entry.message,
		})),
	)
})

test('packageCheck refuses a package scope publish would refuse', async () => {
	resetMocks()
	const files = stampedScopePackageFiles()
	files['package.json'] = files['package.json']!.replace('@acme/', '@other/')
	const result = await check(files)
	expect(result.ok).toBe(false)
	expect(result.checks[0]).toMatchObject({ kind: 'manifest', ok: false })
})

test('packageCheck rejects paths outside the package root', async () => {
	resetMocks()
	await expect(
		check({ ...stampedScopePackageFiles(), '../secrets.txt': 'nope' }),
	).rejects.toThrow(/relative to the package root/)
})
