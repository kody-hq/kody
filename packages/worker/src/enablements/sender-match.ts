import {
	normalizeEmailAddress,
	normalizeHeaderMailbox,
} from '#worker/email/address.ts'
import { type InboundEmailSender } from '#worker/request-context/request-context.ts'
import { type EnablementSenderKind } from './types.ts'

/**
 * What an inbound message presents to a sender rule. `authenticated` is
 * DMARC pass or aligned SPF (`authenticatesFromAddress`), never DKIM alone.
 */
export type InboundSenderMatch = {
	sender: InboundEmailSender
	fromAddress: string | null
	authenticated: boolean
}

function fromDomain(fromAddress: string | null) {
	const normalized = fromAddress ? normalizeHeaderMailbox(fromAddress) : null
	if (!normalized) return null
	const at = normalized.lastIndexOf('@')
	return at === -1 ? null : normalized.slice(at + 1)
}

/**
 * Canonical form stored on enablements and used in the live unique index.
 * Address and domain are lowercased; `any_authenticated` drops the value.
 * A kind that needs a value but cannot normalize one becomes null/null so
 * it never becomes a live rule that matches nothing.
 */
export function canonicalizeEnablementSender(input: {
	senderKind: EnablementSenderKind | null | undefined
	senderValue: string | null | undefined
}): { senderKind: EnablementSenderKind | null; senderValue: string | null } {
	const senderKind = input.senderKind ?? null
	if (!senderKind) return { senderKind: null, senderValue: null }
	switch (senderKind) {
		case 'any_authenticated':
			return { senderKind, senderValue: null }
		case 'member': {
			const value = input.senderValue?.trim().toLowerCase() ?? ''
			if (!value) return { senderKind: null, senderValue: null }
			return { senderKind, senderValue: value }
		}
		case 'address': {
			const value = input.senderValue
				? normalizeEmailAddress(input.senderValue)
				: null
			if (!value) return { senderKind: null, senderValue: null }
			return { senderKind, senderValue: value }
		}
		case 'domain': {
			const value = input.senderValue?.trim().toLowerCase().replace(/^@+/, '')
			// Same bare-hostname rules as normalizeProposalDomain: no mailbox,
			// spaces, wildcards, or percent/underscore placeholders.
			if (
				!value ||
				value.includes('@') ||
				/\s/.test(value) ||
				!value.includes('.') ||
				/[%_*]/.test(value)
			) {
				return { senderKind: null, senderValue: null }
			}
			return { senderKind, senderValue: value }
		}
		default: {
			const exhaustive: never = senderKind
			throw new Error(`Unhandled enablement sender kind: ${String(exhaustive)}`)
		}
	}
}

/** True when a canonical sender is safe to store as a live email rule. */
export function isCompleteEnablementSender(input: {
	senderKind: EnablementSenderKind | null
	senderValue: string | null
}): boolean {
	if (!input.senderKind) return false
	if (input.senderKind === 'any_authenticated') return true
	return Boolean(input.senderValue)
}

/**
 * Whether one enablement's sender rule matches this inbound message.
 * A null `senderKind` never matches: unmatched mail stays in the inbox
 * and runs no package.
 */
export function enablementMatchesInboundSender(input: {
	senderKind: EnablementSenderKind | null
	senderValue: string | null
	match: InboundSenderMatch
}): boolean {
	const { senderKind, senderValue, match } = input
	if (!senderKind) return false
	switch (senderKind) {
		case 'member': {
			if (match.sender.kind !== 'member') return false
			if (!senderValue) return false
			return senderValue === String(match.sender.actor.userId)
		}
		case 'address': {
			if (!match.authenticated || !senderValue) return false
			const from = match.fromAddress
				? normalizeHeaderMailbox(match.fromAddress)
				: null
			const expected = normalizeEmailAddress(senderValue)
			return from !== null && expected !== null && from === expected
		}
		case 'domain': {
			if (!match.authenticated || !senderValue) return false
			const domain = fromDomain(match.fromAddress)
			return domain !== null && domain === senderValue.toLowerCase()
		}
		case 'any_authenticated':
			return match.authenticated
		default: {
			const exhaustive: never = senderKind
			throw new Error(`Unhandled enablement sender kind: ${String(exhaustive)}`)
		}
	}
}
