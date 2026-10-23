import {
	type RuntimePackageAppIdentity,
	type RuntimePackageAppVisitor,
} from '@kody-internal/shared/runtime-worker.ts'

/**
 * Verified visitor identity on the request package code receives. The
 * platform sets it after authenticating the visitor's session, and only after
 * `createPackageCodeRequest` has stripped every inbound `X-Kody-*` header, so
 * a browser or upstream cannot forge it. It carries `userId`, `username`, and
 * `role` (the visitor's role in the owning org, null for anyone who is not a
 * member). It grants nothing; it only says who is visiting.
 */
export const packageAppVisitorHeaderName = 'X-Kody-Visitor'

export type PackageAppVisitorHeaderValue = {
	userId: string
	username: string
	role: string | null
}

export function packageAppVisitorHeaderValue(input: {
	visitor: RuntimePackageAppVisitor | null
	identity?: RuntimePackageAppIdentity | null
}): string | null {
	const value: PackageAppVisitorHeaderValue | null = input.visitor
		? {
				userId: input.visitor.userId,
				username: input.visitor.username,
				role: input.visitor.role,
			}
		: input.identity
			? {
					userId: input.identity.userId,
					username: input.identity.username,
					role: null,
				}
			: null
	if (!value || !value.userId) return null
	// Header values must be ByteStrings; escape anything outside ASCII.
	return JSON.stringify(value).replace(
		/[\u007f-\uffff]/g,
		(char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
	)
}

/** Set (or clear) the visitor header on a request bound for package code. */
export function withPackageAppVisitorHeader(
	request: Request,
	input: {
		visitor: RuntimePackageAppVisitor | null
		identity?: RuntimePackageAppIdentity | null
	},
) {
	const value = packageAppVisitorHeaderValue(input)
	const next = new Request(request)
	next.headers.delete(packageAppVisitorHeaderName)
	if (value) next.headers.set(packageAppVisitorHeaderName, value)
	return next
}
