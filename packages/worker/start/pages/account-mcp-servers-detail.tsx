/** @jsxImportSource @emotion/react */
import {
	McpServerOAuthClientSection,
	type McpServerOAuthClientInput,
} from './account-mcp-servers-oauth-client.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { ProviderMark } from '../components/provider-icons.tsx'
import {
	AccountManagementMessage,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import { recordBodyCss } from './record-table.tsx'
import {
	type McpServerListItem,
	type McpServerUsageDraft,
	hostFromUrl,
	stateColor,
	stateLabel,
} from './account-mcp-servers-shared.tsx'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	cardTitleCss,
	descriptionCss,
	fieldCss,
	fieldLabelCss,
	type getDangerPillCss,
	type getGhostButtonCss,
	getPillButtonCss,
} from '#universal/styles/style-primitives.ts'

function McpServerUsageForm(props: {
	server: McpServerListItem
	savedPackages: ReadonlyArray<{ id: string; kodyId: string }>
	draft: McpServerUsageDraft
	saving: boolean
	onDraftChange: (draft: McpServerUsageDraft) => void
	onSave: () => void
}) {
	const { server, savedPackages, draft, saving, onDraftChange, onSave } = props
	return (
		<section
			data-testid="mcp-server-usage"
			css={{ display: 'grid', gap: spacing.xs }}
		>
			<p
				css={{
					...fieldLabelCss,
					margin: 0,
				}}
			>
				Usage
			</p>
			<p css={{ ...descriptionCss, margin: 0 }}>
				Limit this server so only listed packages can call{' '}
				<code>kody.mcp[&quot;{server.name}&quot;]</code>. Execute and other
				packages are denied.
			</p>
			<label
				css={{
					display: 'flex',
					gap: spacing.xs,
					alignItems: 'flex-start',
					color: colors.text,
					fontSize: typography.fontSize.sm,
				}}
			>
				<input
					type="radio"
					name={`mcp-usage-mode-${server.id}`}
					checked={draft.usageMode === 'any'}
					disabled={saving}
					onChange={() =>
						onDraftChange({
							usageMode: 'any',
							allowedPackageIds: [],
						})
					}
				/>
				<span>Any context (execute and every package)</span>
			</label>
			<label
				css={{
					display: 'flex',
					gap: spacing.xs,
					alignItems: 'flex-start',
					color: colors.text,
					fontSize: typography.fontSize.sm,
				}}
			>
				<input
					type="radio"
					name={`mcp-usage-mode-${server.id}`}
					checked={draft.usageMode === 'packages'}
					disabled={saving}
					onChange={() =>
						onDraftChange({
							usageMode: 'packages',
							allowedPackageIds: draft.allowedPackageIds,
						})
					}
				/>
				<span>Specific packages only</span>
			</label>
			{draft.usageMode === 'packages' ? (
				savedPackages.length === 0 ? (
					<p css={{ ...descriptionCss, margin: 0 }}>
						Save a package first, then approve it here. Execute cannot use this
						server while it is limited to specific packages.
					</p>
				) : (
					<div css={{ display: 'grid', gap: spacing.xs }}>
						{savedPackages.map((savedPackage) => {
							const checked = draft.allowedPackageIds.includes(savedPackage.id)
							return (
								<label
									key={savedPackage.id}
									css={{
										display: 'flex',
										gap: spacing.xs,
										alignItems: 'center',
										fontSize: typography.fontSize.sm,
									}}
								>
									<input
										type="checkbox"
										checked={checked}
										disabled={saving}
										onChange={() =>
											onDraftChange({
												usageMode: 'packages',
												allowedPackageIds: checked
													? draft.allowedPackageIds.filter(
															(id) => id !== savedPackage.id,
														)
													: [...draft.allowedPackageIds, savedPackage.id],
											})
										}
									/>
									<span>{savedPackage.kodyId}</span>
								</label>
							)
						})}
					</div>
				)
			) : null}
			<button
				type="button"
				data-testid="save-mcp-server-usage"
				disabled={saving}
				onClick={onSave}
				css={getPillButtonCss({ size: 'sm' })}
			>
				{saving ? 'Saving…' : 'Save usage'}
			</button>
		</section>
	)
}

export type McpServerDetailProps = {
	server: McpServerListItem
	savedPackages: ReadonlyArray<{ id: string; kodyId: string }>
	usageDraft: McpServerUsageDraft
	usageSaving: boolean
	isMutating: boolean
	deleteArmed: boolean
	onDeleteArm: () => void
	onDeleteReset: () => void
	primaryButtonCss: ReturnType<typeof getPillButtonCss>
	secondaryButtonCss: ReturnType<typeof getGhostButtonCss>
	dangerButtonCss: ReturnType<typeof getDangerPillCss>
	onUsageDraftChange: (draft: McpServerUsageDraft) => void
	onUsageSave: () => void
	onReconnect: () => void
	onRefresh: () => void
	onToggleEnabled: () => void
	onDelete: () => void
	onOAuthClientSave: (client: McpServerOAuthClientInput) => Promise<boolean>
	onOAuthClientRemove: () => void
}

