import { expect, test, vi } from 'vitest'
import type * as AccessControlModule from '#mcp/capabilities/access-control.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'

const mocks = vi.hoisted(() => ({
	runModuleWithRegistry: vi.fn(),
	captureException: vi.fn(),
}))

vi.mock(import('@sentry/cloudflare'), async (importOriginal) => ({
	...(await importOriginal()),
	isInitialized: () => true,
	getClient: (() => ({
		getOptions: () => ({ dsn: 'https://public@sentry.example/1' }),
	})) as never,
	captureException: mocks.captureException,
	withScope: ((callback: (scope: unknown) => void) =>
		callback({
			setLevel() {},
			setUser() {},
			setTag() {},
			setContext() {},
		})) as never,
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	runModuleWithRegistry: mocks.runModuleWithRegistry,
}))

vi.mock(
	'#mcp/capabilities/access-control.ts',
	async (importOriginal: () => Promise<typeof AccessControlModule>) => ({
		...(await importOriginal()),
		resolveCallerFeatureFlags: async () => ({ 'mcp-events-extension': false }),
		callerFeatureFlagEvaluationFailure: async () => null,
	}),
)

const { registerExecuteTool } = await import('./execute.ts')

type AdmitExecuteCall = (input: unknown) => Promise<unknown>

/**
 * UserMeter answers admission; everything else in the env is inert because
 * these callers carry no account email (plan lookup resolves to `max`).
 */
function createEnv(admitExecuteCall: AdmitExecuteCall) {
	const userMeter = createInMemoryUserMeterEnv()
	const namespace = userMeter.env.USER_METER
	const get = namespace.get.bind(namespace)
	const statement = {
		bind: () => statement,
		run: async () => ({ meta: { changes: 1 } }),
		first: async () => null,
		all: async () => ({ results: [] }),
	}
	return {
		...userMeter.env,
		USER_METER: {
			...namespace,
			idFromName: namespace.idFromName.bind(namespace),
			get: (id: Parameters<typeof get>[0]) => ({
				...get(id),
				admitExecuteCall,
			}),
		},
		APP_DB: { prepare: () => statement },
	}
}

async function executeWithAdmission(admitExecuteCall: AdmitExecuteCall) {
	const email = 'execute-admission@example.com'
	const registerTool = vi.fn()
	await registerExecuteTool({
		server: { registerTool } as never,
		getEnv: () => createEnv(admitExecuteCall),
		getCallerContext: () => ({
			baseUrl: 'https://example.com',
			user: { userId: testStableUserIdFromEmail(email), email },
		}),
		requireDomain: vi.fn(),
		getLoopbackExports: vi.fn(),
	} as never)
	const handler = registerTool.mock.calls[0]?.[2] as (input: {
		code: string
		conversationId: string
	}) => Promise<{
		isError?: boolean
		structuredContent: Record<string, unknown>
	}>
	const response = await handler({
		code: 'export default async () => ({ shouldNotRun: true })',
		conversationId: 'conv-execute-admission',
	})
	expect(mocks.runModuleWithRegistry).not.toHaveBeenCalled()
	return response
}

function refuseWith(refusal: Record<string, unknown>): AdmitExecuteCall {
	return async () => ({ admitted: false, ...refusal })
}

test('a loop brake refusal returns the structured admission error and skips Sentry', async () => {
	vi.clearAllMocks()
	const refused = await executeWithAdmission(
		refuseWith({ reason: 'repeat', repeats: 20, retryAfterMs: 4_200 }),
	)
	expect(refused.isError).toBe(true)
	expect(refused.structuredContent).toMatchObject({
		error: expect.stringMatching(
			/^Execute loop detected: this connection ran the same code with the same params 20 times in the last 60s\./,
		),
		admission: { code: 'execute_loop_detected', retryAfterMs: 4_200 },
	})
	expect(mocks.captureException).not.toHaveBeenCalled()
})

test('a runaway rate brake refusal returns the structured admission error and skips Sentry', async () => {
	vi.clearAllMocks()
	const refused = await executeWithAdmission(
		refuseWith({ reason: 'rate', retryAfterMs: 9_000 }),
	)
	expect(refused.isError).toBe(true)
	expect(refused.structuredContent).toMatchObject({
		error: expect.stringMatching(/^Execute rate limit: this account started /),
		admission: { code: 'execute_rate_limited', retryAfterMs: 9_000 },
	})
	expect(mocks.captureException).not.toHaveBeenCalled()
})

test('an unexpected admission failure still reports to Sentry', async () => {
	vi.clearAllMocks()
	const failure = new Error('UserMeter storage exploded')
	const failed = await executeWithAdmission(async () => {
		throw failure
	})
	expect(failed.isError).toBe(true)
	expect(failed.structuredContent.error).toBe(failure.message)
	expect(failed.structuredContent).not.toHaveProperty('admission')
	expect(mocks.captureException).toHaveBeenCalledWith(failure)
})
