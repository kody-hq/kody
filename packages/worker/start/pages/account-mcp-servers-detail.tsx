/** @jsxImportSource @emotion/react */
import { Button } from '../components/button.tsx'
import {
	McpServerOAuthClientSection,
	type McpServerOAuthClientInput,
} from './account-mcp-servers-oauth-client.tsx'
import { ProviderMark } from '../components/provider-icons.tsx'
import {
	accountActionsCss,
	AccountManagementMessage,
	MetadataGrid,
	TimestampValue,
} from './account-management-components.tsx'
import { recordBodyCss } from './record-table.tsx'
import {
	type McpServerListItem,
	type McpServerUsageDraft,
	hostFromUrl,
	mcpCodeCss,
	mcpDetailSectionCss,
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
	getAccentCalloutCss,
	sectionTitleCss,
} from '#universal/styles/style-primitives.ts'
import { Checkbox, Radio } from '../components/choice-controls.tsx'

function McpServerUsageForm(props: {
	server: McpServerListItem
	savedPackages: ReadonlyArray<{ id: string; kodyId: string }>
	draft: McpServerUsageDraft
	saving: boolean
	onDraftChange: (draft: McpServerUsageDraft) => void
	onSave: () => void
}) {
	const { server, savedPackages, draft, saving, onDraftChange, onSave } = props
	const choiceCss = {
		display: 'flex',
		gap: spacing.xs,
		alignItems: 'flex-start',
		minWidth: 0,
		color: colors.text,
		fontSize: typography.fontSize.sm,
		overflowWrap: 'anywhere',
	} as const
	const headingId = `mcp-server-usage-heading-${server.id}`
	return (
		<section
			data-testid="mcp-server-usage"
			aria-labelledby={headingId}
			css={mcpDetailSectionCss}
		>
			<h3 id={headingId} css={sectionTitleCss}>
				Usage
			</h3>
			<p css={{ ...descriptionCss, fontSize: typography.fontSize.sm }}>
				Choose who can call{' '}
				<code css={mcpCodeCss}>kody.mcp[&quot;{server.name}&quot;]</code>.
				Limiting it to packages keeps execute and other packages out.
			</p>
			<div
				role="radiogroup"
				aria-labelledby={headingId}
				css={{ display: 'grid', gap: spacing.xs }}
			>
				<label css={choiceCss}>
					<Radio
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
				<label css={choiceCss}>
					<Radio
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
			</div>
			{draft.usageMode === 'packages' ? (
				savedPackages.length === 0 ? (
					<p css={{ ...descriptionCss, fontSize: typography.fontSize.sm }}>
						Save a package first, then approve it here. Execute cannot use this
						server while it is limited to specific packages.
					</p>
				) : (
					<div
						css={{
							display: 'grid',
							gap: spacing.xs,
							paddingLeft: spacing.lg,
						}}
					>
						{savedPackages.map((savedPackage) => {
							const checked = draft.allowedPackageIds.includes(savedPackage.id)
							return (
								<label
									key={savedPackage.id}
									css={{ ...choiceCss, alignItems: 'center' }}
								>
									<Checkbox
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
			<div>
				<Button
					type="button"
					data-testid="save-mcp-server-usage"
					disabled={saving}
					onClick={onSave}
					variant="primary"
					mobileFullWidth
				>
					{saving ? 'Saving…' : 'Save usage'}
				</Button>
			</div>
		</section>
	)
}

type McpServerPackageApproval = {
	packageId: string
	packageName: string
	alreadyGranted: boolean
}

function McpServerPackageApprovalCard(props: {
	server: McpServerListItem
	approval: McpServerPackageApproval
	saving: boolean
	onApprove: () => void
}) {
	const { server, approval, saving, onApprove } = props
	return (
		<section
			data-testid="mcp-server-approval-card"
			css={{ ...getAccentCalloutCss(), gap: spacing.sm }}
		>
			<p css={{ ...sectionTitleCss, margin: 0 }}>Approve MCP server access</p>
			<p css={{ margin: 0, color: colors.text, overflowWrap: 'anywhere' }}>
				{approval.alreadyGranted ? 'Package ' : 'Allow package '}
				<strong css={{ color: colors.text }}>{approval.packageName}</strong>
				{approval.alreadyGranted ? ' can already call ' : ' to call '}
				<code css={mcpCodeCss}>kody.mcp[&quot;{server.name}&quot;]</code>.
			</p>
			{approval.alreadyGranted ? null : (
				<div>
					<Button
						type="button"
						data-testid="approve-mcp-server-package"
						disabled={saving}
						onClick={onApprove}
						variant="primary"
						mobileFullWidth
					>
						{saving ? 'Approving…' : 'Approve'}
					</Button>
				</div>
			)}
		</section>
	)
}

export type McpServerDetailProps = {
	server: McpServerListItem
	packageApproval: McpServerPackageApproval | null
	onPackageApprove: () => void
	savedPackages: ReadonlyArray<{ id: string; kodyId: string }>
	usageDraft: McpServerUsageDraft
	usageSaving: boolean
	isMutating: boolean
	deleteArmed: boolean
	onDeleteArm: () => void
	onDeleteReset: () => void
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
		packageApproval,
		onPackageApprove,
		savedPackages,
		usageDraft,
		usageSaving,
		isMutating,
		deleteArmed,
		onDeleteArm,
		onDeleteReset,
		onUsageDraftChange,
		onUsageSave,
		onReconnect,
		onRefresh,
		onToggleEnabled,
		onDelete,
		onOAuthClientSave,
		onOAuthClientRemove,
	} = props
	const host = hostFromUrl(server.url)
	return (
		<section aria-label={`${server.name} details`} css={recordBodyCss}>
			<header
				css={{
					display: 'flex',
					alignItems: 'center',
					gap: spacing.md,
					minWidth: 0,
				}}
			>
				<ProviderMark
					providerKey={server.name}
					label={server.name}
					autoLogoPath={server.autoLogoPath}
					catalogLogoPath={server.catalogLogoPath}
					host={host}
				/>
				<div css={{ display: 'grid', gap: '0.2rem', minWidth: 0 }}>
					<h2 css={{ ...cardTitleCss, overflowWrap: 'anywhere' }}>
						{server.name}
					</h2>
					<p css={{ ...descriptionCss, overflowWrap: 'anywhere' }}>
						{host ?? 'MCP server'}
					</p>
				</div>
			</header>

			<MetadataGrid
				items={[
					{
						label: 'Status',
						value: (
							<span
								data-testid="mcp-server-status"
								css={{ color: stateColor(server), fontWeight: 600 }}
							>
								{stateLabel(server)}
							</span>
						),
					},
					{
						label: 'Tools',
						value: server.connected
							? `${server.toolCount} discovered`
							: 'Available once connected',
					},
				]}
			/>

			{server.error ? (
				<div
					css={{
						...getAccentCalloutCss({ accentColor: colors.error }),
						backgroundColor: `color-mix(in srgb, ${colors.error} 6%, transparent)`,
					}}
				>
					<AccountManagementMessage tone="error">
						<span css={{ overflowWrap: 'anywhere' }}>{server.error}</span>
					</AccountManagementMessage>
				</div>
			) : null}

			{server.state === 'authenticating' && !server.authUrl ? (
				<div css={getAccentCalloutCss()}>
					<AccountManagementMessage tone="info">
						Authorization needed. Click Reconnect to create a new authorization
						link. You may need to approve access once more.
					</AccountManagementMessage>
				</div>
			) : null}

			{server.authUrl && server.state === 'authenticating' ? (
				<div css={{ ...getAccentCalloutCss(), gap: spacing.sm }}>
					<p css={{ margin: 0, color: colors.text }}>
						Authorization needed. Approve access before this server&apos;s tools
						become available.
					</p>
					<div>
						<Button
							href={server.authUrl}
							rel="noopener noreferrer"
							variant="primary"
							mobileFullWidth
							css={{ textDecoration: 'none' }}
						>
							Authorize {server.name}
						</Button>
					</div>
				</div>
			) : null}

			{packageApproval ? (
				<McpServerPackageApprovalCard
					server={server}
					approval={packageApproval}
					saving={usageSaving}
					onApprove={onPackageApprove}
				/>
			) : null}

			<div css={fieldCss}>
				<span css={fieldLabelCss}>Server URL</span>
				<code
					css={{
						...mcpCodeCss,
						padding: `${spacing.xs} ${spacing.sm}`,
						borderRadius: radius.md,
						border: `1px solid ${colors.borderSubtle}`,
						backgroundColor: colors.background,
					}}
				>
					{server.url}
				</code>
				<p
					css={{
						...descriptionCss,
						display: 'flex',
						flexWrap: 'wrap',
						columnGap: spacing.md,
						rowGap: '0.2rem',
						fontSize: typography.fontSize.sm,
					}}
				>
					<span>
						Added <TimestampValue value={server.createdAt} />
					</span>
					<span>
						Updated <TimestampValue value={server.updatedAt} />
					</span>
				</p>
			</div>

			{server.connected && server.tools.length > 0 ? (
				<section
					aria-labelledby={`mcp-server-tools-${server.id}`}
					css={mcpDetailSectionCss}
				>
					<h3 id={`mcp-server-tools-${server.id}`} css={sectionTitleCss}>
						Discovered tools
					</h3>
					<ul
						css={{
							margin: 0,
							padding: 0,
							listStyle: 'none',
							display: 'flex',
							flexWrap: 'wrap',
							gap: spacing.xs,
							minWidth: 0,
						}}
					>
						{server.tools.map((tool) => (
							<li key={tool} css={{ minWidth: 0, maxWidth: '100%' }}>
								<code
									css={{
										...mcpCodeCss,
										display: 'block',
										padding: '0.2rem 0.5rem',
										borderRadius: radius.sm,
										border: `1px solid ${colors.borderSubtle}`,
										backgroundColor: colors.background,
									}}
								>
									{tool}
								</code>
							</li>
						))}
					</ul>
				</section>
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
				onSave={onOAuthClientSave}
				onRemove={onOAuthClientRemove}
			/>

			<div css={{ ...mcpDetailSectionCss, ...accountActionsCss }}>
				<Button
					type="button"
					disabled={isMutating}
					onClick={onReconnect}
					variant="primary"
					mobileFullWidth
				>
					Reconnect
				</Button>
				<Button
					type="button"
					disabled={isMutating}
					onClick={onRefresh}
					variant="secondary"
					mobileFullWidth
				>
					Refresh tools
				</Button>
				<Button
					type="button"
					disabled={isMutating}
					onClick={onToggleEnabled}
					variant="secondary"
					mobileFullWidth
				>
					{server.enabled ? 'Disable' : 'Enable'}
				</Button>
				<Button
					type="button"
					disabled={isMutating}
					variant="danger"
					mobileFullWidth
					onBlur={onDeleteReset}
					onClick={() => {
						if (deleteArmed) onDelete()
						else onDeleteArm()
					}}
				>
					{deleteArmed ? 'Confirm remove' : 'Remove'}
				</Button>
			</div>
		</section>
	)
}
