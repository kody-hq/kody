/**
 * Sandboxed code (execute, package apps) reaches the host through RPC
 * entrypoints (`PackageAppRuntimeBridge`, `KodyFetchGateway`). workerd logs
 * every rejection that crosses an RPC boundary as an uncaught exception,
 * even when the caller catches it, so expected denials buried real failures
 * (#4534). The host returns refusals as values instead and the sandbox
 * rethrows them, so sandbox code still sees a rejected call.
 */

/**
 * Marks a gateway response that carries a refusal instead of an upstream
 * reply. The gateway strips it from upstream responses, so only the gateway
 * can set it.
 */
export const gatewayErrorHeaderName = 'x-kody-gateway-error'

type SerializedGatewayError = {
	name: string
	message: string
	props: Record<string, unknown>
}

function serializeGatewayError(error: unknown): SerializedGatewayError {
	if (!(error instanceof Error)) {
		return { name: 'Error', message: String(error), props: {} }
	}
	const props: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(error)) {
		if (key === 'name' || key === 'message' || key === 'stack') continue
		props[key] = value
	}
	try {
		JSON.stringify(props)
		return { name: error.name, message: error.message, props }
	} catch {
		return { name: error.name, message: error.message, props: {} }
	}
}

export function gatewayErrorResponse(error: unknown) {
	return new Response(JSON.stringify(serializeGatewayError(error)), {
		status: 500,
		headers: {
			'content-type': 'application/json',
			[gatewayErrorHeaderName]: '1',
		},
	})
}

export function withoutForgedGatewayErrorHeader(response: Response) {
	if (!response.headers.has(gatewayErrorHeaderName)) return response
	const headers = new Headers(response.headers)
	headers.delete(gatewayErrorHeaderName)
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
		...(response.webSocket ? { webSocket: response.webSocket } : {}),
	})
}

/**
 * Sandbox source for `__kodyUnwrapGatewayResponse(response)`: rethrows a
 * gateway refusal with the name, message, and own properties it had on the
 * host (what workerd's error serialization carried before). Intrinsics are
 * captured when the sandbox module loads, before package code runs.
 */
export function createGatewayResponseUnwrapSource() {
	return `
const __kodyGatewayErrorHeaderName = ${JSON.stringify(gatewayErrorHeaderName)};
const __kodyGatewayErrorJsonParse = JSON.parse;
const __kodyGatewayErrorObjectAssign = Object.assign;
const __kodyGatewayErrorResponseText = Response.prototype.text;
const __kodyGatewayErrorHeadersGet = Headers.prototype.get;
const __kodyGatewayErrorReflectApply = Reflect.apply;
const __kodyGatewayErrorHasOwn = Object.hasOwn;
const __kodyGatewayErrorTypes = { Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError };
async function __kodyUnwrapGatewayResponse(response) {
	if (__kodyGatewayErrorReflectApply(__kodyGatewayErrorHeadersGet, response.headers, [__kodyGatewayErrorHeaderName]) === null) {
		return response;
	}
	let serialized = null;
	try {
		serialized = __kodyGatewayErrorJsonParse(await __kodyGatewayErrorReflectApply(__kodyGatewayErrorResponseText, response, []));
	} catch {}
	const name = typeof serialized?.name === 'string' ? serialized.name : 'Error';
	const message = typeof serialized?.message === 'string' ? serialized.message : 'Outbound fetch failed.';
	const ErrorType = __kodyGatewayErrorHasOwn(__kodyGatewayErrorTypes, name) ? __kodyGatewayErrorTypes[name] : __kodyGatewayErrorTypes.Error;
	const error = new ErrorType(message);
	if (error.name !== name) error.name = name;
	if (serialized?.props && typeof serialized.props === 'object') {
		__kodyGatewayErrorObjectAssign(error, serialized.props);
	}
	throw error;
}
`
}
