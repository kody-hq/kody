import { type Principal } from './contracts.ts'

/** Public local fixtures. These identities must never authorize a production route. */
export const spikePeople: Record<string, Principal> = {
	alice: {
		orgId: 'local-team',
		personId: 'alice',
		name: 'Alice',
		kind: 'person',
	},
	bob: { orgId: 'local-team', personId: 'bob', name: 'Bob', kind: 'person' },
	agent: {
		orgId: 'local-team',
		personId: 'agent',
		name: 'Writing agent',
		kind: 'agent',
	},
	viewer: {
		orgId: 'local-team',
		personId: 'viewer',
		name: 'Viewer',
		kind: 'person',
	},
	outsider: {
		orgId: 'other-team',
		personId: 'outsider',
		name: 'Other workspace',
		kind: 'person',
	},
}

export function localPrincipal(request: Request) {
	const token =
		request.headers.get('Authorization')?.replace(/^Bearer /, '') ??
		request.headers
			.get('Sec-WebSocket-Protocol')
			?.match(/(?:^|,\s*)participant\.([a-z]+)/)?.[1]
	return token ? (spikePeople[token] ?? null) : null
}
