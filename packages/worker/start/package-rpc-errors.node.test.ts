import { expect, test } from 'vitest'
import { runWithStartContext } from '@tanstack/start-storage-context'
import { createClientRpc } from '@tanstack/start-client-core/client-rpc'
import { toCrossJSONAsync } from 'seroval'

test('Start preserves structured package recovery data on non-success RPC status', async () => {
	const result = {
		ok: false,
		error: 'Review this capability set first.',
		approvalUrl: '/@team/repo/approve-capabilities',
	}
	const rpc = createClientRpc('package-review-contract')
	const response = await runWithStartContext(
		{
			request: new Request('https://kody.test/'),
			getRouter: () => {
				throw new Error('RPC decoding must not load a router')
			},
			startOptions: {},
			contextAfterGlobalMiddlewares: {},
			executedRequestMiddlewares: new Set(),
			handlerType: 'serverFn',
		},
		() =>
			rpc({
				method: 'POST',
				data: { packageId: 'package' },
				fetch: async () =>
					new Response(JSON.stringify(await toCrossJSONAsync({ result })), {
						status: 409,
						headers: {
							'content-type': 'application/json',
							'x-tss-serialized': 'true',
						},
					}),
			}),
	)
	expect(response).toEqual({ result })
})
