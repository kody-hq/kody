/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { type FormEvent } from 'react'
import { SiteLink } from '../components/site-link.tsx'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { CopyCard } from './onboarding-mcp-client-cards.tsx'
import {
	buildChangeIntegrationScopesPrompt,
	formatOauthScopeDisclosureLabel,
	resolveOauthScopeMenu,
} from '#universal/oauth-scopes.ts'
import { buildConnectOauthWhatsNextPrompt } from '#universal/connect-oauth-whats-next.ts'

import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	cardCss,
	cardTitleCss,
	descriptionCss,
	detailValueCss as sourceDetailValueCss,
	fieldCss,
	fieldLabelCss,
	inputCss,
	insetCardCss,
	listCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import {
	type ConnectOauthConfig,
	type ConnectOauthNextSteps,
	type StoredIntegrationConfig,
} from '#client/routes/connect-oauth-config.ts'
import { renderProviderInstructions } from './connect-oauth-detail.tsx'
import { renderReplaceConfirmation } from './connect-oauth-sections.tsx'
import {
	connectOauthAdvancedDetailsCss,
	connectOauthPrimaryButtonCss,
	connectOauthSecondaryButtonCss,
} from './connect-oauth-shared.ts'

function renderScopePicker(input: {
	config: ConnectOauthConfig
	currentStep: 'setup' | 'connect' | 'device' | 'callback' | 'success'
	offeredScopeMenu: Array<string>
	onToggleScope: (scope: string) => void
}) {
	if (input.currentStep !== 'connect') return null
	const currentConfig = input.config
	const menu = resolveOauthScopeMenu({
		allowedScopes:
			currentConfig.platformAllowedScopes.length > 0
				? currentConfig.platformAllowedScopes
				: input.offeredScopeMenu,
		selectedScopes: currentConfig.scopes,
	})
	if (menu.length === 0) return null
	const selectedCount = currentConfig.scopes.length
	const canAddFromMenu = menu.some(
		(scope) => !currentConfig.scopes.includes(scope),
	)
	return (
		<details
			css={connectOauthAdvancedDetailsCss}
			data-testid="connect-oauth-scopes"
		>
			<summary>
				{formatOauthScopeDisclosureLabel({
					selectedCount,
					menuCount: menu.length,
				})}
			</summary>
			<div css={{ display: 'grid', gap: spacing.sm }}>
				<p css={descriptionCss}>
					Unchecked scopes are not requested. Defaults stay selected unless you
					change them.
				</p>
				<ul css={{ ...listCss, listStyle: 'none', paddingLeft: 0 }}>
					{menu.map((scope) => (
						<li key={scope}>
							<label
								css={{
									display: 'flex',
									alignItems: 'flex-start',
									gap: spacing.sm,
									color: colors.text,
									fontSize: typography.fontSize.sm,
								}}
							>
								<input
									type="checkbox"
									checked={currentConfig.scopes.includes(scope)}
									onChange={() => input.onToggleScope(scope)}
								/>
								<code css={detailValueCss}>{scope}</code>
							</label>
						</li>
					))}
				</ul>
				{!canAddFromMenu || currentConfig.platformAllowedScopes.length === 0 ? (
					<div css={{ display: 'grid', gap: spacing.sm }}>
						<p css={descriptionCss}>
							Need access that is not listed? Copy this prompt for your agent.
							It updates the integration&apos;s reconnect scopes, then asks
							whether to reconnect this account.
						</p>
						<CopyTextButton
							value={buildChangeIntegrationScopesPrompt({
								name: currentConfig.providerKey,
								platform: Boolean(currentConfig.platformAppSlug),
								currentScopes: currentConfig.scopes,
								allowedScopes: currentConfig.platformAllowedScopes,
							})}
							idleLabel="Copy scope prompt"
							variant="secondary"
						/>
					</div>
				) : null}
			</div>
		</details>
	)
}

const detailValueCss = sourceDetailValueCss as CSSObject

