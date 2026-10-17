declare const process: { env: { TSS_SERVER_FN_BASE?: string } }

export function isServerFunctionRequest(request: Request) {
	const base = process.env.TSS_SERVER_FN_BASE
	return Boolean(base && new URL(request.url).pathname.startsWith(base))
}

/** Token links mutate on GET, and must never be consumed by link checkers. */
// Token links may change state on GET. Explicit HEAD handlers stop Start from
// falling back to the document loader when mail scanners probe these links.
export function rejectActionPageHead() {
	return new Response(null, { status: 405, headers: { Allow: 'GET' } })
}
