/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'

import { SiteLink } from '../components/site-link.tsx'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	detailGridCss,
	detailItemCss,
	detailLabelCss,
	detailValueCss as sourceDetailValueCss,
	insetCardCss,
	listCss,
	primaryLinkCss,
	sectionTitleCss,
} from '#universal/styles/style-primitives.ts'
import {
	type ConnectOauthConfig,
	type StoredIntegrationConfig,
	isSafeExternalUrl,
} from '#client/routes/connect-oauth-config.ts'
import {
	connectOauthAdvancedDetailsCss,
	connectOauthRedirectUriCardCss,
	connectOauthRedirectUriValueCss,
} from './connect-oauth-shared.ts'

const detailValueCss = sourceDetailValueCss as CSSObject

export function renderRedirectUriCard(input: {
	config: ConnectOauthConfig | null
	redirectUri: string
}) {
	// Built-in apps are registered by the operator; users have nothing to
	// paste into a provider console.
	if (input.config?.platformAppSlug) return null
	if (!input.redirectUri) return null
	const providerName = input.config?.provider ?? 'your provider'
	return (
		<section css={connectOauthRedirectUriCardCss}>
			<h2 css={cardTitleCss}>Redirect URL</h2>
			<p css={{ margin: 0, color: colors.text }}>
				Paste this exact URL into {providerName}&apos;s OAuth app settings as
				the redirect (callback) URL.
			</p>
			<pre css={connectOauthRedirectUriValueCss}>{input.redirectUri}</pre>
			<div>
				<CopyTextButton
					value={input.redirectUri}
					idleLabel="Copy redirect URL"
					variant="primary"
				/>
			</div>
		</section>
	)
}

export function renderProviderInstructions(input: {
	config: ConnectOauthConfig
	hasStoredClientSecret: boolean
}) {
	const instructions = input.config.providerSetupInstructions
	return (
		<>
			<ol css={listCss}>
				<li>Create an OAuth app in your provider&apos;s developer console.</li>
				<li>Register the exact redirect URI shown above.</li>
				<li>Enable any APIs and scopes the integration needs.</li>
				<li>
					Paste the client ID
					{input.config.flow === 'confidential' && !input.hasStoredClientSecret
						? ' and client secret'
						: ''}{' '}
					below.
				</li>
			</ol>
			{instructions && instructions.trim() ? (
				<p css={{ ...insetCardCss, margin: 0, whiteSpace: 'pre-wrap' }}>
					{instructions}
				</p>
			) : null}
			{input.config.dashboardUrl &&
			isSafeExternalUrl(input.config.dashboardUrl) ? (
				<SiteLink
					href={input.config.dashboardUrl}
					target="_blank"
					rel="noreferrer noopener"
					css={primaryLinkCss}
				>
					Open {input.config.provider} developer settings
				</SiteLink>
			) : null}
		</>
	)
}

function renderAllowedHosts(config: ConnectOauthConfig) {
	return (
		<section css={insetCardCss}>
			<h3 css={sectionTitleCss}>Allowed hosts</h3>
			<p css={descriptionCss}>
				Kody only sends this connection&apos;s tokens to these API hosts.
				Approvals are never automatic.
			</p>
			<ul css={listCss}>
				{config.allowedHosts.map((host) => (
					<li key={host}>{host}</li>
				))}
			</ul>
		</section>
	)
}

function renderProviderDetails(config: ConnectOauthConfig) {
	return (
		<section css={insetCardCss}>
			<h3 css={sectionTitleCss}>Provider details</h3>
			<div css={detailGridCss}>
				{config.authorizeUrl ? (
					<div css={detailItemCss}>
						<span css={detailLabelCss}>Authorize URL</span>
						<code css={detailValueCss}>{config.authorizeUrl}</code>
					</div>
				) : null}
				{config.deviceAuthorizationUrl ? (
					<div css={detailItemCss}>
						<span css={detailLabelCss}>Device authorization URL</span>
						<code css={detailValueCss}>{config.deviceAuthorizationUrl}</code>
					</div>
				) : null}
				<div css={detailItemCss}>
					<span css={detailLabelCss}>Token URL</span>
					<code css={detailValueCss}>{config.tokenUrl}</code>
				</div>
				<div css={detailItemCss}>
					<span css={detailLabelCss}>Flow</span>
					<span css={detailValueCss}>{config.flow}</span>
				</div>
				<div css={detailItemCss}>
					<span css={detailLabelCss}>PKCE</span>
					<span css={detailValueCss}>{config.usePkce ? 'S256' : 'off'}</span>
				</div>
				<div css={detailItemCss}>
					<span css={detailLabelCss}>Scopes</span>
					<span css={detailValueCss}>
						{config.scopes.length ? config.scopes.join(' ') : 'None'}
					</span>
				</div>
			</div>
		</section>
	)
}