export function ConnectOauthCredentialsForm(props: {
	config: ConnectOauthConfig
	existingIntegrationConfig: StoredIntegrationConfig | null
	hasStoredClientId: boolean
	hasStoredClientSecret: boolean
	revealStoredClientSecretField: boolean
	clientIdInput: string
	clientSecretInput: string
	submitting: boolean
	onClientIdInput: (value: string) => void
	onClientSecretInput: (value: string) => void
	onRevealStoredClientSecret: () => void
	onSubmit: (event: FormEvent<HTMLFormElement>) => void
}) {
	return (
		<section css={cardCss}>
			<h2 css={cardTitleCss}>
				{props.existingIntegrationConfig
					? 'Confirm your app credentials'
					: 'Enter your app credentials'}
			</h2>
			{renderProviderInstructions({
				config: props.config,
				hasStoredClientSecret: props.hasStoredClientSecret,
			})}
			<form
				method="post"
				{...passwordManagerIgnoreProps}
				css={{ display: 'grid', gap: spacing.md }}
				onSubmit={props.onSubmit}
			>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Client ID</span>
					<input
						name="oauthClientId"
						required
						{...passwordManagerIgnoreProps}
						value={props.clientIdInput}
						css={inputCss}
						onChange={(event) => {
							props.onClientIdInput(event.currentTarget.value)
						}}
					/>
				</label>
				<p css={descriptionCss}>
					{props.hasStoredClientId
						? 'Stored on the OAuth app for this connection.'
						: 'Saved on the OAuth app when you finish connecting.'}
				</p>
				{props.config.flow === 'confidential' ? (
					props.hasStoredClientSecret &&
					!props.revealStoredClientSecretField ? (
						<section css={insetCardCss}>
							<p css={{ margin: 0, color: colors.text }}>
								Using the stored client secret.
							</p>
							<p css={descriptionCss}>
								You can continue without re-entering it.
							</p>
							<button
								type="button"
								css={connectOauthSecondaryButtonCss}
								onClick={() => {
									props.onRevealStoredClientSecret()
								}}
							>
								Replace stored client secret
							</button>
						</section>
					) : (
						<label css={fieldCss}>
							<span css={fieldLabelCss}>Client Secret</span>
							<input
								name="oauthClientSecret"
								type="password"
								required
								{...passwordManagerIgnoreProps}
								value={props.clientSecretInput}
								css={inputCss}
								onChange={(event) => {
									props.onClientSecretInput(event.currentTarget.value)
								}}
							/>
						</label>
					)
				) : null}
				<button
					type="submit"
					disabled={props.submitting}
					css={connectOauthPrimaryButtonCss}
				>
					Save and continue
				</button>
			</form>
		</section>
	)
}

export function renderConnectStep(input: {
	config: ConnectOauthConfig
	existingConnection: Parameters<
		typeof renderReplaceConfirmation
	>[0]['existingConnection']
	replaceConfirmed: boolean
	submitting: boolean
	offeredScopeMenu: Array<string>
	onConfirmReplace: () => void
	onConnect: () => void
	onToggleScope: (scope: string) => void
	wouldReplace: boolean
}) {
	return (
		<section css={cardCss}>
			{renderReplaceConfirmation({
				config: input.config,
				existingConnection: input.existingConnection,
				replaceConfirmed: input.replaceConfirmed,
				submitting: input.submitting,
				onConfirm: input.onConfirmReplace,
			})}
			<p css={{ margin: 0, color: colors.text }}>
				Connecting authorizes your agent — and any code you run or install — to
				act as you on {input.config.provider} with the access you grant. See the{' '}
				<SiteLink href="/terms" target="_blank" rel="noreferrer noopener">
					Terms
				</SiteLink>
				.
			</p>
			{/* The primary button yields to the replace confirmation so a
			    different-app overwrite is never one ambient click away. */}
			{input.wouldReplace && !input.replaceConfirmed ? null : (
				<button
					type="button"
					disabled={input.submitting}
					css={connectOauthPrimaryButtonCss}
					onClick={() => {
						input.onConnect()
					}}
				>
					{input.config.flow === 'device'
						? 'Start device authorization'
						: `Continue to ${input.config.provider}`}
				</button>
			)}
			{input.wouldReplace && !input.replaceConfirmed
				? null
				: renderScopePicker({
						config: input.config,
						currentStep: 'connect',
						offeredScopeMenu: input.offeredScopeMenu,
						onToggleScope: input.onToggleScope,
					})}
		</section>
	)
}

