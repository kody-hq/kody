import { expect, test, vi } from 'vitest'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { forwardStoredSystemInboundEmail } from './system-inbound-forward.ts'

function message(forward: ForwardableEmailMessage['forward']) {
	return { forward: vi.fn(forward) }
}

test('kent@ mail forwards to FOUNDER_EMAIL_FORWARD_TO', async () => {
	const inbound = message(async () => ({ messageId: 'fwd-1' }))
	expect(
		await forwardStoredSystemInboundEmail({
			message: inbound,
			env: { FOUNDER_EMAIL_FORWARD_TO: ' founder@example.com ' },
			localPart: 'kent',
			deliveryId: 'delivery-1',
		}),
	).toEqual({ status: 'forwarded' })
	expect(inbound.forward).toHaveBeenCalledWith('founder@example.com')
})

test('other system locals are never forwarded', async () => {
	const inbound = message(async () => ({ messageId: 'fwd-1' }))
	expect(
		await forwardStoredSystemInboundEmail({
			message: inbound,
			env: { FOUNDER_EMAIL_FORWARD_TO: 'founder@example.com' },
			localPart: 'support',
			deliveryId: 'delivery-1',
		}),
	).toEqual({ status: 'not_forwarded' })
	expect(inbound.forward).not.toHaveBeenCalled()
})

test('an unconfigured or failing forward logs and never throws, so the stored inbox copy stands', async () => {
	consoleError.mockImplementation(() => {})
	const unconfigured = message(async () => ({ messageId: 'fwd-1' }))
	expect(
		await forwardStoredSystemInboundEmail({
			message: unconfigured,
			env: {},
			localPart: 'kent',
			deliveryId: 'delivery-1',
		}),
	).toEqual({ status: 'unconfigured' })
	expect(unconfigured.forward).not.toHaveBeenCalled()
	expect(consoleError).toHaveBeenCalledWith(
		'system-inbound-forward-unconfigured',
		{
			localPart: 'kent',
			deliveryId: 'delivery-1',
			envKey: 'FOUNDER_EMAIL_FORWARD_TO',
		},
	)

	const failing = message(async () => {
		throw new Error('destination address not verified')
	})
	expect(
		await forwardStoredSystemInboundEmail({
			message: failing,
			env: { FOUNDER_EMAIL_FORWARD_TO: 'founder@example.com' },
			localPart: 'kent',
			deliveryId: 'delivery-2',
		}),
	).toEqual({ status: 'failed', error: 'destination address not verified' })
	expect(consoleError).toHaveBeenCalledWith('system-inbound-forward-failed', {
		localPart: 'kent',
		deliveryId: 'delivery-2',
		error: 'destination address not verified',
	})
})
