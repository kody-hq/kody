import { expect, test, vi } from 'vitest'
import { withApprovalTimeout } from './approval-request.ts'
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
