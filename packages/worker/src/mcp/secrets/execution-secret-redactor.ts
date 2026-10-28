import {
	apiTokenPrefix,
	redactApiTokens,
	redactKodyCredentials,
} from '@kody-internal/shared/api-token-format.ts'
import { isRecord } from '@kody-internal/shared/is-record.ts'

export const redactedSecretText = '[REDACTED SECRET]'

function base64Encode(value: string) {
	let binary = ''
	for (const byte of new TextEncoder().encode(value)) {
		binary += String.fromCharCode(byte)
	}
	return btoa(binary)
}

/** `value` plus its URL-encoded and base64 forms, for tracking. */
export function secretValueForms(value: string) {
	if (value.length === 0) return []
	return [...new Set([value, encodeURIComponent(value), base64Encode(value)])]
}

export function trackSecretValueForms(
	track: ((value: string) => void) | undefined,
	value: unknown,
) {
	if (!track || typeof value !== 'string') return
	for (const form of secretValueForms(value)) track(form)
}

export type ExecutionSecretRedactor = {
	track(value: string): void
	redactErrorMessage(value: string): string
	redactUnknown(value: unknown): unknown
}

export function createExecutionSecretRedactor(): ExecutionSecretRedactor {
	const secretValues = new Set<string>()
	return {
		track(value: string) {
			if (value.length > 0) {
				secretValues.add(value)
			}
		},
		redactErrorMessage(value: string) {
			return redactKodyCredentials(
				redactSecretValuesInString(value, secretValues),
			)
		},
		redactUnknown(value: unknown) {
			if (secretValues.size === 0 && !mayContainApiToken(value)) return value
			return redactUnknownSecretValues(value, secretValues)
		},
	}
}

function redactUnknownSecretValues(
	value: unknown,
	secretValues: ReadonlySet<string>,
	seen = new WeakMap<object, unknown>(),
): unknown {
	if (typeof value === 'string') {
		return redactSecretValuesInString(value, secretValues)
	}
	if (value instanceof Error) {
		const existing = seen.get(value)
		if (existing) return existing
		const next = new Error(
			redactSecretValuesInString(value.message, secretValues),
			value.cause !== undefined ? { cause: undefined } : undefined,
		)
		seen.set(value, next)
		if (value.cause !== undefined) {
			next.cause = redactUnknownSecretValues(value.cause, secretValues, seen)
		}
		next.name = value.name
		if (value.stack) {
			next.stack = redactSecretValuesInString(value.stack, secretValues)
		}
		return next
	}
	if (Array.isArray(value)) {
		const existing = seen.get(value)
		if (existing) return existing
		const next: Array<unknown> = []
		seen.set(value, next)
		for (const entry of value) {
			next.push(redactUnknownSecretValues(entry, secretValues, seen))
		}
		return next
	}
	if (isRecord(value)) {
		const existing = seen.get(value)
		if (existing) return existing
		const next: Record<string, unknown> = {}
		seen.set(value, next)
		for (const [key, entry] of Object.entries(value)) {
			const redactedKey = redactSecretValuesInString(key, secretValues)
			next[redactedKey] = redactUnknownSecretValues(entry, secretValues, seen)
		}
		return next
	}
	return value
}

function redactSecretValuesInString(
	value: string,
	secretValues: ReadonlySet<string>,
) {
	if (value.length === 0) return value
	let nextValue = redactApiTokens(value)
	for (const secretValue of [...secretValues].sort(
		(left, right) => right.length - left.length,
	)) {
		nextValue = nextValue.replaceAll(secretValue, redactedSecretText)
	}
	return nextValue
}

/**
 * Kody API tokens (`kody_at_…`) are redacted from run output even when the
 * run never read them through a secret, so a token a module prints or
 * returns never lands in run history.
 */
function mayContainApiToken(value: unknown) {
	if (typeof value === 'string') return value.includes(apiTokenPrefix)
	if (value === null || typeof value !== 'object') return false
	try {
		return (
			JSON.stringify(value, (_key, entry: unknown) =>
				entry instanceof Error
					? { message: entry.message, stack: entry.stack, cause: entry.cause }
					: entry,
			)?.includes(apiTokenPrefix) ?? false
		)
	} catch {
		return true
	}
}
