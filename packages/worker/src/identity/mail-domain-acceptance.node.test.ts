import { expect, test } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { lookupMailDomainAcceptance } from './mail-domain-acceptance.ts'

function jsonFetch(payload: unknown, status = 200): typeof fetch {
	return (async () => Response.json(payload, { status })) as typeof fetch
}

test('a usable MX accepts and a null MX rejects without an A fallback', async () => {
	const mx = await lookupMailDomainAcceptance(
		'gmail.com',
		jsonFetch({
			Status: 0,
			Answer: [{ type: 15, data: '10 alt1.gmail-smtp-in.l.google.com.' }],
		}),
	)
	expect(mx).toEqual({ ok: true })

	const nullMx = await lookupMailDomainAcceptance(
		'nowhere.test',
		jsonFetch({ Status: 0, Answer: [{ type: 15, data: '0 .' }] }),
	)
	expect(nullMx).toMatchObject({ ok: false, code: 'email_domain_null_mx' })
})

test('NXDOMAIN rejects and empty MX falls back to A then AAAA', async () => {
	const missing = await lookupMailDomainAcceptance(
		'missing.test',
		jsonFetch({ Status: 3 }),
	)
	expect(missing).toMatchObject({ ok: false, code: 'email_domain_nxdomain' })

	const calls: Array<string> = []
	const fetchImpl = (async (input: RequestInfo | URL) => {
		const type = new URL(String(input)).searchParams.get('type')
		calls.push(type ?? '')
		if (type === 'MX') return Response.json({ Status: 0, Answer: [] })
		if (type === 'A') return Response.json({ Status: 0, Answer: [] })
		return Response.json({
			Status: 0,
			Answer: [{ type: 28, data: '2001:db8::1' }],
		})
	}) as typeof fetch
	const ipv6 = await lookupMailDomainAcceptance('v6.test', fetchImpl)
	expect(ipv6).toEqual({ ok: true })
	expect(calls).toEqual(['MX', 'A', 'AAAA'])

	const neither = await lookupMailDomainAcceptance('nomail.test', (async (
		input: RequestInfo | URL,
	) => {
		const type = new URL(String(input)).searchParams.get('type')
		if (type === 'MX' || type === 'A' || type === 'AAAA') {
			return Response.json({ Status: 0 })
		}
		throw new Error(`unexpected ${type}`)
	}) as typeof fetch)
	expect(neither).toMatchObject({ ok: false, code: 'email_domain_no_mx' })
})

test('DNS errors and timeouts fail open', async () => {
	consoleWarn.mockImplementation(() => {})
	const http = await lookupMailDomainAcceptance(
		'gmail.com',
		jsonFetch({ Status: 2 }, 500),
	)
	expect(http).toEqual({ ok: true, failOpen: true })
	expect(consoleWarn).toHaveBeenCalledWith(
		'account-email-doh-http-failed',
		expect.objectContaining({ domain: 'gmail.com', type: 'MX', status: 500 }),
	)

	consoleWarn.mockClear()
	const servfail = await lookupMailDomainAcceptance(
		'gmail.com',
		jsonFetch({ Status: 2 }),
	)
	expect(servfail).toEqual({ ok: true, failOpen: true })
	expect(consoleWarn).toHaveBeenCalledWith(
		'account-email-doh-status-failed',
		expect.objectContaining({ domain: 'gmail.com', type: 'MX', status: 2 }),
	)

	consoleWarn.mockClear()
	const timeout = await lookupMailDomainAcceptance('gmail.com', (async () => {
		throw new DOMException('The operation was aborted', 'TimeoutError')
	}) as typeof fetch)
	expect(timeout).toEqual({ ok: true, failOpen: true })
	expect(consoleWarn).toHaveBeenCalledWith(
		'account-email-doh-failed',
		expect.objectContaining({ domain: 'gmail.com', type: 'MX' }),
	)
})
