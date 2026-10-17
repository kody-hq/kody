import type * as authenticatedUserModule from '#app/authenticated-user.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'
import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'

const listedWorkflow = {
	id: 'dynwf-1',
	userId: ownerIdFromStored('stable-user-1'),
	bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS' as const,
	sourceType: 'inline' as const,
	packageId: null,
	kodyId: null,
	sourceId: null,
	workflowName: 'Deferred digest',
	exportName: null,
	idempotencyKey: 'idem-1',
	runAt: '2026-07-28T12:00:00.000Z',
	planDate: '2026-07-28',
	status: 'queued' as const,
	createdAt: '2026-07-27T12:00:00.000Z',
	updatedAt: '2026-07-27T12:00:00.000Z',
	completedAt: null,
	lastError: null,
}

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn<
		typeof authenticatedUserModule.readAuthenticatedAppUser
	>(async () => ({
		sessionUserId: '42',
		userId: 42,
		username: 'test-user',
		email: 'user@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		displayName: 'user',
		roles: ['user'],
		permissions: [],
		artifactOwnerIds: [],
		mcpUser: {
			userId: personIdFromStored('stable-user-1'),
			email: 'user@example.com',
			username: 'test-user',
			displayName: 'user',
		},
		request: sessionRequestContext('stable-user-1'),
	})),
	listWorkflowRunsForUser: vi.fn(),
	cancelWorkflowRunForUser: vi.fn(),
	getWorkflowProjection: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof authenticatedUserModule.readAuthenticatedAppUser>
	) => mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/package-runtime/package-workflows.ts', () => ({
	listWorkflowRunsForUser: (...args: Array<unknown>) =>
		mockModule.listWorkflowRunsForUser(...args),
	cancelWorkflowRunForUser: (...args: Array<unknown>) =>
		mockModule.cancelWorkflowRunForUser(...args),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	getWorkflowProjection: (...args: Array<unknown>) =>
		mockModule.getWorkflowProjection(...args),
}))

const { testAccountWorkflowsApiHandler } =
	await import('#app/handlers/account-workflows.test-support.ts')

function createEnv() {
	return {} as Env
}

function resetList(workflows = [listedWorkflow]) {
	mockModule.listWorkflowRunsForUser.mockReset()
	mockModule.listWorkflowRunsForUser.mockResolvedValue(workflows)
	mockModule.getWorkflowProjection.mockReset()
	mockModule.getWorkflowProjection.mockResolvedValue(null)
	mockModule.cancelWorkflowRunForUser.mockReset()
}

test('workflows API lists, cancels, and rejects unauthenticated or invalid requests', async () => {
	resetList()
	const handler = testAccountWorkflowsApiHandler(createEnv())

	const listResponse = await handler.execute({
		request: new Request('https://example.com/account/workflows.json'),
	})
	expect(listResponse.status).toBe(200)
	expect(listResponse.data).toMatchObject({
		ok: true,
		selectedWorkflowId: null,
		selectedWorkflow: null,
		workflows: [
			expect.objectContaining({
				id: 'dynwf-1',
				sourceType: 'inline',
				workflowName: 'Deferred digest',
				status: 'queued',
			}),
		],
	})

	resetList()
	const detailResponse = await handler.execute({
		request: new Request(
			'https://example.com/account/workflows.json?selected=dynwf-1',
		),
	})
	expect(detailResponse.status).toBe(200)
	expect(detailResponse.data).toMatchObject({
		ok: true,
		selectedWorkflowId: 'dynwf-1',
		selectedWorkflow: expect.objectContaining({
			id: 'dynwf-1',
			status: 'queued',
		}),
	})

	resetList()
	mockModule.cancelWorkflowRunForUser.mockResolvedValueOnce({
		outcome: 'cancelled',
		run: { ...listedWorkflow, status: 'cancelled' },
	})
	mockModule.listWorkflowRunsForUser.mockClear()
	mockModule.listWorkflowRunsForUser.mockRejectedValue(
		new Error('Page unavailable'),
	)
	const cancelResponse = await handler.execute({
		request: new Request('https://example.com/account/workflows.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'cancel', id: 'dynwf-1' }),
		}),
	})
	expect(cancelResponse.status).toBe(200)
	expect(mockModule.listWorkflowRunsForUser).not.toHaveBeenCalled()
	expect(cancelResponse.data).not.toHaveProperty('workflows')
	expect(mockModule.cancelWorkflowRunForUser).toHaveBeenCalledWith({
		env: expect.anything(),
		userId: ownerIdFromStored('stable-user-1'),
		workflowRunId: 'dynwf-1',
	})
	expect(cancelResponse.data).toMatchObject({
		ok: true,
		cancel: {
			cancelled: true,
			alreadyTerminal: false,
			status: 'cancelled',
		},
	})

	resetList()

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null)
	const unauthorized = await handler.execute({
		request: new Request('https://example.com/account/workflows.json'),
	})
	expect(unauthorized.status).toBe(401)

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce({
		sessionUserId: '42',
		userId: 42,
		username: 'test-user',
		email: 'user@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		displayName: 'user',
		roles: ['user'],
		permissions: [],
		artifactOwnerIds: [],
		mcpUser: {
			userId: personIdFromStored('stable-user-1'),
			email: 'user@example.com',
			username: 'test-user',
			displayName: 'user',
		},
		request: sessionRequestContext('stable-user-1'),
	})
	const methodNotAllowed = await handler.execute({
		request: new Request('https://example.com/account/workflows.json', {
			method: 'PUT',
		}),
	})
	expect(methodNotAllowed.status).toBe(405)

	const invalidAction = await handler.execute({
		request: new Request('https://example.com/account/workflows.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'nope' }),
		}),
	})
	expect(invalidAction.status).toBe(400)
	expect(invalidAction.data).toEqual({
		ok: false,
		error: 'Invalid action.',
	})
})