export function renderDeviceStep(input: {
	config: ConnectOauthConfig
	userCode: string
	verificationUri: string
	verificationUriComplete: string | null
	expiresIn: number
	polling: boolean
	errorMessage: string | null
	onRestart: () => void
}) {
	const verificationHref =
		input.verificationUriComplete || input.verificationUri
	const minutes = Math.floor(input.expiresIn / 60)
	const seconds = input.expiresIn % 60
	const expiryLabel =
		input.expiresIn <= 0
			? 'Expired'
			: minutes > 0
				? `${minutes}m ${seconds.toString().padStart(2, '0')}s`
				: `${seconds}s`
	return (
		<section css={cardCss} data-testid="connect-oauth-device-step">
			{input.errorMessage ? (
				<div css={{ display: 'grid', gap: spacing.md }}>
					<p css={{ margin: 0, color: colors.text }}>{input.errorMessage}</p>
					<button
						type="button"
						css={connectOauthPrimaryButtonCss}
						onClick={() => {
							input.onRestart()
						}}
					>
						Start again
					</button>
				</div>
			) : (
				<div css={{ display: 'grid', gap: spacing.md }}>
					<p css={{ margin: 0, color: colors.text }}>
						Enter this code at {input.config.provider} to authorize access.
					</p>
					<div
						css={{
							...insetCardCss,
							display: 'grid',
							gap: spacing.sm,
							justifyItems: 'center',
							textAlign: 'center',
						}}
					>
						<span css={fieldLabelCss}>Your code</span>
						<code
							data-testid="connect-oauth-user-code"
							css={{
								...detailValueCss,
								fontSize: typography.fontSize.xl,
								letterSpacing: '0.08em',
								fontWeight: typography.fontWeight.semibold,
							}}
						>
							{input.userCode}
						</code>
						<CopyTextButton
							value={input.userCode}
							idleLabel="Copy code"
							variant="secondary"
						/>
					</div>
					<p css={descriptionCss}>
						{input.polling
							? 'Waiting for approval…'
							: 'Checking authorization status…'}{' '}
						Code expires in {expiryLabel}.
					</p>
					<a
						href={verificationHref}
						target="_blank"
						rel="noreferrer noopener"
						css={primaryLinkCss}
					>
						Open {input.config.provider} to enter the code
					</a>
					<button
						type="button"
						css={connectOauthSecondaryButtonCss}
						onClick={() => {
							input.onRestart()
						}}
					>
						Cancel
					</button>
				</div>
			)}
		</section>
	)
}

export function renderSuccessCard(input: {
	connectionHref: string
	config: ConnectOauthConfig
	nextSteps: ConnectOauthNextSteps | null
}) {
	return (
		<section css={cardCss}>
			<div
				data-testid="connect-oauth-whats-next"
				css={{ ...insetCardCss, display: 'grid', gap: spacing.sm }}
			>
				<h2 css={cardTitleCss}>What's next?</h2>
				<p css={descriptionCss}>Not sure what to do next? Ask your agent:</p>
				<CopyCard
					label="Prompt"
					value={
						input.nextSteps?.prompt ??
						buildConnectOauthWhatsNextPrompt({
							service: input.config.providerKey,
							connectionName: input.config.providerKey,
						})
					}
					copyLabel="Copy prompt"
				/>
			</div>
			<SiteLink href={input.connectionHref} css={primaryLinkCss}>
				View this connection
			</SiteLink>
		</section>
	)
}
