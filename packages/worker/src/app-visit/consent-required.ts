import { McpCallerError } from '#mcp/caller-error.ts'

export type AppConsentKind = 'run_as_me' | 'visitor_need'

/**
 * An agent's app visit needs a consent only the person can give. Agents never
 * approve "Run as me" or a visitor need, so the visit stops here and names
 * the link the person opens once. Nothing is minted or recorded.
 */
export class AppConsentRequiredError extends McpCallerError {
	readonly code = 'app_consent_required'
	readonly consent: AppConsentKind
	readonly consentUrl: string
	readonly need: string | null

	constructor(input: {
		consent: AppConsentKind
		consentUrl: string
		app: string
		need?: string | null
	}) {
		super(
			input.consent === 'run_as_me'
				? `${input.app} runs on the person's own Kody account, and they have not confirmed that yet. Ask them to open ${input.consentUrl} once and confirm "Run as me", then call again. An agent cannot confirm it for them.`
				: `${input.app} needs the person to allow ${input.need ? `"${input.need}"` : 'a credential'} before it can run for them. Ask them to open ${input.consentUrl} once and allow it, then call again. An agent cannot allow it for them.`,
		)
		this.name = 'AppConsentRequiredError'
		this.consent = input.consent
		this.consentUrl = input.consentUrl
		this.need = input.need ?? null
	}
}