export function renderMcpServerDetail(props: McpServerDetailProps) {
	const {
		server,
		savedPackages,
		usageDraft,
		usageSaving,
		isMutating,
		deleteArmed,
		onDeleteArm,
		onDeleteReset,
		primaryButtonCss,
		secondaryButtonCss,
		dangerButtonCss,
		onUsageDraftChange,
		onUsageSave,
		onReconnect,
		onRefresh,
		onToggleEnabled,
		onDelete,
		onOAuthClientSave,
		onOAuthClientRemove,
	} = props
	return (
		<section css={recordBodyCss}>
			<div
				css={{
					display: 'flex',
					alignItems: 'flex-start',
					gap: spacing.md,
				}}
			>
				<ProviderMark
					providerKey={server.name}
					label={server.name}
					autoLogoPath={server.autoLogoPath}
					catalogLogoPath={server.catalogLogoPath}
					host={hostFromUrl(server.url)}
				/>
				<div css={{ display: 'grid', gap: spacing.xs }}>
					<h2 css={cardTitleCss}>{server.name}</h2>
					<p css={descriptionCss}>
						Saved MCP server connection. Kody keeps OAuth tokens and connection
						state isolated to your account.
					</p>
				</div>
			</div>

			<MetadataGrid
				items={[
					{
						label: 'Status',
						value: (
							<div
								css={{
									display: 'grid',
									gap: spacing.xs,
									color: stateColor(server),
								}}
							>
								<span>{stateLabel(server)}</span>
								{server.error ? (
									<AccountManagementMessage tone="error">
										{server.error}
									</AccountManagementMessage>
								) : null}
							</div>
						),
					},
					{
						label: 'Tools',
						value: server.connected ? `${server.toolCount} discovered` : '—',
					},
					{
						label: 'Added',
						value: <TimestampValue value={server.createdAt} />,
					},
					{
						label: 'Updated',
						value: <TimestampValue value={server.updatedAt} />,
					},
				]}
			/>

			<div css={fieldCss}>
				<span css={fieldLabelCss}>Server URL</span>
				<code
					css={{
						padding: spacing.sm,
						borderRadius: radius.md,
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.background,
						color: colors.text,
						fontFamily: 'monospace',
						fontSize: typography.fontSize.sm,
						overflowWrap: 'anywhere',
					}}
				>
					{server.url}
				</code>
			</div>

			{server.state === 'authenticating' && !server.authUrl ? (
				<AccountManagementMessage tone="info">
					Authorization needed. Click Reconnect to create a new authorization
					link. You may need to approve access once more.
				</AccountManagementMessage>
			) : null}

			{server.authUrl && server.state === 'authenticating' ? (
				<div
					css={{
						display: 'grid',
						gap: spacing.sm,
						padding: spacing.md,
						borderRadius: radius.md,
						border: `1px solid ${colors.primary}`,
						backgroundColor: colors.primarySoftest,
					}}
				>
					<span css={{ color: colors.text }}>
						Authorization needed. Approve access before this server&apos;s tools
						become available.
					</span>
					<div>
						<SiteLink
							href={server.authUrl}
							rel="noopener noreferrer"
							css={{
								...primaryButtonCss,
								display: 'inline-block',
								textDecoration: 'none',
							}}
						>
							Authorize {server.name}
						</SiteLink>
					</div>
				</div>
			) : null}

			<McpServerUsageForm
				server={server}
				savedPackages={savedPackages}
				draft={usageDraft}
				saving={usageSaving}
				onDraftChange={onUsageDraftChange}
				onSave={onUsageSave}
			/>

			<McpServerOAuthClientSection
				key={server.id}
				server={server}
				isMutating={isMutating}
				primaryButtonCss={primaryButtonCss}
				secondaryButtonCss={secondaryButtonCss}
				dangerButtonCss={dangerButtonCss}
				onSave={onOAuthClientSave}
				onRemove={onOAuthClientRemove}
			/>

			{server.connected && server.tools.length > 0 ? (
				<div css={fieldCss}>
					<span css={fieldLabelCss}>Discovered tools</span>
					<ul
						css={{
							margin: 0,
							paddingLeft: spacing.lg,
							color: colors.text,
							display: 'grid',
							gap: spacing.xs,
						}}
					>
						{server.tools.map((tool) => (
							<li key={tool}>
								<code
									css={{
										fontFamily: 'monospace',
										fontSize: typography.fontSize.sm,
									}}
								>
									{tool}
								</code>
							</li>
						))}
					</ul>
				</div>
			) : null}

			<div
				css={{
					display: 'flex',
					gap: spacing.sm,
					flexWrap: 'wrap',
				}}
			>
				<button
					type="button"
					disabled={isMutating}
					onClick={onReconnect}
					css={primaryButtonCss}
				>
					Reconnect
				</button>
				<button
					type="button"
					disabled={isMutating}
					onClick={onRefresh}
					css={secondaryButtonCss}
				>
					Refresh tools
				</button>
				<button
					type="button"
					disabled={isMutating}
					onClick={onToggleEnabled}
					css={secondaryButtonCss}
				>
					{server.enabled ? 'Disable' : 'Enable'}
				</button>
				<button
					type="button"
					disabled={isMutating}
					css={dangerButtonCss}
					onBlur={onDeleteReset}
					onClick={() => {
						if (deleteArmed) onDelete()
						else onDeleteArm()
					}}
				>
					{deleteArmed ? 'Confirm remove' : 'Remove'}
				</button>
			</div>
		</section>
	)
}
