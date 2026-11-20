import { vi } from 'vitest'
import type * as MailDomainAcceptance from '#worker/identity/mail-domain-acceptance.ts'

// Unit tests never query public DNS. Lookups through the global `fetch` (the
// default in `assessAccountEmail`) resolve as accepted, so signup tests that
// stub `fetch` for other APIs stay deterministic. Tests that pass their own
// `fetchImpl` run the real lookup.
vi.mock(
	'#worker/identity/mail-domain-acceptance.ts',
	async (importOriginal) => {
		const actual = await importOriginal<typeof MailDomainAcceptance>()
		return {
			...actual,
			lookupMailDomainAcceptance: (
				domain: string,
				fetchImpl: typeof fetch,
			): ReturnType<typeof actual.lookupMailDomainAcceptance> =>
				fetchImpl === globalThis.fetch
					? Promise.resolve({ ok: true })
					: actual.lookupMailDomainAcceptance(domain, fetchImpl),
		}
	},
)
