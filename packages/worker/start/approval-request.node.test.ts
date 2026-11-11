import { expect, test, vi } from 'vitest'
import type { AccountPackageApproveCapabilitiesLoaderData } from '#universal/loader-data.ts'
import {
	approvalStillRunningMessage,
	capabilityApprovalLanded,
	isApprovalTimeout,
	pendingApprovalLanded,
	withApprovalTimeout,
} from './approval-request.ts'
test('native approval forwards its scoped input and a bounded request signal', async () => {
	const signal = new AbortController().signal
	const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal)
	try {
		const send = vi.fn(
			async (input: {
				data: { packageId: string; requestId: string }
				signal?: AbortSignal
			}) => ({ ok: true as const, packageId: input.data.packageId }),
		)
		const data = { packageId: 'package-a', requestId: 'needs-a' }
		expect(await withApprovalTimeout(send)({ data })).toEqual({
			ok: true,
			packageId: 'package-a',
		})
		expect(send).toHaveBeenCalledWith({ data, signal })
		expect(timeout).toHaveBeenCalledWith(120_000)
	} finally {
		timeout.mockRestore()
	}
})
test('a request timeout rejects so the approval page can clear its busy state', async () => {
	const controller = new AbortController()
	const timeout = vi
		.spyOn(AbortSignal, 'timeout')
		.mockReturnValue(controller.signal)
	try {
		const request = withApprovalTimeout(
			(_input: { data: { packageId: string }; signal?: AbortSignal }) =>
				new Promise<never>((_resolve, reject) => {
					_input.signal!.addEventListener(
						'abort',
						() => reject(_input.signal!.reason),
						{ once: true },
					)
				}),
		)({ data: { packageId: 'package-a' } })
		queueMicrotask(() =>
			controller.abort(new DOMException('Approval timed out', 'TimeoutError')),
		)
		await expect(request).rejects.toMatchObject({
			name: 'TimeoutError',
			message: 'Approval timed out',
		})
	} finally {
		timeout.mockRestore()
	}
})

function reread(
	overrides: Partial<AccountPackageApproveCapabilitiesLoaderData> = {},
	isInternetVisible = false,
) {
	return {
		pendingApprovals: [],
		fingerprint: 'fp-1',
		fingerprintMatchesApproval: false,
		...overrides,
		package: { isInternetVisible },
	} as unknown as AccountPackageApproveCapabilitiesLoaderData
}
test('a timeout re-read tells a landed approval apart from one still running', () => {
	expect(
		isApprovalTimeout(new DOMException('Approval timed out', 'TimeoutError')),
	).toBe(true)
	expect(isApprovalTimeout(new Error('Publish checks failed'))).toBe(false)
	expect(approvalStillRunningMessage).not.toMatch(/try again|\u2014/)

	const stillPending = reread({
		pendingApprovals: [
			{
				id: 'needs-a',
			} as AccountPackageApproveCapabilitiesLoaderData['pendingApprovals'][number],
		],
	})
	expect(pendingApprovalLanded(stillPending, 'needs-a')).toBe(false)
	expect(pendingApprovalLanded(reread(), 'needs-a')).toBe(true)

	const input = { fingerprint: 'fp-1', goPublicRequestId: null }
	expect(capabilityApprovalLanded(reread(), input)).toBe(false)
	expect(
		capabilityApprovalLanded(
			reread({ fingerprintMatchesApproval: true }),
			input,
		),
	).toBe(true)
	expect(
		capabilityApprovalLanded(
			reread({ fingerprintMatchesApproval: true, fingerprint: 'fp-2' }),
			input,
		),
	).toBe(false)
	const goPublic = { fingerprint: 'fp-1', goPublicRequestId: 'went-a' }
	expect(
		capabilityApprovalLanded(
			reread({ fingerprintMatchesApproval: true }),
			goPublic,
		),
	).toBe(false)
	expect(
		capabilityApprovalLanded(
			reread({ fingerprintMatchesApproval: true }, true),
			goPublic,
		),
	).toBe(true)
})
