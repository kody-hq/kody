import type { AccountIntegrationListItem } from '#universal/loader-data.ts'
export type OAuthFlow = 'pkce' | 'confidential' | 'device'
export type TokenExchangeStyle = 'form' | 'basic-json' | 'basic-form'
export type ConnectOauthQueryConfig = {
	provider: string
	providerKey: string
	authorizeHost: string | null
	authorizeUrl: string | null
	deviceAuthorizationUrl: string | null
	tokenUrl: string | null
	apiBaseUrl: string | null
	scopes: Array<string> | null
	flow: OAuthFlow | null
	usePkce: boolean | null
	tokenExchangeStyle: TokenExchangeStyle | null
	scopeSeparator: string | null
	extraAuthorizeParams: Record<string, string> | null
	providerSetupInstructions: string | null
	dashboardUrl: string | null
	allowedHosts: Array<string>
	/** Prefills Google/OIDC account chooser without replacing stored extra params. */
	loginHint?: string | null
}
export type ConnectOauthConfig = {
	provider: string
	providerKey: string
	authorizeHost: string
	tokenHost: string
	authorizeUrl: string | null
	deviceAuthorizationUrl: string | null
	tokenUrl: string
	apiBaseUrl: string | null
	scopes: Array<string>
	flow: OAuthFlow
	/**
	 * PKCE is orthogonal to `flow`: providers like Canva require S256 PKCE
	 * *and* a client secret on token exchange.
	 */
	usePkce: boolean
	tokenExchangeStyle: TokenExchangeStyle
	scopeSeparator: string
	extraAuthorizeParams: Record<string, string>
	providerSetupInstructions: string | null
	dashboardUrl: string | null
	clientId: string
	hasClientSecret: boolean
	allowedHosts: Array<string>
	/**
	 * Set when connecting through a platform (built-in) OAuth app: the
	 * operator owns the client registration, token exchange runs host-side
	 * with the shared secret, and the client-credential setup step is skipped.
	 */
	platformAppSlug: string | null
	/**
	 * Set when a member connects their own account through the scoped org's
	 * OAuth app: the org owns the client registration and exchange runs
	 * host-side with its secret; the connection is the member's (ADR 0068).
	 */
	pinnedAppSlug: string | null
	/** Relative path of the operator-uploaded provider logo, when present. */
	platformLogoPath: string | null
	/** Explicit user-uploaded OAuth app logo (beats catalog and favicon). */
	logoPath?: string | null
	/** Auto-fetched favicon (loses to an explicit upload or catalog mark). */
	autoLogoPath?: string | null
	/** Operator-curated provider mark (after upload, before favicon). */
	catalogLogoPath?: string | null
	/** Operator-authored provider note (limitations, caveats), when present. */
	platformDescription: string | null
	/**
	 * Operator-verified scope menu for platform apps. Empty for bring-your-own
	 * connections, where the requested list is the whole editable set.
	 */
	platformAllowedScopes: Array<string>
}
export type StoredIntegrationAuthorization = NonNullable<
	NonNullable<AccountIntegrationListItem['authorization']>
>
export type StoredIntegrationConfig = Omit<
	AccountIntegrationListItem,
	| 'apiBaseUrl'
	| 'authorization'
	| 'createdAt'
	| 'requiredHosts'
	| 'updatedAt'
	| 'appSlug'
	| 'provider'
	| 'appLabel'
	| 'accountLabel'
> & {
	apiBaseUrl: string | null
	hasClientSecret: boolean
	requiredHosts: Array<string>
	usePkce?: boolean | null
	/** Omitted when unset so persisted JSON stays sparse (matches pre-import shape). */
	tokenExchangeStyle?: TokenExchangeStyle | null
	authorization?: StoredIntegrationAuthorization | null
	/** Platform (built-in) app slug when the record is a platform connection or prefill. */
	pinnedAppSlug?: string | null
	platformAppSlug?: string | null
	/** Operator-verified scope menu for platform apps; requested scopes are clamped to it. */
	platformAllowedScopes?: Array<string>
	/** Relative path of the operator-uploaded provider logo. */
	platformLogoPath?: string | null
	logoPath?: string | null
	autoLogoPath?: string | null
	catalogLogoPath?: string | null
	/** Operator-authored provider note (limitations, caveats). */
	platformDescription?: string | null
	/** RFC 8628 device authorization endpoint when flow is `device`. */
	deviceAuthorizationUrl?: string | null
}
export type ConnectOauthHostApprovalLink = {
	secretName: string
	host: string
	approvalUrl: string
}
export type ConnectOauthNextSteps = {
	service: string
	connectionName: string
	prompt: string
}
