import type { SystemEmailLocal } from './system-email.ts'

type SystemInboundForwardEnv = Partial<Pick<Env, 'FOUNDER_EMAIL_FORWARD_TO'>>

/** System locals whose inbound mail is also forwarded, and the env var naming the destination. */
const systemInboundForwardEnvByLocal = {
	kent: 'FOUNDER_EMAIL_FORWARD_TO',
} as const satisfies Partial<
	Record<SystemEmailLocal, keyof SystemInboundForwardEnv>
>

export type SystemInboundForwardResult =
	| { status: 'not_forwarded' }
	| { status: 'unconfigured' }
	| { status: 'forwarded' }
	| { status: 'failed'; error: string }

/**
 * Forwards an already stored system message (for example `kent@`) to its
 * configured destination with `message.forward`. Never throws: the stored
 * system-inbox copy is the record, so a missing destination or a forward
 * failure is logged and the message stays in the inbox. Cloudflare only
 * forwards to verified Email Routing destination addresses.
 */
export async function forwardStoredSystemInboundEmail(input: {
	message: Pick<ForwardableEmailMessage, 'forward'>
	env: SystemInboundForwardEnv
	localPart: SystemEmailLocal
	deliveryId: string
}): Promise<SystemInboundForwardResult> {
	if (!Object.hasOwn(systemInboundForwardEnvByLocal, input.localPart)) {
		return { status: 'not_forwarded' }
	}
	const envKey =
		systemInboundForwardEnvByLocal[
			input.localPart as keyof typeof systemInboundForwardEnvByLocal
		]
	const destination = input.env[envKey]?.trim()
	const logContext = {
		localPart: input.localPart,
		deliveryId: input.deliveryId,
	}
	if (!destination) {
		console.error('system-inbound-forward-unconfigured', {
			...logContext,
			envKey,
		})
		return { status: 'unconfigured' }
	}
	try {
		await input.message.forward(destination)
		console.info('system-inbound-forwarded', logContext)
		return { status: 'forwarded' }
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		console.error('system-inbound-forward-failed', {
			...logContext,
			error: message,
		})
		return { status: 'failed', error: message }
	}
}
