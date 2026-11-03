/**
 * Agent-facing structured errors for local testing (design 2026-10-13).
 * Stable `code`, optional `where` / `fix`, and which `target` produced it.
 */

import { type KodyTarget } from './target.js'

type StructuredErrorCode =
	| 'not_implemented_in_mock'
	| 'unmocked_request'
	| 'unresolved_import'
	| 'missing_secret'
	| 'bundle_failed'
	| 'package_manifest_invalid'
	| 'dev_handler_missing'
	| 'dev_surface_missing'
	| 'invalid_target'
	| 'invalid_port'
	| 'dev_port_in_use'
	| 'dev_already_running'

export type StructuredErrorBody = {
	code: StructuredErrorCode | string
	message: string
	target?: KodyTarget
	where?: string
	fix?: string
	details?: Record<string, unknown>
}

export class StructuredCliError extends Error {
	readonly code: string
	readonly target?: KodyTarget
	readonly where?: string
	readonly fix?: string
	readonly details?: Record<string, unknown>

	constructor(body: StructuredErrorBody) {
		super(formatStructuredErrorMessage(body))
		this.name = 'StructuredCliError'
		this.code = body.code
		this.target = body.target
		this.where = body.where
		this.fix = body.fix
		this.details = body.details
	}

	toJSON(): StructuredErrorBody {
		return {
			code: this.code,
			message: stripStructuredPrefix(this.message),
			...(this.target !== undefined ? { target: this.target } : {}),
			...(this.where !== undefined ? { where: this.where } : {}),
			...(this.fix !== undefined ? { fix: this.fix } : {}),
			...(this.details !== undefined ? { details: this.details } : {}),
		}
	}
}

function formatStructuredErrorMessage(body: StructuredErrorBody): string {
	const lines = [`[${body.code}] ${body.message}`]
	if (body.target) lines.push(`target: ${body.target}`)
	if (body.where) lines.push(`where: ${body.where}`)
	if (body.fix) lines.push(`fix: ${body.fix}`)
	return lines.join('\n')
}

function stripStructuredPrefix(message: string): string {
	const match = /^\[([^\]]+)\]\s*/.exec(message)
	if (!match) return message
	return message.slice(match[0].length).split('\n')[0] ?? message
}

export function notImplementedInMock(input: {
	operation: string
	fix?: string
}): StructuredCliError {
	return new StructuredCliError({
		code: 'not_implemented_in_mock',
		message: `The CLI mock does not implement ${input.operation}.`,
		target: 'mock',
		fix:
			input.fix ??
			`Use \`--target prod\` for this operation, or extend the mock. The mock refuses anything it does not implement rather than faking success.`,
		details: { operation: input.operation },
	})
}
