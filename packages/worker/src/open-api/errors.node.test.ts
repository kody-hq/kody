import { getErrorMessage } from '@kody-internal/shared/error-message.ts'
import { expect, test } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	AuthorizationError,
	LivePersonRequiredError,
} from '#worker/authorization/authorize.ts'
import { wrapArtifactsGitHttpError } from '#worker/repo/artifacts-git-retry.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import { QuarantinedInboundReplyError } from '#worker/email/quarantined-inbound-reply.ts'
import { ApiError, toApiError } from './errors.ts'

test('ApiError.toBody redacts Kody credentials in error details', () => {
	const apiToken = `kody_at_${'a'.repeat(20)}_${'B'.repeat(43)}`
	const bootstrapCode = `kody_bc_${'b'.repeat(16)}_${'C'.repeat(32)}`

	const body = new ApiError({
		status: 400,
		code: 'invalid_request',
		message: 'Invalid details.',
		details: {
			credentials: [apiToken, { nested: `failed with ${bootstrapCode}` }],
		},
	}).toBody()

	expect(body.error.details).toEqual({
		credentials: [
			'kody_at_[redacted]',
			{ nested: 'failed with kody_bc_[redacted]' },
		],
	})
})

function artifactsGitHttpError(statusCode: number) {
	const error = new Error(
		`HTTP Error: ${statusCode} Internal Server Error`,
	) as Error & {
		code: string
		name: string
		data: { statusCode: number; statusMessage: string; response: string }
	}
	error.code = 'HttpError'
	error.name = 'HttpError'
	error.data = {
		statusCode,
		statusMessage: 'Internal Server Error',
		response: '',
	}
	return error
}

test('toApiError maps a quarantined inbound reply refusal to 409 quarantined_inbound_reply', () => {
	const refused = new QuarantinedInboundReplyError()
	expect(toApiError(refused)).toMatchObject({
		status: 409,
		code: 'quarantined_inbound_reply',
		message: refused.message,
	})
	const wrapped = new Error('Capability invocation failed.', { cause: refused })
	expect(toApiError(wrapped)).toMatchObject({
		status: 409,
		code: 'quarantined_inbound_reply',
		message: refused.message,
	})
})

test('toApiError maps exhausted Artifacts git failures to 503 internal_error with report id details', () => {
	consoleError.mockImplementation(() => {})
	const remote =
		'https://x:secret@acct.artifacts.cloudflare.net/git/production/repo-1.git'
	const wrapped = wrapArtifactsGitHttpError({
		operation: 'git clone',
		remote,
		error: artifactsGitHttpError(500),
	})

	const apiError = toApiError(wrapped)

	expect(apiError).toMatchObject({
		status: 503,
		code: 'internal_error',
	})
	expect(apiError.message).toMatch(
		/^The package source could not be read after retries \(HTTP 5xx\)\. Report id: /,
	)
	expect(apiError.message).not.toMatch(/temporarily unavailable/i)
	expect(apiError.details).toEqual({
		report_id: expect.any(String),
		upstream_status_class: 'http_5xx',
		upstream_status: 500,
	})
	expect(apiError.message).not.toContain('secret')
	expect(apiError.message).not.toContain('artifacts.cloudflare.net')
	expect(apiError.message).not.toContain('HTTP Error')
	// Not a caller error — MCP api marks callerError from status < 500.
	expect(apiError.status).toBeGreaterThanOrEqual(500)
	expect(apiError.toBody()).toEqual({
		error: {
			code: 'internal_error',
			message: apiError.message,
			details: {
				report_id: expect.any(String),
				upstream_status_class: 'http_5xx',
				upstream_status: 500,
			},
		},
	})
	expect(consoleError).toHaveBeenCalledWith(
		expect.stringContaining('"message":"artifacts-git-unavailable"'),
	)
})

