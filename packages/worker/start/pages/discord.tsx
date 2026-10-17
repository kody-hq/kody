/** @jsxImportSource @emotion/react */
import { ErrorAgentPromptButton } from '../components/error-agent-prompt-button.tsx'
import { buildErrorAgentPrompt } from '#universal/error-agent-prompt.ts'
import { usePageInvalidation } from '../page-invalidation.ts'
import { SiteLink } from '../components/site-link.tsx'
import { type CSSObject } from '@emotion/react'
import { useEffect, useState } from 'react'
import { useSocialSignIn } from '../social-sign-in.ts'
import { syncDiscordMemberRole } from '#start/server/account-mutations'
import {
	emptyPublicFormProtection,
	readPublicFormProtection,
	renderTurnstileWidgets,
	resetTurnstileWidgets,
	turnstileWidgetClassName,
} from '#client/public-form-protection.ts'
import { getOauthLoginErrorMessage } from '#universal/oauth-login-errors.ts'
import { type DiscordPageLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { colors, spacing } from '#universal/styles/tokens.ts'
import {
	cardCss,
	descriptionCss,
	getGhostButtonCss,
	getPrimaryButtonCss,
	mutedLinkCss,
	pageDescriptionCss,
	pageHeaderCss,
	pageTitleCss,
	stackedPageCss,
} from '#universal/styles/style-primitives.ts'
import { honeypotFieldName } from '#universal/public-form-protection.ts'
import { passwordManagerIgnoreProps } from '#client/password-manager-ignore.ts'

const discordPath = routes.discord.href()

type DiscordPageMessage = {
	text: string
	tone: 'error' | 'info'
	oauthErrorCode?: string | null
}

function readCallbackMessage(href: string): DiscordPageMessage | null {
	const searchParams = new URL(href, 'http://localhost').searchParams
	const linkedProvider = searchParams.get('oauthLinked')
	if (linkedProvider === 'discord') {
		return {
			text: 'Discord connected.',
			tone: 'info',
		}
	}
	const oauthErrorCode = searchParams.get('oauthError')
	const error = getOauthLoginErrorMessage(oauthErrorCode)
	if (error) {
		return { text: error, tone: 'error', oauthErrorCode }
	}
	return null
}

function discordErrorAgentPrompt(input: {
	errorMessage: string
	oauthErrorCode?: string | null
}) {
	return buildErrorAgentPrompt({
		activity: 'Connecting Discord on /discord.',
		errorCode: input.oauthErrorCode ?? 'discord_error',
		errorMessage: input.errorMessage,
		ids: { path: '/discord', provider: 'discord' },
		likelyCause:
			'OAuth callback failed, Discord is not configured, or the connection status could not be loaded.',
		nextSteps: [
			'Open guide:oauth and retry the Discord connect from /discord.',
			'Tell me whether to reconnect Discord or check provider configuration.',
		],
		kodyTools: ['search({ entity: "guide:oauth" })'],
		docs: ['search({ entity: "guide:oauth" })'],
	})
}

function discordMemberRoleMessage(status: string) {
	switch (status) {
		case 'assigned':
			return 'Kody Discord roles updated.'
		case 'not-in-guild':
			return 'You are not in the Kody Discord yet.'
		case 'not-configured':
		case 'skipped':
			return 'Discord role sync is not configured.'
		case 'forbidden':
			return 'Kody could not update your Discord roles. Please try again later.'
		default:
			return 'Unable to sync Discord roles.'
	}
}

export function DiscordPage({
	page,
	currentHref,
}: {
	page: DiscordPageLoaderData
	currentHref: string
}) {
	const startSocialSignIn = useSocialSignIn()
	const invalidatePages = usePageInvalidation(mutationResources)
	const [busy, setBusy] = useState(false)
	const [actionMessage, setActionMessage] = useState<DiscordPageMessage | null>(
		null,
	)
	const turnstileSiteKey = page.turnstileSiteKey
	useEffect(() => {
		if (!page.signedIn && turnstileSiteKey)
			renderTurnstileWidgets(turnstileSiteKey)
	}, [page.signedIn, turnstileSiteKey])

	async function handleConnectDiscord() {
		setBusy(true)
		setActionMessage(null)
		try {
			const connectForm = document.querySelector<HTMLFormElement>(
				'form[data-discord-connect-form]',
			)
			const protection =
				page?.signedIn || !connectForm
					? emptyPublicFormProtection()
					: readPublicFormProtection(new FormData(connectForm), connectForm)
			const errorMessage = await startSocialSignIn(
				'discord',
				discordPath,
				protection,
			)
			if (errorMessage) {
				setActionMessage({ text: errorMessage, tone: 'error' })
				setBusy(false)
				resetTurnstileWidgets()
			}
		} catch {
			setActionMessage({
				text: 'Network error. Please try again.',
				tone: 'error',
			})
			setBusy(false)
			resetTurnstileWidgets()
		}
	}

	async function handleSyncRoles() {
		setBusy(true)
		setActionMessage(null)
		try {
			const payload = await syncDiscordMemberRole({
				data: {},
			})
			void invalidatePages()
			const syncStatus =
				('discordMemberRole' in payload
					? payload.discordMemberRole?.status
					: undefined) ?? 'error'
			setActionMessage({
				text: discordMemberRoleMessage(syncStatus),
				tone:
					syncStatus === 'assigned' || syncStatus === 'not-in-guild'
						? 'info'
						: 'error',
			})
		} catch (error) {
			setActionMessage({
				text:
					error instanceof Error
						? error.message
						: 'Unable to sync Discord roles.',
				tone: 'error',
			})
		} finally {
			setBusy(false)
		}
	}

	const message = actionMessage ?? readCallbackMessage(currentHref)

	const showConnect =
		page != null &&
		page.discordProviderAvailable &&
		(!page.signedIn || !page.discordConnected)

	return (
		<section css={pageCss}>
			<header css={pageHeaderCss}>
				<h1 css={titleCss}>
					{renderDiscordIcon('1em')}
					Discord
				</h1>
				<p css={pageDescriptionCss}>
					Connect Discord to join the official Kody server and get the member
					role, plus a plan role if you subscribe.
				</p>
			</header>

			{message ? (
				<>
					<p
						role={message.tone === 'error' ? 'alert' : 'status'}
						css={{
							...descriptionCss,
							color:
								message.tone === 'error' ? colors.danger : colors.textMuted,
						}}
					>
						{message.text}
					</p>
					{message.tone === 'error' ? (
						<ErrorAgentPromptButton
							prompt={discordErrorAgentPrompt({
								errorMessage: message.text,
								oauthErrorCode: message.oauthErrorCode,
							})}
						/>
					) : null}
				</>
			) : null}

			<section css={cardCss}>
				{page?.signedIn && page.discordConnected ? (
					<>
						<p css={descriptionCss}>
							Your Kody account is already connected
							{page.discordDisplayName ? ` as ${page.discordDisplayName}` : ''}.
							You can manage connections from{' '}
							<SiteLink href={routes.account.href()} css={mutedLinkCss}>
								your account
							</SiteLink>
							.
						</p>
						{page.canSyncDiscordRoles ? (
							<button
								type="button"
								disabled={busy}
								css={{
									...getGhostButtonCss(),
									justifySelf: 'start',
								}}
								onClick={handleSyncRoles}
							>
								Sync Discord roles
							</button>
						) : null}
					</>
				) : null}
				{page?.signedIn &&
				!page.discordConnected &&
				page.discordProviderAvailable ? (
					<p css={descriptionCss}>
						Connect Discord to join the official server and link it to this Kody
						account.
					</p>
				) : null}
				{page && !page.signedIn && page.discordProviderAvailable ? (
					<p css={descriptionCss}>
						Connect Discord to create or match your Kody account and join the
						official server in one step.
					</p>
				) : null}
				{page && !page.discordProviderAvailable ? (
					<p css={descriptionCss}>
						Discord login is not configured on this deployment yet.
					</p>
				) : null}
				{showConnect && page && !page.signedIn ? (
					<form
						method="post"
						data-discord-connect-form
						css={connectFormCss}
						onSubmit={(event) => {
							event.preventDefault()
							void handleConnectDiscord()
						}}
					>
						<input
							type="text"
							name={honeypotFieldName}
							tabIndex={-1}
							aria-hidden="true"
							readOnly
							{...passwordManagerIgnoreProps}
							css={{
								position: 'absolute',
								left: '-10000px',
								width: '1px',
								height: '1px',
								overflow: 'hidden',
							}}
						/>
						{turnstileSiteKey ? (
							<div className={turnstileWidgetClassName}></div>
						) : null}
						<button type="submit" disabled={busy} css={connectButtonCss}>
							Connect Discord
						</button>
					</form>
				) : null}
				{showConnect && page?.signedIn ? (
					<button
						type="button"
						disabled={busy}
						css={connectButtonCss}
						onClick={handleConnectDiscord}
					>
						Connect Discord
					</button>
				) : null}
			</section>
		</section>
	)
}

const pageCss: CSSObject = {
	...stackedPageCss,
	maxWidth: '28rem',
	margin: '0 auto',
}

const titleCss: CSSObject = {
	...pageTitleCss,
	display: 'flex',
	alignItems: 'center',
	gap: '0.35em',
}

const connectButtonCss: CSSObject = {
	...getPrimaryButtonCss({ size: 'lg', weight: 'semibold' }),
	justifySelf: 'start' as const,
}

const connectFormCss: CSSObject = {
	display: 'grid',
	gap: spacing.sm,
	justifyItems: 'start' as const,
}

function renderDiscordIcon(size: string) {
	// Clyde sits with more padding than the other 24×24 marks, so crop the
	// viewBox so it optically matches GitHub/Google/X at the same size.
	return (
		<svg
			viewBox="0 2.25 24 19.5"
			width={size}
			height={size}
			aria-hidden="true"
			fill="#5865F2"
		>
			<path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
		</svg>
	)
}

const mutationResources = ['loadDiscord', 'loadAccountPage'] as const
