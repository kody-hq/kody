/** @jsxImportSource @emotion/react */

import { SiteLink } from '../components/site-link.tsx'
import { type ConnectOauthExistingConnection } from '#universal/loader-data.ts'
import { docHref } from '#universal/docs-nav.ts'
import { ErrorAgentPromptButton } from '../components/error-agent-prompt-button.tsx'
import { buildConnectOauthFailureAgentPrompt } from '#universal/error-agent-prompt-presets.ts'
import { buildIncompleteConnectOauthPrompt } from '#universal/oauth-scopes.ts'
import { isConnectOauthCallbackUrl } from '#universal/oauth-connect.ts'

import { ProviderMark } from '../components/provider-icons.tsx'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	getAccentCalloutCss,
	getSecondaryButtonCss,
	inputCss,
	insetCardCss,
	listCss,
	pageDescriptionCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import {
	connectOauthChooserFilterMinOptions,
	connectOauthChooserListMaxHeight,
	connectOauthChooserOptionMarkSize,
	filterConnectOauthChooserOptions,
} from '#client/routes/connect-oauth-chooser-list.ts'
import { type ConnectOauthConfig } from '#client/routes/connect-oauth-config.ts'
import {
	type ConnectOauthChooserOption,
	type ConnectOauthStatusTone,
	type ConnectOauthStep,
} from './connect-oauth-shared.ts'

export function wouldReplaceDifferentApp(input: {
	config: ConnectOauthConfig | null
	existingConnection: ConnectOauthExistingConnection | null
}) {
	if (!input.config || !input.existingConnection) return false
	return input.existingConnection.lane === 'platform'
}

export function renderReplaceConfirmation(input: {
	config: ConnectOauthConfig
	existingConnection: ConnectOauthExistingConnection | null
	replaceConfirmed: boolean
	submitting: boolean
	onConfirm: () => void
}) {
	if (
		!wouldReplaceDifferentApp({
			config: input.config,
			existingConnection: input.existingConnection,
		}) ||
		input.replaceConfirmed
	) {
		return null
	}
	const existingLabel =
		input.existingConnection?.lane === 'platform'
			? `the built-in ${input.existingConnection.appSlug} integration`
			: 'your own OAuth app'
	return (
		<div css={insetCardCss}>
			<p css={{ margin: 0, color: colors.text, fontWeight: 600 }}>
				You already have a {input.config.providerKey} connection using{' '}
				{existingLabel}.
			</p>
			<p css={descriptionCss}>
				Continuing replaces its tokens and scopes. You can also keep it and
				connect under a different name.
			</p>
			<div
				css={{
					display: 'flex',
					flexWrap: 'wrap',
					gap: spacing.sm,
					alignItems: 'center',
				}}
			>
				<button
					type="button"
					disabled={input.submitting}
					css={getSecondaryButtonCss()}
					onClick={() => {
						input.onConfirm()
					}}
					data-testid="connect-replace-confirm"
				>
					Replace {input.config.providerKey}
				</button>
			</div>
		</div>
	)
}

export function renderCallbackPending() {
	return (
		<section css={cardCss} data-testid="connect-oauth-callback">
			<p css={{ margin: 0, color: colors.text }}>Finishing the connection…</p>
		</section>
	)
}

export function renderChooser(input: {
	chooserOptions: Array<ConnectOauthChooserOption>
	chooserFilter: string
	onFilterChange: (value: string) => void
	onFilterInput?: (node: HTMLInputElement) => void
	onFilterDetach?: (node: HTMLInputElement) => void
}) {
	const showFilter =
		input.chooserOptions.length > connectOauthChooserFilterMinOptions
	const visibleOptions = showFilter
		? filterConnectOauthChooserOptions(
				input.chooserOptions,
				input.chooserFilter,
			)
		: input.chooserOptions
	return (
		<section css={cardCss} data-testid="connect-oauth-chooser">
			<p css={{ margin: 0, color: colors.text }}>
				Pick a service to connect. Saved integrations start from a name alone.
			</p>
			{showFilter ? (
				<input
					type="text"
					role="searchbox"
					inputMode="search"
					autoComplete="off"
					placeholder="Filter services"
					aria-label="Filter services"
					data-testid="connect-oauth-chooser-filter"
					css={inputCss}
					value={input.chooserFilter}
					onChange={(event) => input.onFilterChange(event.currentTarget.value)}
				/>
			) : null}
			{input.chooserOptions.length > 0 ? (
				visibleOptions.length > 0 ? (
					<ul
						data-testid="connect-oauth-chooser-list"
						css={{
							...listCss,
							listStyle: 'none',
							paddingLeft: 0,
							margin: 0,
							display: 'grid',
							gap: spacing.sm,
							maxHeight: connectOauthChooserListMaxHeight,
							overflowY: 'auto',
						}}
					>
						{visibleOptions.map((option) => (
							<li key={option.id}>
								<SiteLink
									href={option.href}
									css={{
										...insetCardCss,
										display: 'grid',
										gridTemplateColumns: 'auto 1fr',
										gap: spacing.sm,
										alignItems: 'center',
										textDecoration: 'none',
										color: 'inherit',
									}}
								>
									<ProviderMark
										providerKey={option.providerKey}
										label={option.label}
										logoPath={option.logoPath}
										autoLogoPath={option.autoLogoPath}
										catalogLogoPath={option.catalogLogoPath}
										size={connectOauthChooserOptionMarkSize}
									/>
									<span css={{ display: 'grid', gap: spacing.xs }}>
										<strong css={{ color: colors.text }}>{option.label}</strong>
										<span css={descriptionCss}>{option.detail}</span>
									</span>
								</SiteLink>
							</li>
						))}
					</ul>
				) : (
					<p css={descriptionCss}>No services match that filter.</p>
				)
			) : (
				<p css={descriptionCss}>No saved connections are ready yet.</p>
			)}
			<p css={descriptionCss}>
				Need a service that is not listed?{' '}
				<SiteLink href={docHref('oauth')} css={primaryLinkCss}>
					Bring your own OAuth app
				</SiteLink>
				.
			</p>
		</section>
	)
}

