/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { toast } from '#client/toast.ts'
import {
	revokeConnectedApp,
	revokeConnectedAppAgent,
	revokeConnectedAppScope,
} from '#start/server/account-mutations'
import { groupConnectedAgents } from '#universal/connected-mcp-agents.ts'
import {
	type AccountConnectedAppsLoaderData,
	type AccountConnectedAppView,
} from '#universal/loader-data.ts'
import {
	getDangerPillCss,
	getLogoWellCss,
	getSwapLabelCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { renderIcon } from '../components/icon.tsx'
import { usePageInvalidation } from '../page-invalidation.ts'
import { publicAsset } from '../public-assets.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	TimestampValue,
} from './account-management-components.tsx'

/**
 * `/account/connected-apps`: what can act with this person's Kody identity.
 * Package apps they signed in to with Kody, and agents they connected. Each
 * can be revoked. Raw ids stay out of the page.
 */
export function AccountConnectedAppsPage({
	payload,
	currentHref,
}: {
	payload: AccountConnectedAppsLoaderData
	currentHref: string
}) {
	const capture = useSubmitterScope()
	const invalidate = usePageInvalidation('permissions')
	const [removedApps, setRemovedApps] = useState<ReadonlySet<string>>(
		() => new Set(),
	)
	const [removedAgents, setRemovedAgents] = useState<ReadonlySet<string>>(
		() => new Set(),
	)
	const [armed, setArmed] = useState<string | null>(null)
	const appMutation = useMutation({
		gcTime: 0,
		mutationFn: (appKey: string) => revokeConnectedApp({ data: { appKey } }),
		onMutate: () => invalidate,
		onSettled: (_result, _error, _input, reconcile) => reconcile?.(),
	})
	const agentMutation = useMutation({
		gcTime: 0,
		mutationFn: (clientId: string) =>
			revokeConnectedAppAgent({ data: { clientId } }),
		onMutate: () => invalidate,
		onSettled: (_result, _error, _input, reconcile) => reconcile?.(),
	})
	const scopeMutation = useMutation({
		gcTime: 0,
		mutationFn: (input: { appKey: string; scope: string }) =>
			revokeConnectedAppScope({ data: input }),
		onMutate: () => invalidate,
		onSettled: (_result, _error, _input, reconcile) => reconcile?.(),
	})
	const apps = payload.apps.filter((app) => !removedApps.has(app.appKey))
	const agentGroups = groupConnectedAgents(
		payload.agents.filter((agent) => !removedAgents.has(agent.clientId)),
	)

	function revokeApp(app: AccountConnectedAppView) {
		setArmed(null)
		const isCurrent = capture()
		setRemovedApps((current) => new Set(current).add(app.appKey))
		void appMutation.mutateAsync(app.appKey).then(
			() => {
				if (isCurrent())
					toast.success(`${app.appName} can no longer use your Kody account.`)
			},
			(error: unknown) => {
				setRemovedApps((current) => {
					const next = new Set(current)
					next.delete(app.appKey)
					return next
				})
				if (isCurrent()) {
					toast.error(
						error instanceof Error ? error.message : 'Unable to revoke.',
					)
				}
			},
		)
	}

	function revokeAgent(clientIds: ReadonlyArray<string>, label: string) {
		setArmed(null)
		const isCurrent = capture()
		setRemovedAgents((current) => {
			const next = new Set(current)
			for (const clientId of clientIds) next.add(clientId)
			return next
		})
		void Promise.all(
			clientIds.map((clientId) => agentMutation.mutateAsync(clientId)),
		).then(
			() => {
				if (isCurrent()) toast.success(`${label} disconnected.`)
			},
			(error: unknown) => {
				setRemovedAgents((current) => {
					const next = new Set(current)
					for (const clientId of clientIds) next.delete(clientId)
					return next
				})
				if (isCurrent()) {
					toast.error(
						error instanceof Error ? error.message : 'Unable to disconnect.',
					)
				}
			},
		)
	}

	function revokeAppScope(app: AccountConnectedAppView, scope: string) {
		const isCurrent = capture()
		void scopeMutation.mutateAsync({ appKey: app.appKey, scope }).then(
			() => {
				if (isCurrent()) toast.success('That access has been revoked.')
			},
			(error: unknown) => {
				if (isCurrent())
					toast.error(
						error instanceof Error ? error.message : 'Unable to revoke.',
					)
			},
		)
	}

	return (
		<AccountManagementShell layout="form" currentHref={currentHref}>
			<AccountPageHeader
				title="Connected apps"
				description="Apps you signed in to with Kody, and agents you connected. Revoke one to stop it from using your Kody account."
				currentHref={currentHref}
			/>
			<AccountManagementPanel
				title="Apps you signed in to"
				description="Package apps that know who you are through Sign in with Kody. An app runs with its publisher's credentials; it uses your own data or credentials only where you allowed it."
				ariaLabel="Apps you signed in to"
			>
				{apps.length > 0 ? (
					<ul css={listCss} data-testid="connected-apps-list">
						{apps.map((app) => {
							const armKey = `app:${app.appKey}`
							return (
								<li key={app.appKey} css={rowCss} data-testid="connected-app">
									<AppMark iconUrl={app.iconUrl} />
									<div css={rowBodyCss}>
										<span css={rowTitleCss}>{app.appName}</span>
										<span css={mutedCss}>By {app.publisherName}</span>
										<ul css={allowsCss} aria-label={`${app.appName} can`}>
											{app.allows.map((allow) => (
												<li key={allow}>{allow}</li>
											))}
										</ul>
										{app.revocableScopes.filter(({ scope }) =>
											isOptionalScope(scope),
										).length > 0 ? (
											<ul css={scopeListCss}>
												{app.revocableScopes
													.filter(({ scope }) => isOptionalScope(scope))
													.map(({ scope, label }) => (
														<li key={scope} css={scopeRowCss}>
															<span>{label}</span>
															<button
																type="button"
																aria-label={`Revoke ${label}`}
																css={dangerButtonCss}
																onClick={() => {
																	if (window.confirm(`Revoke ${label}?`))
																		revokeAppScope(app, scope)
																}}
															>
																Revoke
															</button>
														</li>
													))}
											</ul>
										) : null}
										<span css={mutedCss}>
											Last used{' '}
											<TimestampValue value={app.lastUsedAt} fallback="never" />
											{' · '}
											Signed in <TimestampValue value={app.connectedAt} />
										</span>
									</div>
									<RevokeButton
										name={app.appName}
										armed={armed === armKey}
										onArm={() => setArmed(armKey)}
										onDisarm={() => setArmed(null)}
										onConfirm={() => revokeApp(app)}
									/>
								</li>
							)
						})}
					</ul>
				) : (
					<p css={emptyCss}>
						You have not signed in to any package apps with Kody.
					</p>
				)}
			</AccountManagementPanel>
			<AccountManagementPanel
				title="Agents"
				description="AI hosts you connected to Kody over MCP, in any of your organizations. Revoking one disconnects it everywhere."
				ariaLabel="Connected agents"
			>
				{payload.agentsUnavailable ? (
					<p css={emptyCss}>Connected agents could not load. Try again soon.</p>
				) : agentGroups.length > 0 ? (
					<ul css={listCss} data-testid="connected-app-agents-list">
						{agentGroups.map((group) => {
							const armKey = `agent:${group.label}`
							return (
								<li
									key={group.label}
									css={rowCss}
									data-testid="connected-app-agent"
								>
									<AgentMark icon={group.icon} />
									<div css={rowBodyCss}>
										<span css={rowTitleCss}>
											{group.label}
											{group.members.length > 1
												? ` (${group.members.length} connections)`
												: ''}
										</span>
										<span css={mutedCss}>
											Last used{' '}
											<TimestampValue
												value={group.lastUsedAt}
												fallback="unknown"
											/>
											{' · '}
											Connected{' '}
											<TimestampValue
												value={group.connectedAt}
												fallback="at an unknown time"
											/>
										</span>
									</div>
									<RevokeButton
										name={group.label}
										armed={armed === armKey}
										onArm={() => setArmed(armKey)}
										onDisarm={() => setArmed(null)}
										onConfirm={() =>
											revokeAgent(
												group.members.map((member) => member.clientId),
												group.label,
											)
										}
									/>
								</li>
							)
						})}
					</ul>
				) : (
					<p css={emptyCss}>No agents are connected to your Kody account.</p>
				)}
			</AccountManagementPanel>
		</AccountManagementShell>
	)
}