test('toApiError keeps non-transient internal failures as generic 500', () => {
	const original = new Error('unexpected storage corruption')
	const apiError = toApiError(original)

	expect(apiError).toMatchObject({
		status: 500,
		code: 'internal_error',
		message: 'Internal error. Retry later or report it if it persists.',
	})
	expect(apiError.cause).toBe(original)
	expect(getErrorMessage(apiError.cause)).toBe('unexpected storage corruption')
})

test('toApiError does not remap bare TimeoutError or source-recovery wraps as Artifacts git', () => {
	const bareTimeout = new Error('The operation timed out.')
	bareTimeout.name = 'TimeoutError'
	expect(toApiError(bareTimeout)).toMatchObject({
		status: 500,
		code: 'internal_error',
		message: 'Internal error. Retry later or report it if it persists.',
	})

	const oauthTimeout = new Error(
		'Token refresh failed for integration "google" with HTTP 503 (server_error).',
		{ cause: bareTimeout },
	)
	expect(toApiError(oauthTimeout)).toMatchObject({
		status: 500,
		code: 'internal_error',
		message: 'Internal error. Retry later or report it if it persists.',
	})

	const recovery = new Error(
		'packageGetGitRemote stopped by the production package source safety policy. Kody could not verify a restorable backup snapshot for source "source-1" at published commit "abc": Artifacts git clone failed for https://example.test/repo.git: HTTP Error: 500 Internal Server Error. Stop and report this source recovery problem instead of rebuilding or overwriting the package in place.',
		{
			cause: wrapArtifactsGitHttpError({
				operation: 'git clone',
				remote: 'https://example.test/repo.git',
				error: artifactsGitHttpError(500),
			}),
		},
	)
	expect(toApiError(recovery)).toMatchObject({
		status: 500,
		code: 'internal_error',
		message: 'Internal error. Retry later or report it if it persists.',
	})
})

test('toApiError maps a live-person denial to 403 naming the capability', () => {
	const apiError = toApiError(new LivePersonRequiredError('orgMemberUpdate'))

	expect(apiError).toMatchObject({
		status: 403,
		code: 'insufficient_scope',
		details: {
			capability: 'orgMemberUpdate',
			denial: 'live_person_required',
		},
	})
	expect(apiError.message).toContain('"orgMemberUpdate" needs a live person')
})

test('toApiError adds required_scope and mint_scopes to credential-scope denials', () => {
	const apiError = toApiError(
		new AuthorizationError({
			code: 'credential_scope',
			permission: 'package:write',
			orgId: null,
			resource: null,
			message: 'This credential is not scoped for package:write.',
			mintScopes: ['org:execute', 'package:write'],
		}),
	)

	expect(apiError).toMatchObject({
		status: 403,
		code: 'insufficient_scope',
		details: {
			required_permission: 'package:write',
			denial: 'credential_scope',
			required_scope: 'package:write',
			mint_scopes: ['org:execute', 'package:write'],
		},
	})
})

test('toApiError leaves role denials without mint scopes', () => {
	const apiError = toApiError(
		new AuthorizationError({
			code: 'missing_permission',
			permission: 'package:write',
			orgId: null,
			resource: null,
			message: 'Missing package:write. An org Owner can grant it.',
		}),
	)

	expect(apiError.details).toEqual({
		required_permission: 'package:write',
		denial: 'missing_permission',
	})
})

test('toApiError maps missing published-snapshot McpCallerError to a clear client error', () => {
	const apiError = toApiError(
		new McpCallerError(
			'Published snapshot for package "@danj/hey-email" at commit "abc" is missing and could not be recovered from the artifact repo. Republish the package to restore it.',
		),
	)

	expect(apiError).toMatchObject({
		status: 400,
		code: 'invalid_request',
		message: expect.stringContaining('Published snapshot'),
	})
	expect(apiError.code).not.toBe('internal_error')
	expect(apiError.message).not.toBe(
		'Internal error. Retry later or report it if it persists.',
	)
})
