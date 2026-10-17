/** @jsxImportSource @emotion/react */
import {
	disconnectAccountProvider,
	syncDiscordMemberRole as syncDiscordRole,
} from '#start/server/account-mutations'
import { type loadAccountPage } from '#start/server/account-page'
import { kodyDiscordInviteUrl } from '#universal/community-links.ts'
import { type AccountConnectionsLoaderData } from '#universal/loader-data.ts'
import { getOauthLoginErrorMessage } from '#universal/oauth-login-errors.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
	mutedLinkCss,
} from '#universal/styles/style-primitives.ts'
import { colors, spacing, typography } from '#universal/styles/tokens.ts'
import {
	useIsMutating,
	useMutation,
	useQueryClient,
} from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { useState } from 'react'
import { ProviderIcon } from '../components/provider-icons.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	settleAccountMutation,
	accountConnectionResources,
} from './account-mutation-settlement.ts'
import { pageResourceKey } from '../page-query-scope.ts'
import { useSocialSignIn } from '../social-sign-in.ts'
import { AccountManagementPanel } from './account-management-components.tsx'

const providerLabels: Record<string, string> = {
	github: 'GitHub',
	google: 'Google',
	x: 'X',
	discord: 'Discord',
}

/** One-shot message from the OAuth callback redirect query params. */
function readConnectionCallbackMessage(href: string) {
	const searchParams = new URL(href, 'http://localhost').searchParams
	const linkedProvider = searchParams.get('oauthLinked')
	if (linkedProvider) {
		return {
			text: `${providerLabels[linkedProvider] ?? linkedProvider} connected.`,
			tone: 'info' as const,
		}
	}
	const errorMessage = getOauthLoginErrorMessage(searchParams.get('oauthError'))
	if (errorMessage) {
		return { text: errorMessage, tone: 'error' as const }
	}
	return null
}

function discordMemberRoleMessage(status: string) {
	switch (status) {
		case 'assigned':
			return 'Kody Discord roles updated.'
		case 'not-in-guild':
			return 'Join the Kody Discord first, then sync your roles.'
		case 'not-configured':
		case 'skipped':
			return 'Discord role sync is not configured.'
		case 'forbidden':
			return 'Kody could not update your Discord roles. Please try again later.'
		default:
			return 'Unable to sync Discord roles.'
	}
}

