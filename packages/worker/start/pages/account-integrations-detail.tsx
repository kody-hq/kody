/** @jsxImportSource @emotion/react */
import { formatTimestamp } from '../components/local-timestamp.tsx'
import {
	type AccountIntegrationListItem,
	type AccountOauthAppListItem,
} from '#universal/loader-data.ts'
import { type ReactNode } from 'react'
import { type CSSObject } from '@emotion/react'
import { SiteLink } from '../components/site-link.tsx'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { ProviderMark } from '../components/provider-icons.tsx'
import { renderIcon } from '../components/icon.tsx'
import { accountDisclosureCss } from './account-management-components.tsx'
import { recordBodyCss, recordCellClamp } from './record-table.tsx'
import {
	buildAddAccountHref,
	isAddAccountFormOpen,
} from '#client/routes/integration-provider-catalog.ts'
import { integrationDisplayName } from '#client/routes/integration-filter.ts'
import { buildConnectOauthHref } from '#universal/oauth-connect.ts'
import {
	buildChangeIntegrationScopesPrompt,
	formatOauthScopeSummary,
	resolveOauthScopeMenu,
} from '#universal/oauth-scopes.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	cardTitleCss,
	descriptionCss,
	detailGridCss,
	detailItemCss,
	detailLabelCss,
	detailValueCss,
	getAccentCalloutCss,
	getPillButtonCss,
	hoverMq,
	insetCardCss,
	primaryLinkCss,
	sectionTitleCss,
} from '#universal/styles/style-primitives.ts'
import {
	type IntegrationUsageDraft,
	accountsConnectedCopy,
	connectActionLabel,
	connectionLabel,
	connectionStatusLabel,
	dangerButtonCss,
	shouldShowReconnectAction,
	formatList,
	formatOptional,
	hostFromUrl,
	integrationsRoute,
	isBuiltInApp,
	oauthAppTitle,
} from './account-integrations-shared.ts'
import {
	AddAccountForm,
	ConnectionUsageForm,
	RotateCredentialsForm,
} from './account-integrations-forms.tsx'

const clampedCellCss = recordCellClamp(26)

function renderIntegrationDetail(label: string, value: ReactNode) {
	return (
		<div css={detailItemCss}>
			<span css={detailLabelCss}>{label}</span>
			<span
				css={{
					...detailValueCss,
					display: 'block',
					overflowWrap: 'anywhere',
					whiteSpace: 'normal',
				}}
			>
				{value}
			</span>
		</div>
	)
}

function BuiltInIcon() {
	return renderIcon('key', { size: '100%' })
}

function renderBuiltInIndicator(input?: { tooltipId?: string }) {
	const tooltipId = input?.tooltipId
	if (!tooltipId) {
		return (
			<span
				data-testid="built-in-indicator"
				role="img"
				aria-label="Provided by Kody"
				title="Provided by Kody"
				css={builtInBadgeCss}
			>
				{BuiltInIcon()}
			</span>
		)
	}
	return (
		<button
			type="button"
			data-testid="built-in-indicator"
			aria-label="Provided by Kody"
			css={builtInIndicatorCss}
		>
			{BuiltInIcon()}
			<span id={tooltipId} role="tooltip" aria-hidden="true">
				Provided by Kody
			</span>
		</button>
	)
}

export function renderNamedProvider(input: {
	providerKey: string
	label: string
	logoPath?: string | null
	autoLogoPath?: string | null
	catalogLogoPath?: string | null
	host?: string | null
	builtIn?: boolean
}) {
	return (
		<span
			css={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: spacing.sm,
				minWidth: 0,
			}}
		>
			<ProviderMark
				providerKey={input.providerKey}
				label={input.label}
				logoPath={input.logoPath}
				autoLogoPath={input.autoLogoPath}
				catalogLogoPath={input.catalogLogoPath}
				host={input.host}
				size="1.75rem"
			/>
			<span css={clampedCellCss}>{input.label}</span>
			{input.builtIn ? renderBuiltInIndicator() : null}
		</span>
	)
}