function RevokeButton(props: {
	name: string
	armed: boolean
	onArm: () => void
	onDisarm: () => void
	onConfirm: () => void
}) {
	return (
		<button
			type="button"
			aria-label={
				props.armed ? `Confirm revoke ${props.name}` : `Revoke ${props.name}`
			}
			css={dangerButtonCss}
			onBlur={props.onDisarm}
			onClick={() => {
				if (props.armed) props.onConfirm()
				else props.onArm()
			}}
		>
			<span
				data-swap-label
				data-active={props.armed ? undefined : true}
				aria-hidden={props.armed ? 'true' : undefined}
			>
				Revoke
			</span>
			<span
				data-swap-label
				data-active={props.armed ? true : undefined}
				aria-hidden={props.armed ? undefined : 'true'}
			>
				Confirm revoke
			</span>
		</button>
	)
}

function AppMark({ iconUrl }: { iconUrl: string | null }) {
	return (
		<span
			aria-hidden="true"
			css={getLogoWellCss({ size: '2.25rem', radius: radius.md })}
		>
			{iconUrl ? (
				<img src={iconUrl} alt="" width={24} height={24} css={markImageCss} />
			) : (
				renderIcon('box', { size: '18' })
			)}
		</span>
	)
}

function isOptionalScope(scope: string) {
	return scope === 'email' || (scope.startsWith('need:') && scope.length > 5)
}