export function useAccountConnections(
	initial: AccountConnectionsLoaderData,
	href: string,
) {
	const startSocialSignIn = useSocialSignIn()
	const queryClient = useQueryClient()
	const { actorKey } = useRouteContext({ from: '__root__' })
	const [connecting, setConnectionsBusy] = useState(false)
	const {
		connections,
		canDisconnect,
		hasUsablePassword,
		availableProviders,
		canSyncDiscordRoles,
	} = initial
	const capture = useSubmitterScope()
	const options = {
		mutationKey: ['accountConnections', actorKey],
		gcTime: 0,
		onMutate: () => ({ actorKey }),
		onSettled: (
			_data: unknown,
			_error: Error | null,
			_input: unknown,
			submitted: { actorKey: string | null } | undefined,
		) =>
			submitted
				? settleAccountMutation(
						queryClient,
						submitted.actorKey,
						accountConnectionResources,
					)
				: undefined,
	}
	const syncMutation = useMutation({ ...options, mutationFn: syncDiscordRole })
	const disconnectMutation = useMutation({
		...options,
		mutationFn: disconnectAccountProvider,
	})
	const pendingConnections =
		useIsMutating({ mutationKey: ['accountConnections', actorKey] }) > 0
	const connectionsBusy = connecting || pendingConnections

	const [connectionsMessage, setConnectionsMessage] = useState<{
		text: string
		tone: 'error' | 'info'
	} | null>(readConnectionCallbackMessage(href))

	async function connectProvider(providerId: string) {
		setConnectionsBusy(true)
		setConnectionsMessage(null)
		try {
			const errorMessage = await startSocialSignIn(providerId, null)
			if (errorMessage) {
				setConnectionsMessage({ text: errorMessage, tone: 'error' })
				setConnectionsBusy(false)
			}
			// On success the browser is navigating to the provider; keep the
			// busy state until the page unloads.
		} catch {
			setConnectionsMessage({
				text: 'Network error. Please try again.',
				tone: 'error',
			})
			setConnectionsBusy(false)
		}
	}

	function syncDiscordMemberRole() {
		if (
			queryClient.isMutating({ mutationKey: ['accountConnections', actorKey] })
		)
			return
		const isCurrent = capture()
		setConnectionsMessage(null)
		syncMutation.mutate(
			{ data: {} },
			{
				onSuccess: (payload) => {
					if (!isCurrent()) return
					const status =
						('discordMemberRole' in payload
							? payload.discordMemberRole?.status
							: undefined) ?? 'error'
					setConnectionsMessage({
						text: discordMemberRoleMessage(status),
						tone:
							status === 'assigned' || status === 'not-in-guild'
								? 'info'
								: 'error',
					})
				},
				onError: (error) =>
					isCurrent() &&
					setConnectionsMessage({ text: error.message, tone: 'error' }),
			},
		)
	}
	function disconnectProvider(providerId: string) {
		if (
			queryClient.isMutating({ mutationKey: ['accountConnections', actorKey] })
		)
			return
		if (
			providerId !== 'github' &&
			providerId !== 'google' &&
			providerId !== 'x' &&
			providerId !== 'discord'
		)
			return
		const isCurrent = capture()
		setConnectionsMessage(null)
		disconnectMutation.mutate(
			{ data: { provider: providerId } },
			{
				onSuccess: () =>
					isCurrent() &&
					setConnectionsMessage({
						text: `${providerLabels[providerId] ?? providerId} disconnected.`,
						tone: 'info',
					}),
				onError: (error) =>
					isCurrent() &&
					setConnectionsMessage({ text: error.message, tone: 'error' }),
			},
		)
	}

	return {
		get hasUsablePassword() {
			return hasUsablePassword
		},
		markHasUsablePassword() {
			queryClient.setQueriesData<Awaited<ReturnType<typeof loadAccountPage>>>(
				{ queryKey: pageResourceKey(actorKey, 'loadAccountPage') },
				(page) =>
					page
						? {
								...page,
								payloads: {
									...page.payloads,
									accountConnections: {
										...page.payloads.accountConnections,
										hasUsablePassword: true,
										canDisconnect: true,
									},
								},
							}
						: page,
			)
		},
		setMessage(next: { text: string; tone: 'error' | 'info' } | null) {
			setConnectionsMessage(next ?? connectionsMessage)
		},
		render() {
			return renderPanel()
		},
	}

	function renderPanel() {
		const onConnectProvider = (providerId: string) =>
			void connectProvider(providerId)
		const onDisconnectProvider = (providerId: string) =>
			void disconnectProvider(providerId)
		const onSyncDiscordMemberRole = () => void syncDiscordMemberRole()
		return (
			<AccountManagementPanel
				title="Connected accounts"
				description="Sign in with GitHub, Google, X, or Discord by connecting them to this account. Connections with the same verified email also link automatically at sign-in."
				ariaLabel="Connected accounts"
			>
				{connectionsMessage ? (
					<p
						role="status"
						css={{
							color:
								connectionsMessage.tone === 'error'
									? colors.error
									: colors.text,
							margin: 0,
						}}
					>
						{connectionsMessage.text}
					</p>
				) : null}
				<div css={{ display: 'grid', gap: spacing.md }}>
					{connections.length > 0 ? (
						<ul
							css={{
								listStyle: 'none',
								padding: 0,
								margin: 0,
								display: 'grid',
								gap: spacing.md,
							}}
						>
							{connections.map((connection) => (
								<li
									key={connection.provider}
									css={{
										display: 'flex',
										justifyContent: 'space-between',
										alignItems: 'center',
										gap: spacing.md,
										flexWrap: 'wrap',
									}}
								>
									<span css={{ display: 'grid', gap: spacing.xs }}>
										<span
											css={{
												display: 'inline-flex',
												alignItems: 'center',
												gap: spacing.sm,
												fontWeight: typography.fontWeight.medium,
												color: colors.text,
											}}
										>
											<ProviderIcon providerId={connection.provider} />
											{connection.label}
										</span>
										<span
											css={{
												color: colors.textMuted,
												fontSize: typography.fontSize.sm,
											}}
										>
											{connection.displayName
												? `Connected as ${connection.displayName}`
												: 'Connected'}
										</span>
										{connection.provider === 'discord' ? (
											<SiteLink
												href={kodyDiscordInviteUrl}
												target="_blank"
												rel="noreferrer"
												css={mutedLinkCss}
											>
												Join the Kody Discord
											</SiteLink>
										) : null}
									</span>
									<span
										css={{
											display: 'flex',
											gap: spacing.sm,
											flexWrap: 'wrap',
										}}
									>
										{connection.provider === 'discord' &&
										canSyncDiscordRoles ? (
											<button
												type="button"
												disabled={connectionsBusy}
												css={compactGhostButtonCss}
												onClick={onSyncDiscordMemberRole}
											>
												Sync Discord roles
											</button>
										) : null}
										<button
											type="button"
											disabled={connectionsBusy || !canDisconnect}
											title={
												canDisconnect
													? undefined
													: 'This connection is your only way to sign in. Set a password or register a passkey first.'
											}
											css={dangerButtonCss}
											onClick={() => onDisconnectProvider(connection.provider)}
										>
											Disconnect
										</button>
									</span>
								</li>
							))}
						</ul>
					) : (
						<p css={{ color: colors.textMuted, margin: 0 }}>
							No accounts connected yet.
						</p>
					)}
					{availableProviders.length > 0 ? (
						<div
							css={{
								display: 'flex',
								gap: spacing.md,
								flexWrap: 'wrap',
							}}
						>
							{availableProviders.map((provider) => (
								<button
									key={provider.id}
									type="button"
									disabled={connectionsBusy}
									css={compactGhostButtonCss}
									onClick={() => onConnectProvider(provider.id)}
								>
									<ProviderIcon providerId={provider.id} />
									Connect {provider.label}
								</button>
							))}
						</div>
					) : null}
				</div>
			</AccountManagementPanel>
		)
	}
}

const compactGhostButtonCss = getGhostButtonCss({ size: 'sm' })

const dangerButtonCss = getDangerPillCss({ size: 'sm' })
