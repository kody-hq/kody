import { orgPermissions } from '@kody-internal/shared/org-permissions.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { packageRunResultKey } from '#worker/repo/package-check-upload.ts'

const mockModule = vi.hoisted(() => ({
	compileAccessForRequest: vi.fn(),
	resolvePackageOwnerContext: vi.fn(),
	getWorkflowRunForUser: vi.fn(),
	listWorkflowRunPageForUser: vi.fn(),
}))

vi.mock('#worker/authorization/access-compile.ts', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('#worker/authorization/access-compile.ts')
	>()),
	compileAccessForRequest: (...args: Array<unknown>) =>
		mockModule.compileAccessForRequest(...args),
}))

vi.mock('#worker/package-registry/package-owner.ts', () => ({
	resolvePackageOwnerContext: (...args: Array<unknown>) =>
		mockModule.resolvePackageOwnerContext(...args),
}))

vi.mock('#worker/package-runtime/package-workflows.ts', () => ({
	getWorkflowRunForUser: (...args: Array<unknown>) =>
		mockModule.getWorkflowRunForUser(...args),
	listWorkflowRunPageForUser: (...args: Array<unknown>) =>
		mockModule.listWorkflowRunPageForUser(...args),
}))

const { packageRunResultCapability } = await import('./package-run-result.ts')
const { workflowListCapability } =
	await import('#mcp/capabilities/jobs/workflow-list.ts')

const ownerUserId = ownerIdFromStored('user-1')
const workflowId = 'dynwf-check-1'
const progress = {
	phase: 'artifact_build',
	message: 'Built 2 of 3 artifact chunks.',
	done: 2,
	total: 3,
}

/** An API token of an Owner, narrowed to package scopes: no `job:read`. */
function packageScopedToken() {
	return createMcpCallerContext({
		source: { kind: 'api-token', tokenId: 'token-1' },
		scopes: ['package:read', 'package:write', 'package:publish'],
		baseUrl: 'https://kody.test',
		user: {
			userId: personIdFromStored('user-1'),
			email: 'user-1@example.com',
			displayName: 'user-1',
		},
	})
}

function setup(input: {
	run: Record<string, unknown> | null
	stored?: Record<string, unknown>
}) {
	for (const mock of Object.values(mockModule)) mock.mockReset()
	mockModule.compileAccessForRequest.mockResolvedValue({
		orgId: ownerUserId,
		epoch: 0,
		isOwner: true,
		orgPermissions: new Set(orgPermissions),
		resourcePermissions: new Map(),
	})
	mockModule.resolvePackageOwnerContext.mockResolvedValue({ ownerUserId })
	mockModule.getWorkflowRunForUser.mockResolvedValue(input.run)
	const get = vi.fn(async (key: string) =>
		input.stored && key === packageRunResultKey(ownerUserId, workflowId)
			? { json: async () => input.stored }
			: null,
	)
	return { APP_DB: {}, REPO_SESSION_BLOBS: { get } } as unknown as Env
}

test('a token with package scopes only follows a run with packageRunResult, which workflowRunList refuses it', async () => {
	const env = setup({
		run: {
			id: workflowId,
			workflowName: 'packageCheck',
			status: 'running',
			progress,
			lastError: null,
		},
	})
	const ctx = { env, callerContext: packageScopedToken() }

	await expect(
		workflowListCapability.handler({ workflow_id: workflowId }, ctx),
	).rejects.toBeInstanceOf(AuthorizationError)
	expect(mockModule.listWorkflowRunPageForUser).not.toHaveBeenCalled()

	await expect(
		packageRunResultCapability.handler({ workflow_id: workflowId }, ctx),
	).resolves.toEqual({
		available: false,
		kind: null,
		result: null,
		status: 'running',
		progress,
		last_error: null,
	})
	expect(mockModule.getWorkflowRunForUser).toHaveBeenCalledWith(
		expect.objectContaining({ userId: ownerUserId, id: workflowId }),
	)
})

test('a finished run answers with its status and stored result together', async () => {
	const env = setup({
		run: {
			id: workflowId,
			workflowName: 'packagePublishExternalPush',
			status: 'errored',
			progress: null,
			lastError: 'packagePublishExternalPush returned checks_failed',
		},
		stored: {
			kind: 'packagePublishExternalPush',
			result: { status: 'checks_failed' },
		},
	})
	await expect(
		packageRunResultCapability.handler(
			{ workflow_id: workflowId },
			{ env, callerContext: packageScopedToken() },
		),
	).resolves.toEqual({
		available: true,
		kind: 'packagePublishExternalPush',
		result: { status: 'checks_failed' },
		status: 'errored',
		progress: null,
		last_error: 'packagePublishExternalPush returned checks_failed',
	})
})

test('package:read does not reveal a workflow run that is not a check or publish', async () => {
	const env = setup({
		run: {
			id: workflowId,
			workflowName: 'nightly-sync',
			status: 'errored',
			progress: null,
			lastError: 'Upstream token expired.',
		},
	})
	await expect(
		packageRunResultCapability.handler(
			{ workflow_id: workflowId },
			{ env, callerContext: packageScopedToken() },
		),
	).resolves.toEqual({
		available: false,
		kind: null,
		result: null,
		status: null,
		progress: null,
		last_error: null,
	})
})
