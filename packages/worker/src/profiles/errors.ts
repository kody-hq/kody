import { McpCallerError } from '#mcp/caller-error.ts'

export const profileErrorCodes = [
	'feature_disabled',
	'invalid_request',
	'not_found',
	'not_allowed',
	'insufficient_scope',
	'profile_inactive',
	'profile_depth_exceeded',
	'profile_limit_reached',
	'profile_name_taken',
	'profile_expiry_extension',
	'profile_grant_exceeds_caller',
	'profile_grant_exceeds_parent',
	'profile_grant_not_allowed',
] as const

export type ProfileErrorCode = (typeof profileErrorCodes)[number]

/** A caller error with an HTTP status and a stable code (ADR 0092). */
export class ProfileError extends McpCallerError {
	readonly status: number
	readonly code: ProfileErrorCode
	readonly details: Record<string, unknown> | undefined

	constructor(input: {
		status: number
		code: ProfileErrorCode
		message: string
		details?: Record<string, unknown>
	}) {
		super(`${input.message} (${input.code})`)
		this.name = 'ProfileError'
		this.status = input.status
		this.code = input.code
		this.details = input.details
	}
}