function renderAdvancedDetails(body: ReactNode) {
	return (
		<details css={advancedDetailsCss} data-testid="integration-advanced">
			<summary>Advanced details</summary>
			<div css={{ display: 'grid', gap: spacing.md }}>{body}</div>
		</details>
	)
}

export const advancedDetailsCss: CSSObject = {
	...accountDisclosureCss,
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const builtInBadgeCss: CSSObject = {
	display: 'inline-grid',
	placeContent: 'center',
	boxSizing: 'border-box' as const,
	width: '1.35rem',
	height: '1.35rem',
	padding: '0.22rem',
	overflow: 'hidden',
	flex: 'none',
	borderRadius: radius.full,
	border: `1px solid ${colors.primary}`,
	backgroundColor: colors.primarySoft,
	color: colors.primaryText,
}

const builtInIndicatorCss: CSSObject = {
	position: 'relative' as const,
	display: 'inline-grid',
	placeContent: 'center',
	boxSizing: 'border-box' as const,
	width: '1.35rem',
	height: '1.35rem',
	padding: '0.22rem',
	appearance: 'none' as const,
	font: 'inherit',
	flex: 'none',
	borderRadius: radius.full,
	border: `1px solid ${colors.primary}`,
	backgroundColor: colors.primarySoft,
	color: colors.primaryText,
	cursor: 'help',
	'& [role="tooltip"]': {
		position: 'absolute' as const,
		left: '50%',
		bottom: 'calc(100% + 0.45rem)',
		transform: 'translateX(-50%)',
		width: 'max-content',
		maxWidth: 'min(16rem, calc(100vw - 2rem))',
		padding: `${spacing.xs} ${spacing.sm}`,
		borderRadius: radius.md,
		backgroundColor: colors.surface,
		color: colors.text,
		fontSize: typography.fontSize.sm,
		fontWeight: 400,
		lineHeight: 1.4,
		textAlign: 'left' as const,
		boxShadow: shadows.md,
		border: `1px solid ${colors.border}`,
		pointerEvents: 'none' as const,
		opacity: 0,
		visibility: 'hidden' as const,
		zIndex: 3,
	},
	'& [role="tooltip"]::after': {
		content: '""',
		position: 'absolute' as const,
		top: '100%',
		left: '50%',
		transform: 'translateX(-50%)',
		border: '6px solid transparent',
		borderTopColor: colors.surface,
	},
	[hoverMq]: {
		'&:hover [role="tooltip"]': {
			opacity: 1,
			visibility: 'visible' as const,
		},
	},
	'&:focus-visible [role="tooltip"]': {
		opacity: 1,
		visibility: 'visible' as const,
	},
}

const connectionCardCss: CSSObject = {
	...insetCardCss,
	display: 'grid',
	gap: spacing.sm,
	padding: spacing.md,
}

const highlightedConnectionCardCss: CSSObject = {
	...connectionCardCss,
	borderColor: colors.primary,
	boxShadow: `inset 3px 0 0 ${colors.primary}`,
	borderRadius: `0 ${radius.lg} ${radius.lg} 0`,
}

export type IntegrationRecordProps = {
	selectedApp: AccountOauthAppListItem
	integrations: ReadonlyArray<AccountIntegrationListItem>
	apps: ReadonlyArray<AccountOauthAppListItem>
	savedPackages: ReadonlyArray<{ id: string; kodyId: string }>
	highlightedConnectionName: string | null
	highlightedConnection: AccountIntegrationListItem | null
	currentHref: string
	currentSearch: string
	deleteAppConfirmation: { armed: boolean; arm: () => void; reset: () => void }
	getDisconnectConfirmation: (name: string) => {
		armed: boolean
		arm: () => void
		reset: () => void
	}
	startDeleteApp: (app: AccountOauthAppListItem) => Promise<void>
	startDisconnect: (connection: {
		name: string
		accountLabel?: string | null
	}) => Promise<void>
	usageDraftFor: (
		connection: AccountIntegrationListItem,
	) => IntegrationUsageDraft
	setUsageDraft: (name: string, draft: IntegrationUsageDraft) => void
	submitUsage: (connection: AccountIntegrationListItem) => Promise<void>
	usageSavingName: string | null
	onRotated: (app: AccountOauthAppListItem) => void
}

export function renderIntegrationRecord(props: IntegrationRecordProps) {
	const {
		selectedApp,
		integrations,
		apps,
		savedPackages,
		highlightedConnectionName,
		highlightedConnection,
		currentHref,
		currentSearch,
		deleteAppConfirmation,
		getDisconnectConfirmation,
		startDeleteApp,
		startDisconnect,
		usageDraftFor,
		setUsageDraft,
		submitUsage,
		usageSavingName,
		onRotated,
	} = props
	return (
		<section css={recordBodyCss}>
			<header
				css={{
					display: 'grid',
					justifyItems: 'start',
					gap: spacing.sm,
				}}
			>
				<ProviderMark
					providerKey={selectedApp.provider || selectedApp.slug}
					label={oauthAppTitle(selectedApp)}
					logoPath={selectedApp.platformLogoPath ?? selectedApp.logoPath}
					autoLogoPath={selectedApp.autoLogoPath}
					catalogLogoPath={selectedApp.catalogLogoPath}
					host={hostFromUrl(selectedApp.authorizeUrl ?? selectedApp.tokenUrl)}
				/>
				<div css={{ display: 'grid', gap: spacing.xs }}>
					<h2
						css={{
							...cardTitleCss,
							display: 'flex',
							alignItems: 'center',
							gap: spacing.sm,
						}}
					>
						{oauthAppTitle(selectedApp)}
						{isBuiltInApp(selectedApp)
							? renderBuiltInIndicator({
									tooltipId: 'built-in-tip-detail',
								})
							: null}
					</h2>
					<p css={descriptionCss}>
						{accountsConnectedCopy(selectedApp.connections.length)}
					</p>
					{isBuiltInApp(selectedApp) ? null : (
						<button
							type="button"
							data-testid="delete-integration"
							aria-label={
								deleteAppConfirmation.armed
									? `Confirm delete integration "${oauthAppTitle(selectedApp)}"`
									: `Delete integration "${oauthAppTitle(selectedApp)}"`
							}
							title={
								deleteAppConfirmation.armed
									? `Click again to delete "${oauthAppTitle(selectedApp)}" and every connected account`
									: `Delete "${oauthAppTitle(selectedApp)}" and every connected account`
							}
							css={dangerButtonCss}
							onBlur={deleteAppConfirmation.reset}
							onClick={() => {
								if (deleteAppConfirmation.armed)
									void startDeleteApp(selectedApp)
								else deleteAppConfirmation.arm()
							}}
						>
							{deleteAppConfirmation.armed
								? 'Confirm delete'
								: 'Delete integration'}
						</button>
					)}
				</div>
			</header>

			<section css={{ display: 'grid', gap: spacing.sm }}>
				<h3 css={sectionTitleCss}>Connections</h3>
				{selectedApp.connections.length === 0 ? (
					<div
						css={{
							display: 'grid',
							gap: spacing.sm,
							justifyItems: 'start',
						}}
					>
						<p css={descriptionCss}>No accounts connected yet.</p>
						<SiteLink
							href={buildConnectOauthHref({
								name: selectedApp.slug,
								appSlug: selectedApp.slug,
							})}
							css={{
								...getPillButtonCss({ size: 'sm' }),
								display: 'inline-flex',
								textDecoration: 'none',
							}}
						>
							Connect
						</SiteLink>
					</div>
				) : (
					<div
						css={{
							display: 'grid',
							gap: spacing.sm,
						}}
					>
						{selectedApp.connections.map((connectionRef) => {
							const connection = integrations.find(
								(entry) => entry.name === connectionRef.name,
							)
							const highlighted =
								connectionRef.name === highlightedConnectionName
							const status = connection
								? connectionStatusLabel(connection)
								: 'Needs setup'
							const showReconnect = connection
								? shouldShowReconnectAction(connection)
								: true
							const connectHref =
								connection?.lastAuthFailure?.who === 'you'
									? connection.lastAuthFailure.reconnectHref
									: buildConnectOauthHref({
											name: connectionRef.name,
											appSlug: connection?.platform
												? undefined
												: (connection?.appSlug ?? selectedApp.slug),
										})
							const disconnectConfirmation = getDisconnectConfirmation(
								connectionRef.name,
							)
							const confirmingDisconnect = disconnectConfirmation.armed
							const disconnectLabel = connectionLabel(
								connection ?? connectionRef,
							)
							return (
								<article
									key={connectionRef.name}
									data-testid="integration-connection"
									data-highlighted={highlighted ? 'true' : undefined}
									css={
										highlighted
											? highlightedConnectionCardCss
											: connectionCardCss
									}
								>
									<div
										css={{
											display: 'grid',
											gap: spacing.xs,
										}}
									>
										<SiteLink
											href={integrationsRoute.buildDetailHref(
												connectionRef.name,
												currentSearch,
											)}
											data-prevent-scroll-reset
											css={primaryLinkCss}
										>
											{connection
												? integrationDisplayName(connection)
												: connectionRef.accountLabel?.trim() ||
													connectionRef.name}
										</SiteLink>
										<p
											css={{
												...descriptionCss,
												margin: 0,
											}}
										>
											<code>{connectionRef.name}</code>
											{' · '}
											{status}
											{connection
												? ` · ${formatOauthScopeSummary({
														selectedCount:
															connection.authorization?.scopes.length ?? 0,
														menuCount: resolveOauthScopeMenu({
															allowedScopes: connection.platformAllowedScopes,
															selectedScopes: connection.authorization?.scopes,
														}).length,
													})}`
												: ''}
											{connection
												? ` · ${
														connection.usageMode === 'packages'
															? 'Specific packages'
															: 'Any context'
													}`
												: ''}
										</p>
										{connection?.lastAuthFailure ? (
											<p
												css={{
													...getAccentCalloutCss({
														accentColor:
															connection.lastAuthFailure.who === 'you'
																? colors.danger
																: colors.border,
													}),
													margin: 0,
													padding: spacing.sm,
													color: colors.textMuted,
													fontSize: '0.95rem',
													lineHeight: 1.5,
												}}
											>
												{connection.lastAuthFailure.why}
											</p>
										) : null}
									</div>
									{connection ? (
										<ConnectionUsageForm
											connection={connection}
											savedPackages={savedPackages}
											draft={usageDraftFor(connection)}
											saving={usageSavingName === connection.name}
											onDraftChange={(draft) =>
												setUsageDraft(connection.name, draft)
											}
											onSave={() => void submitUsage(connection)}
										/>
									) : null}
									<div
										css={{
											display: 'flex',
											flexWrap: 'wrap',
											gap: spacing.xs,
										}}
									>
										{showReconnect ? (
											<SiteLink
												href={connectHref}
												css={{
													...getPillButtonCss({
														size: 'sm',
													}),
													display: 'inline-flex',
													textDecoration: 'none',
												}}
											>
												{connectActionLabel(status)}
											</SiteLink>
										) : null}
										<button
											type="button"
											data-testid="disconnect-connection"
											aria-label={
												confirmingDisconnect
													? `Confirm disconnect ${disconnectLabel}`
													: `Disconnect ${disconnectLabel}`
											}
											title={
												confirmingDisconnect
													? `Click again to disconnect ${disconnectLabel}`
													: `Disconnect ${disconnectLabel}`
											}
											css={dangerButtonCss}
											onBlur={disconnectConfirmation.reset}
											onClick={() => {
												if (disconnectConfirmation.armed)
													void startDisconnect(connection ?? connectionRef)
												else disconnectConfirmation.arm()
											}}
										>
											{confirmingDisconnect
												? 'Confirm disconnect'
												: 'Disconnect'}
										</button>
									</div>
								</article>
							)
						})}
						<AddAccountForm
							slug={selectedApp.slug}
							platform={selectedApp.platform === true}
							existingNames={[
								...integrations.map((entry) => entry.name),
								...apps.map((app) => app.slug),
							]}
							open={isAddAccountFormOpen(currentHref)}
							openHref={buildAddAccountHref(currentHref)}
						/>
					</div>
				)}
			</section>

			{renderAdvancedDetails(
				<>
					<section css={detailGridCss}>
						{renderIntegrationDetail('Provider', selectedApp.provider)}
						{renderIntegrationDetail('Slug', selectedApp.slug)}
						{renderIntegrationDetail(
							'Label',
							formatOptional(selectedApp.label),
						)}
						{renderIntegrationDetail('Client ID', selectedApp.clientId)}
						{renderIntegrationDetail(
							'Client secret',
							selectedApp.hasClientSecret ? 'Stored' : 'None',
						)}
						{renderIntegrationDetail('Token URL', selectedApp.tokenUrl)}
						{renderIntegrationDetail(
							'Authorize URL',
							formatOptional(selectedApp.authorizeUrl),
						)}
						{renderIntegrationDetail(
							'API base URL',
							formatOptional(selectedApp.apiBaseUrl),
						)}
						{renderIntegrationDetail('Flow', selectedApp.flow)}
						{renderIntegrationDetail(
							'PKCE',
							selectedApp.usePkce == null
								? selectedApp.flow === 'pkce'
									? 'Default on'
									: 'Default off'
								: selectedApp.usePkce
									? 'Enabled'
									: 'Disabled',
						)}
						{renderIntegrationDetail(
							'Token exchange style',
							formatOptional(selectedApp.tokenExchangeStyle),
						)}
						{renderIntegrationDetail(
							'Created',
							formatTimestamp(selectedApp.createdAt),
						)}
						{renderIntegrationDetail(
							'Updated',
							formatTimestamp(selectedApp.updatedAt),
						)}
					</section>
					{highlightedConnection ? (
						<section css={insetCardCss}>
							<h3 css={sectionTitleCss}>Selected connection</h3>
							<div css={detailGridCss}>
								{renderIntegrationDetail(
									'Connection key',
									highlightedConnection.name,
								)}
								{renderIntegrationDetail(
									'Requested scopes',
									formatList(highlightedConnection.authorization?.scopes),
								)}
								{highlightedConnection.platformAllowedScopes &&
								highlightedConnection.platformAllowedScopes.length > 0
									? renderIntegrationDetail(
											'Available scopes',
											formatList(highlightedConnection.platformAllowedScopes),
										)
									: null}
								{renderIntegrationDetail(
									'Required hosts',
									formatList(highlightedConnection.requiredHosts),
								)}
							</div>
							<p css={descriptionCss}>
								Need more access? Copy this prompt for your agent. It explains
								how to request more scopes and reconnect so the token matches.
							</p>
							<CopyTextButton
								value={buildChangeIntegrationScopesPrompt({
									name: highlightedConnection.name,
									platform: highlightedConnection.platform === true,
									currentScopes: highlightedConnection.authorization?.scopes,
									allowedScopes: highlightedConnection.platformAllowedScopes,
								})}
								idleLabel="Copy scope prompt"
								variant="ghost"
								size="sm"
							/>
						</section>
					) : null}
					{isBuiltInApp(selectedApp) ? null : (
						<section css={insetCardCss}>
							<h3 css={sectionTitleCss}>Rotate client credentials</h3>
							<p css={descriptionCss}>
								Rotating credentials updates this shared registration once.
								Every connection below will use the new client id and client
								secret on the next authorize or token exchange.
							</p>
							{selectedApp.connections.length > 0 ? (
								<ul
									css={{
										margin: 0,
										paddingLeft: spacing.lg,
										display: 'grid',
										gap: spacing.xs,
										color: colors.text,
									}}
								>
									{selectedApp.connections.map((connection) => (
										<li key={`rotate-${connection.name}`}>
											{connection.accountLabel?.trim() || connection.name} (
											<code>{connection.name}</code>)
										</li>
									))}
								</ul>
							) : (
								<p css={descriptionCss}>
									No connections currently share these credentials.
								</p>
							)}
							<RotateCredentialsForm app={selectedApp} onRotated={onRotated} />
						</section>
					)}
				</>,
			)}
		</section>
	)
}
