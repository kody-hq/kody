import { beforeEach, expect, test, vi } from 'vitest'
import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import {
	describeWebhookDeliveryFailure,
	recordWebhookDelivery,
} from './delivery.ts'

const mocks = vi.hoisted(() => ({
	recordRunRecord: vi.fn(),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	recordRunRecord: (...args: Array<unknown>) => mocks.recordRunRecord(...args),
}))

beforeEach(() => {
	mocks.recordRunRecord.mockReset()
	mocks.recordRunRecord.mockResolvedValue({ id: 'run-1' })
})

const endpoint = {
	id: 'endpoint-1',
	userId: ownerIdFromStored('user-1'),
	packageId: 'package-1',
	webhookName: 'github',
}

const typecheckFailure =
	"src/index.ts Argument of type '(params: { name: string; }) => Promise<string>' is not assignable to parameter of type '(params?: Record<string, unknown>) => unknown'."

test('a failed webhook run carries the export error message, not only the HTTP status', async () => {
	await recordWebhookDelivery({
		env: {} as Env,
		endpoint,
		kodyId: 'example-package',
		outcome: 'failed',
		httpStatus: 502,
		error: 'invocation_status_500',
		payloadBytes: 10,
		invocationId: 'delivery-1',
		startedAt: '2026-10-23T19:03:00.000Z',
		invocationErrorCode: 'invocation_failed',
		invocationBody: {
			ok: false,
			error: { code: 'invocation_failed', message: typecheckFailure },
		},
		logs: [
			{
				level: 'error',
				message: 'Webhook export invocation failed with HTTP 500.',
			},
		],
	})
	expect(mocks.recordRunRecord).toHaveBeenCalledWith(
		expect.objectContaining({
			status: 'error',
			error: {
				name: 'invocation_status_500',
				message: `invocation_status_500: ${typecheckFailure}`,
			},
			logs: [
				{
					level: 'error',
					message: 'Webhook export invocation failed with HTTP 500.',
				},
				{
					level: 'error',
					message: `Export error: ${typecheckFailure}`,
					fields: { code: 'invocation_failed' },
				},
			],
		}),
	)
})

test('the copied export error is sanitized', () => {
	const leaked = `ghp_${'x9'.repeat(18)}`
	const failure = describeWebhookDeliveryFailure({
		error: 'invocation_status_500',
		invocationBody: {
			error: {
				code: 'invocation_failed',
				message: `GitHub rejected Authorization: Bearer ${leaked}`,
			},
		},
	})
	expect(failure?.error.name).toBe('invocation_status_500')
	expect(failure?.error.message).toBe(
		'invocation_status_500: GitHub rejected Authorization: Bearer [redacted]',
	)
	expect(JSON.stringify(failure)).not.toContain(leaked)
})

test('successful deliveries and failures without an export message keep the old shape', async () => {
	expect(
		describeWebhookDeliveryFailure({
			error: 'invocation_status_502',
			invocationBody: { ok: false },
		}),
	).toBeNull()
	await recordWebhookDelivery({
		env: {} as Env,
		endpoint,
		kodyId: 'example-package',
		outcome: 'delivered',
		httpStatus: 202,
		payloadBytes: 10,
		startedAt: '2026-10-23T19:03:00.000Z',
		invocationBody: { ok: true, result: { ok: true } },
	})
	expect(mocks.recordRunRecord).toHaveBeenLastCalledWith(
		expect.objectContaining({ status: 'success', error: undefined }),
	)
	await recordWebhookDelivery({
		env: {} as Env,
		endpoint,
		kodyId: 'example-package',
		outcome: 'failed',
		httpStatus: 502,
		error: 'invocation_status_502',
		payloadBytes: 10,
		startedAt: '2026-10-23T19:03:00.000Z',
	})
	expect(mocks.recordRunRecord).toHaveBeenLastCalledWith(
		expect.objectContaining({
			status: 'error',
			error: 'invocation_status_502',
		}),
	)
})
