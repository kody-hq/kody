/**
 * Vitest closes a worker's birpc channel while a module `resolve` call is
 * still in flight and reports it as an unhandled `EnvironmentTeardownError`
 * after every test already passed (#5004, #5026). It is teardown noise, not a
 * test result, so it must not fail the run.
 */
const teardownRpcMessage = /Closing rpc while "[^"]+" was pending/

export function isVitestTeardownRpcError(error: {
	name?: string
	message?: string
}) {
	return (
		error.name === 'EnvironmentTeardownError' &&
		teardownRpcMessage.test(error.message ?? '')
	)
}

export function ignoreVitestTeardownRpcError(error: {
	name?: string
	message?: string
}) {
	if (isVitestTeardownRpcError(error)) return false
}
