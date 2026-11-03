import { runInDurableObject } from 'cloudflare:test'

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown }

/**
 * Wraps `env.USER_METER` so each RPC runs inside the real UserMeter object via
 * `runInDurableObject`. An expected denial (for example `BudgetLimitError`)
 * then rejects in the test isolate instead of across the RPC stub, where
 * workerd logs it as an uncaught exception even though the caller catches it.
 */
export function inObjectUserMeterNamespace(
	namespace: DurableObjectNamespace,
): DurableObjectNamespace {
	return new Proxy(namespace, {
		get(target, property) {
			if (property === 'get') {
				return (id: DurableObjectId) => inObjectStub(target.get(id))
			}
			const value = Reflect.get(target, property, target) as unknown
			return typeof value === 'function' ? value.bind(target) : value
		},
	})
}

function inObjectStub(stub: DurableObjectStub) {
	return new Proxy(
		{},
		{
			get(_target, method) {
				if (typeof method !== 'string' || method === 'then') return undefined
				return async (...args: Array<unknown>) => {
					const outcome = await runInDurableObject(
						stub,
						async (instance: DurableObject): Promise<Outcome> => {
							try {
								const fn = (instance as unknown as Record<string, unknown>)[
									method
								] as (...input: Array<unknown>) => unknown
								return { ok: true, value: await fn.apply(instance, args) }
							} catch (error) {
								return { ok: false, error }
							}
						},
					)
					if (!outcome.ok) throw outcome.error
					return outcome.value
				}
			},
		},
	)
}
