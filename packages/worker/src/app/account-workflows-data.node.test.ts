import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import {
	isActiveWorkflowStatus,
	isTerminalWorkflowStatus,
	loadAccountWorkflowsData,
	readAccountWorkflowsSelectedWorkflowId,
} from '#app/account-workflows-data.ts'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import { type WorkflowRunInspection } from '#worker/package-runtime/package-workflows.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'

const mockModule = vi.hoisted(() => ({
	listWorkflowRunsForUser: vi.fn(),
	getWorkflowProjection: vi.fn(),
}))

vi.mock('#worker/package-runtime/package-workflows.ts', () => ({
	listWorkflowRunsForUser: mockModule.listWorkflowRunsForUser,
}))
vi.mock('#worker/run-records/service.ts', () => ({
	getWorkflowProjection: mockModule.getWorkflowProjection,
}))

const user: AuthenticatedAppUser = {
	sessionUserId: '42',
	userId: 42,
	username: 'test-user',
	email: 'user@example.com',
	emailVerified: true,
	emailVerificationDelivery: null,
	displayName: 'user',
	roles: [],
	permissions: [],
	artifactOwnerIds: [],
	mcpUser: {
		userId: personIdFromStored('stable-user-1'),
		email: 'user@example.com',
		username: 'test-user',
		displayName: 'user',
	},
	request: sessionRequestContext('stable-user-1'),
}

function makeWorkflow(
	overrides: Partial<WorkflowRunInspection> = {},
): WorkflowRunInspection {
	return {
		id: 'dynwf-1',
		userId: ownerIdFromStored('stable-user-1'),
		bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
		sourceType: 'inline',
		packageId: null,
		kodyId: null,
		sourceId: null,
		workflowName: 'Deferred digest',
		exportName: null,
		idempotencyKey: 'idem-1',
		runAt: '2026-07-28T12:00:00.000Z',
		planDate: '2026-07-28',
		status: 'queued',
		createdAt: '2026-07-27T12:00:00.000Z',
		updatedAt: '2026-07-27T12:00:00.000Z',
		completedAt: null,
		lastError: null,
		...overrides,
	}
}

test('loadAccountWorkflowsData lists runs, resolves selection, and falls back to projection', async () => {
	expect(isActiveWorkflowStatus('queued')).toBe(true)
	expect(isActiveWorkflowStatus('complete')).toBe(false)
	expect(isTerminalWorkflowStatus('cancelled')).toBe(true)
	expect(
		readAccountWorkflowsSelectedWorkflowId(
			'https://example.com/account/workflows/dynwf-path?selected=dynwf-query',
			'dynwf-param',
		),
	).toBe('dynwf-param')
	expect(
		readAccountWorkflowsSelectedWorkflowId(
			'https://example.com/account/workflows?selected=dynwf-query',
		),
	).toBe('dynwf-query')

	const listed = [
		makeWorkflow({ id: 'dynwf-1', status: 'queued' }),
		makeWorkflow({
			id: 'pkgwf-1',
			sourceType: 'package',
			packageId: 'pkg-1',
			kodyId: 'kody-1',
			sourceId: 'source-1',
			workflowName: 'Package sync',
			exportName: 'nightly',
			status: 'complete',
			completedAt: '2026-07-28T12:05:00.000Z',
		}),
	]
	mockModule.listWorkflowRunsForUser.mockResolvedValueOnce(listed)

	const payload = await loadAccountWorkflowsData({
		env: {} as Env,
		selectedWorkflowId: 'dynwf-1',
		user,
	})

	expect(mockModule.listWorkflowRunsForUser).toHaveBeenCalledWith({
		env: expect.anything(),
		userId: ownerIdFromStored('stable-user-1'),
		limit: 100,
	})
	expect(mockModule.getWorkflowProjection).not.toHaveBeenCalled()
	expect(payload).toMatchObject({
		ok: true,
		username: 'test-user',
		selectedWorkflowId: 'dynwf-1',
		selectedWorkflow: expect.objectContaining({
			id: 'dynwf-1',
			sourceType: 'inline',
			workflowName: 'Deferred digest',
			status: 'queued',
		}),
		workflows: [
			expect.objectContaining({ id: 'dynwf-1', status: 'queued' }),
			expect.objectContaining({
				id: 'pkgwf-1',
				sourceType: 'package',
				packageId: 'pkg-1',
				status: 'complete',
			}),
		],
	})

	mockModule.listWorkflowRunsForUser.mockResolvedValueOnce([])
	const { userId: _userId, ...projection } = makeWorkflow({
		id: 'dynwf-old',
		workflowName: 'Stale run',
		idempotencyKey: 'idem-old',
		runAt: '2026-07-20T12:00:00.000Z',
		planDate: null,
		status: 'errored',
		createdAt: '2026-07-20T11:00:00.000Z',
		updatedAt: '2026-07-20T12:01:00.000Z',
		completedAt: '2026-07-20T12:01:00.000Z',
		lastError: 'boom',
	})
	mockModule.getWorkflowProjection.mockResolvedValueOnce(projection)

	const projectionPayload = await loadAccountWorkflowsData({
		env: {} as Env,
		selectedWorkflowId: 'dynwf-old',
		user,
	})

	expect(mockModule.getWorkflowProjection).toHaveBeenCalledWith({
		env: expect.anything(),
		userId: ownerIdFromStored('stable-user-1'),
		id: 'dynwf-old',
	})
	expect(projectionPayload.selectedWorkflow).toMatchObject({
		id: 'dynwf-old',
		workflowName: 'Stale run',
		status: 'errored',
		lastError: 'boom',
	})
})
