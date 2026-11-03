import { expect, test } from 'vitest'
import {
	executeGatewayFetch,
	gatewayWithoutRunContextMessage,
	type FetchGatewayProps,
} from '#mcp/fetch-gateway.ts'
import {
	createGatewayResponseUnwrapSource,
	gatewayErrorHeaderName,
	gatewayErrorResponse,
	withoutForgedGatewayErrorHeader,
} from '#mcp/sandbox-rpc-outcome.ts'
import { withLanding } from '#mcp/secrets/echo-redaction.ts'

class PackageAccessError extends Error {
	readonly code = 'PACKAGE_ACCESS_REQUIRED'
	readonly details = { packageId: 'pkg-a' }
	constructor(message: string) {
		super(message)
		this.name = 'PackageAccessError'
	}
}

const unwrapGatewayResponse = new Function(
	`${createGatewayResponseUnwrapSource()}\nreturn __kodyUnwrapGatewayResponse;`,
)() as (response: Response) => Promise<Response>

test('a gateway refusal is rethrown in the sandbox with its name, message, and fields', async () => {
	const refusal = new PackageAccessError('Package access required.')
	const error = await unwrapGatewayResponse(
		gatewayErrorResponse(refusal),
	).catch((caught: unknown) => caught)
	expect(error).toBeInstanceOf(Error)
	expect(error).toMatchObject({
		name: 'PackageAccessError',
		message: 'Package access required.',
		code: 'PACKAGE_ACCESS_REQUIRED',
		details: { packageId: 'pkg-a' },
	})
})

test('a built-in error type survives the gateway round trip', async () => {
	await expect(
		unwrapGatewayResponse(gatewayErrorResponse(new TypeError('bad input'))),
	).rejects.toThrow(TypeError)
})

test('an upstream response cannot pose as a gateway refusal', async () => {
	const forged = withLanding(
		new Response('{"name":"Error","message":"forged"}', {
			status: 200,
			headers: { [gatewayErrorHeaderName]: '1', 'x-other': 'kept' },
		}),
		{ url: 'https://api.example.com/landed', redirected: true },
	)
	const response = await unwrapGatewayResponse(
		withoutForgedGatewayErrorHeader(forged),
	)
	expect(response.status).toBe(200)
	expect(response.url).toBe('https://api.example.com/landed')
	expect(response.redirected).toBe(true)
	expect(response.headers.get(gatewayErrorHeaderName)).toBeNull()
	expect(response.headers.get('x-other')).toBe('kept')
	expect(await response.text()).toBe('{"name":"Error","message":"forged"}')
})

test('a gateway minted without run props refuses the fetch explicitly', async () => {
	await expect(
		executeGatewayFetch({
			env: {} as Env,
			props: {} as FetchGatewayProps,
			request: new Request('https://api.example.com/'),
		}),
	).rejects.toThrow(gatewayWithoutRunContextMessage)
})