function AgentMark({ icon }: { icon: string | null }) {
	return (
		<span
			aria-hidden="true"
			css={getLogoWellCss({ size: '2.25rem', radius: radius.md })}
		>
			{icon ? (
				<img
					src={publicAsset(`/images/icons/${icon}.svg`)}
					alt=""
					width={20}
					height={20}
					css={markImageCss}
				/>
			) : (
				renderIcon('dots-horizontal', { size: '18' })
			)}
		</span>
	)
}

const listCss: CSSObject = {
	listStyle: 'none',
	padding: 0,
	margin: 0,
	display: 'grid',
	gap: spacing.lg,
}

const rowCss: CSSObject = {
	display: 'grid',
	gridTemplateColumns: 'auto minmax(0, 1fr) auto',
	alignItems: 'start',
	gap: spacing.md,
}

const rowBodyCss: CSSObject = {
	display: 'grid',
	gap: spacing.xs,
	minWidth: 0,
}

const rowTitleCss: CSSObject = {
	color: colors.text,
	fontWeight: typography.fontWeight.medium,
	overflowWrap: 'anywhere',
}

const mutedCss: CSSObject = {
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const allowsCss: CSSObject = {
	margin: 0,
	paddingInlineStart: spacing.lg,
	color: colors.text,
	fontSize: typography.fontSize.sm,
	display: 'grid',
	gap: '0.15rem',
}

const scopeListCss: CSSObject = {
	display: 'grid',
	gap: spacing.xs,
	listStyle: 'none',
	margin: 0,
	padding: 0,
	fontSize: typography.fontSize.sm,
}

const scopeRowCss: CSSObject = {
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'space-between',
	gap: spacing.sm,
}

const emptyCss: CSSObject = { color: colors.textMuted, margin: 0 }

const markImageCss: CSSObject = {
	display: 'block',
	width: '1.35rem',
	height: '1.35rem',
	objectFit: 'contain',
}

const dangerButtonCss = [getDangerPillCss({ size: 'sm' }), getSwapLabelCss()]