function renderExistingIntegrationConfig(
	existingIntegrationConfig: StoredIntegrationConfig | null,
) {
	if (!existingIntegrationConfig) return null
	return (
		<section css={cardCss}>
			<h2 css={cardTitleCss}>Existing integration config</h2>
			<p css={descriptionCss}>
				Loaded your saved connection{' '}
				<code>{existingIntegrationConfig.name}</code>.
			</p>
			<div css={detailGridCss}>
				<div css={detailItemCss}>
					<span css={detailLabelCss}>Flow</span>
					<span css={detailValueCss}>{existingIntegrationConfig.flow}</span>
				</div>
				<div css={detailItemCss}>
					<span css={detailLabelCss}>Token URL</span>
					<code css={detailValueCss}>{existingIntegrationConfig.tokenUrl}</code>
				</div>
				{existingIntegrationConfig.apiBaseUrl ? (
					<div css={detailItemCss}>
						<span css={detailLabelCss}>API base URL</span>
						<code css={detailValueCss}>
							{existingIntegrationConfig.apiBaseUrl}
						</code>
					</div>
				) : null}
				<div css={detailItemCss}>
					<span css={detailLabelCss}>Client ID</span>
					<code css={detailValueCss}>{existingIntegrationConfig.clientId}</code>
				</div>
				<div css={detailItemCss}>
					<span css={detailLabelCss}>Client secret</span>
					<code css={detailValueCss}>
						{existingIntegrationConfig.hasClientSecret
							? 'Stored'
							: 'Not stored'}
					</code>
				</div>
			</div>
			{existingIntegrationConfig.authorization ? (
				<div css={insetCardCss}>
					<strong css={sectionTitleCss}>Authorization metadata</strong>
					<div css={detailGridCss}>
						<div css={detailItemCss}>
							<span css={detailLabelCss}>Authorize URL</span>
							<code css={detailValueCss}>
								{existingIntegrationConfig.authorization.authorizeUrl}
							</code>
						</div>
						<div css={detailItemCss}>
							<span css={detailLabelCss}>Scopes</span>
							<span css={detailValueCss}>
								{existingIntegrationConfig.authorization.scopes.length
									? existingIntegrationConfig.authorization.scopes.join(' ')
									: 'None'}
							</span>
						</div>
					</div>
				</div>
			) : null}
			<div css={insetCardCss}>
				<strong css={sectionTitleCss}>Required hosts</strong>
				{existingIntegrationConfig.requiredHosts.length > 0 ? (
					<ul css={listCss}>
						{existingIntegrationConfig.requiredHosts.map((host) => (
							<li key={host}>{host}</li>
						))}
					</ul>
				) : (
					<p css={descriptionCss}>None configured.</p>
				)}
			</div>
		</section>
	)
}

export function renderAdvancedDetails(input: {
	config: ConnectOauthConfig
	existingIntegrationConfig: StoredIntegrationConfig | null
}) {
	return (
		<details
			css={connectOauthAdvancedDetailsCss}
			data-testid="connect-oauth-advanced"
		>
			<summary>Advanced details</summary>
			<div css={{ display: 'grid', gap: spacing.md }}>
				{renderProviderDetails(input.config)}
				{renderAllowedHosts(input.config)}
				{renderExistingIntegrationConfig(input.existingIntegrationConfig)}
			</div>
		</details>
	)
}

export function renderSuccessAdvancedDetails(input: {
	config: ConnectOauthConfig
	accessTokenSaved: boolean
	refreshTokenSaved: boolean
}) {
	return (
		<details
			css={connectOauthAdvancedDetailsCss}
			data-testid="connect-oauth-advanced"
		>
			<summary>Advanced details</summary>
			<div css={{ display: 'grid', gap: spacing.md }}>
				<div css={detailGridCss}>
					<div css={detailItemCss}>
						<span css={detailLabelCss}>Access token saved</span>
						<strong css={detailValueCss}>
							{input.accessTokenSaved ? 'Yes' : 'No'}
						</strong>
					</div>
					<div css={detailItemCss}>
						<span css={detailLabelCss}>Refresh token saved</span>
						<strong css={detailValueCss}>
							{input.refreshTokenSaved ? 'Yes' : 'No'}
						</strong>
					</div>
				</div>
				{renderAllowedHosts(input.config)}
				<SiteLink
					href="/account/secrets"
					target="_blank"
					rel="noreferrer"
					css={primaryLinkCss}
				>
					Open account secrets
				</SiteLink>
			</div>
		</details>
	)
}