export function renderIncompleteConfig(provider: string) {
	return (
		<section css={cardCss} data-testid="connect-oauth-incomplete">
			<p css={{ margin: 0, color: colors.text }}>
				Kody does not have enough OAuth configuration to connect {provider} from
				this URL.
			</p>
			<p css={descriptionCss}>
				Copy this prompt for your agent so it can fill in the authorize and
				token URLs and send you a complete link.
			</p>
			<ErrorAgentPromptButton
				prompt={buildIncompleteConnectOauthPrompt({ provider })}
				variant="primary"
			/>
			<p css={descriptionCss}>
				Or start from a known service on the{' '}
				<SiteLink href="/connect/oauth" css={primaryLinkCss}>
					connect page
				</SiteLink>
				.
			</p>
		</section>
	)
}

export function renderStatusCallout(input: {
	statusTone: ConnectOauthStatusTone
	statusMessage: string
	currentStep: ConnectOauthStep
	provider?: string | null
	connectionName?: string | null
	includePrompt?: boolean
}) {
	if (input.statusTone === 'error') {
		return (
			<div
				role="alert"
				css={getAccentCalloutCss({
					accentColor: colors.error,
				})}
			>
				<p css={{ margin: 0, color: colors.error }}>{input.statusMessage}</p>
				{input.includePrompt === false ? null : (
					<ErrorAgentPromptButton
						prompt={buildConnectOauthFailureAgentPrompt({
							statusMessage: input.statusMessage,
							provider: input.provider,
							connectionName: input.connectionName,
						})}
					/>
				)}
			</div>
		)
	}
	if (input.currentStep === 'callback') {
		return <p css={pageDescriptionCss}>{input.statusMessage}</p>
	}
	return null
}

export function connectOauthHeaderTitle(input: {
	config: ConnectOauthConfig | null
	requestedProvider: string | null
	statusTone: ConnectOauthStatusTone
	href: string
}) {
	if (input.config) return `Connect ${input.config.provider}`
	if (input.requestedProvider) return `Connect ${input.requestedProvider}`
	if (
		input.statusTone !== 'error' &&
		isConnectOauthCallbackUrl(new URL(input.href, 'https://kody.local'))
	) {
		return 'Completing connection'
	}
	return 'Connect an account'
}

export function connectOauthHeaderDescription(input: {
	config: ConnectOauthConfig | null
	requestedProvider: string | null
	hasConfigError: boolean
	statusTone: ConnectOauthStatusTone
	statusMessage: string
	currentStep: ConnectOauthStep
	href: string
}) {
	if (input.statusTone === 'error') return null
	if (input.currentStep === 'callback') return null
	if (
		!input.config &&
		isConnectOauthCallbackUrl(new URL(input.href, 'https://kody.local'))
	) {
		return null
	}
	if (!input.config) {
		if (input.requestedProvider && input.hasConfigError) {
			return 'This URL is missing the provider endpoints needed to start OAuth.'
		}
		if (!input.requestedProvider) {
			return 'Choose one of your saved integrations.'
		}
		return input.statusMessage
	}
	if (input.currentStep === 'success') return "You're connected."
	if (input.currentStep === 'setup') {
		return `Create an OAuth app on ${input.config.provider}, register the redirect URL, and paste the credentials below.`
	}
	return `Continue to ${input.config.provider} to approve access.`
}
