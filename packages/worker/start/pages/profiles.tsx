/** @jsxImportSource @emotion/react */
import { type CSSObject } from '@emotion/react'
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import {
	createProfile,
	createProfileToken,
	revokeProfile,
	revokeProfileToken,
	shortenProfileExpiry,
} from '#start/server/profiles'
import {
	type ProfileGrantOption,
	type ProfileItem,
	type ProfilesPageData,
	type ProfileStatus,
	type ProfileTokenItem,
	type ProfileTreeNode,
	buildProfileTree,
	canEditProfile,
	canRevokeProfile,
	descendantCount,
	expiryChangeProblem,
	findTreeNode,
	profileAgentHints,
	profileStatusExplanation,
	profileStatusLabel,
	profileTreeMaxDepth,
	subProfileBlock,
	subProfileBlockMessage,
	subProfileGrantOptions,
	tokensForProfile,
	visibleTreeIds,
} from '#universal/profiles.ts'
import { orgResourcePath } from '#universal/org-pages.ts'
import { routes } from '#universal/routes.ts'
import {
	getDangerPillCss,
	getGhostButtonCss,
	getPillButtonCss,
	getSelectCss,
	primaryLinkCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { CopyTextButton } from '../components/copy-text-button.tsx'
import { ExperimentOptIn } from '../components/experiment-opt-in.tsx'
import { SiteLink } from '../components/site-link.tsx'
import { useRefreshProfilesPage } from '../profiles-query.ts'
import {
	AccountManagementMessage,
	AccountManagementPanel,
	AccountManagementShell,
	AccountPageHeader,
	IdValue,
	MetadataGrid,
	TimestampValue,
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from './account-management-components.tsx'

type EnabledData = Extract<ProfilesPageData, { enabled: true }>

type MutationResult =
	| ({ ok: true } & Record<string, unknown>)
	| { ok: false; error: string; message: string }

const pageTitle = 'Agent profiles'
const pageDescription =
	'Scoped identities for the agents and bots you run, and the sub-profiles below them. Not your public profile.'

export function ProfilesRoute(props: {
	payload: ProfilesPageData
	currentHref: string
}) {
	const { payload, currentHref } = props
	if (!payload.enabled) {
		return (
			<AccountManagementShell layout="list" currentHref={currentHref}>
				<AccountPageHeader
					entity="profiles"
					title={pageTitle}
					description={pageDescription}
					currentHref={currentHref}
				/>
				<AccountManagementPanel>
					<div data-testid="profiles-flag-off" data-flag="profiles">
						<p css={{ margin: 0 }}>
							Agent profiles are an experiment. Turn them on to give each agent
							or bot you run its own identity with only the access you choose,
							nest sub-profiles under it, set an expiry, and revoke it in one
							step.
						</p>
						<p css={{ margin: '0.5rem 0 0', color: colors.textMuted }}>
							Read the{' '}
							<SiteLink
								href={routes.docDetail.href({ slug: 'profiles' })}
								css={primaryLinkCss}
							>
								profiles guide
							</SiteLink>
							, or manage every experiment on{' '}
							<SiteLink
								href={routes.accountExperiments.href()}
								css={primaryLinkCss}
							>
								Experiments
							</SiteLink>
							.
						</p>
						<ExperimentOptIn experiment="profiles">
							Try agent profiles
						</ExperimentOptIn>
					</div>
				</AccountManagementPanel>
			</AccountManagementShell>
		)
	}
	return <EnabledPage payload={payload} currentHref={currentHref} />
}

type Composer = { parentId: string | null } | null

function EnabledPage(props: { payload: EnabledData; currentHref: string }) {
	const { payload, currentHref } = props
	const tree = useMemo(
		() => buildProfileTree(payload.profiles),
		[payload.profiles],
	)
	const [selectedId, setSelectedId] = useState<string | null>(
		tree[0]?.profile.id ?? null,
	)
	const [composer, setComposer] = useState<Composer>(null)
	const selected =
		(selectedId ? findTreeNode(tree, selectedId) : null) ?? tree[0] ?? null
	const base = orgResourcePath(payload.orgSlug, 'profiles')
	const showMembersToggle = payload.viewer.isOwner && !payload.personalOrg
	const parent =
		composer?.parentId != null
			? (findTreeNode(tree, composer.parentId)?.profile ?? null)
			: null

	return (
		<AccountManagementShell layout="list" currentHref={currentHref}>
			<AccountPageHeader
				entity="profiles"
				title={pageTitle}
				description={pageDescription}
				currentHref={currentHref}
				actions={
					payload.listError ? null : (
						<button
							type="button"
							css={getPillButtonCss({ size: 'sm' })}
							onClick={() => setComposer({ parentId: null })}
						>
							New profile
						</button>
					)
				}
			/>
			{payload.listError ? (
				<AccountManagementPanel>
					<AccountManagementMessage tone="error">
						{payload.listError}
					</AccountManagementMessage>
				</AccountManagementPanel>
			) : null}
			{showMembersToggle ? (
				<nav aria-label="Whose profiles" css={segmentedCss}>
					<SiteLink
						href={base}
						aria-current={payload.allMembers ? undefined : 'page'}
						css={segmentCss(!payload.allMembers)}
					>
						Your profiles
					</SiteLink>
					<SiteLink
						href={`${base}?members=all`}
						aria-current={payload.allMembers ? 'page' : undefined}
						css={segmentCss(payload.allMembers)}
					>
						Every member (Owner)
					</SiteLink>
				</nav>
			) : null}
			{payload.allMembers ? (
				<p css={{ margin: 0, color: colors.textMuted }}>
					As an Owner you can see and revoke every member’s profiles here. Only
					the person a profile acts for can edit it or add sub-profiles.
				</p>
			) : null}
			{composer ? (
				<CreateProfilePanel
					key={composer.parentId ?? 'root'}
					orgSlug={payload.orgSlug}
					parent={parent}
					grantOptions={
						parent
							? subProfileGrantOptions(parent, payload.profiles)
							: payload.grantOptions
					}
					onCancel={() => setComposer(null)}
					onCreated={(id) => {
						setComposer(null)
						if (id) setSelectedId(id)
					}}
				/>
			) : null}
			{tree.length === 0 && !payload.listError ? (
				composer ? null : (
					<EmptyState
						allMembers={payload.allMembers}
						onCreate={() => setComposer({ parentId: null })}
					/>
				)
			) : tree.length > 0 ? (
				<div css={layoutCss}>
					<AccountManagementPanel title="Hierarchy">
						<ProfileTree
							tree={tree}
							selectedId={selected?.profile.id ?? null}
							onSelect={setSelectedId}
							tokens={payload.tokens}
							showOwner={payload.allMembers}
						/>
						<StatusLegend />
					</AccountManagementPanel>
					{selected ? (
						<ProfileDetail
							key={selected.profile.id}
							node={selected}
							payload={payload}
							onAddSubProfile={() =>
								setComposer({ parentId: selected.profile.id })
							}
						/>
					) : null}
				</div>
			) : null}
			<AgentHints
				orgSlug={payload.orgSlug}
				personalOrg={payload.personalOrg}
				profileId={selected?.profile.id}
			/>
		</AccountManagementShell>
	)
}

function EmptyState(props: { allMembers: boolean; onCreate: () => void }) {
	return (
		<AccountManagementPanel
			title={
				props.allMembers
					? 'No member has a profile here yet'
					: 'Give an agent its own identity'
			}
		>
			<div
				data-testid="profiles-empty"
				css={{ display: 'grid', gap: '0.75rem' }}
			>
				<p css={{ margin: 0 }}>
					A profile is a scoped identity for one agent or bot you run. It starts
					with only the grants you pick, each one a subset of what you hold, and
					it never gains access later. Make sub-profiles under it for helpers,
					up to {profileTreeMaxDepth} levels deep, each narrower than its
					parent.
				</p>
				<ul
					css={{
						margin: 0,
						paddingInlineStart: '1.2rem',
						color: colors.textMuted,
					}}
				>
					<li>Set an expiry. It can only move earlier.</li>
					<li>Mint a token bound to the profile for the agent to use.</li>
					<li>Revoke it, and every sub-profile below stops working too.</li>
				</ul>
				<div css={accountActionsCss}>
					<button
						type="button"
						css={getPillButtonCss({ size: 'sm' })}
						onClick={props.onCreate}
					>
						Create your first profile
					</button>
					<SiteLink
						href={routes.docDetail.href({ slug: 'profiles' })}
						css={primaryLinkCss}
					>
						How profiles work
					</SiteLink>
				</div>
			</div>
		</AccountManagementPanel>
	)
}

const statusTone: Record<ProfileStatus, CSSObject> = {
	active: {
		color: colors.primary,
		borderColor: colors.primary,
		backgroundColor: colors.primarySoft,
	},
	expired: {
		color: colors.warningText,
		borderColor: colors.warning,
		backgroundColor: `color-mix(in srgb, ${colors.warning} 14%, transparent)`,
	},
	revoked: {
		color: colors.danger,
		borderColor: colors.danger,
		backgroundColor: `color-mix(in srgb, ${colors.danger} 12%, transparent)`,
	},
	parent_inactive: {
		color: colors.textMuted,
		borderColor: colors.border,
		borderStyle: 'dashed',
		backgroundColor: 'transparent',
	},
}

function ProfileStatusBadge(props: { status: ProfileStatus }) {
	return (
		<span
			data-profile-status={props.status}
			css={{
				display: 'inline-flex',
				alignItems: 'center',
				padding: '0.05rem 0.5rem',
				borderRadius: radius.full,
				border: '1px solid',
				fontSize: typography.fontSize.xs,
				fontWeight: typography.fontWeight.semibold,
				whiteSpace: 'nowrap',
				...statusTone[props.status],
			}}
		>
			{profileStatusLabel(props.status)}
		</span>
	)
}

function StatusLegend() {
	const statuses: Array<ProfileStatus> = [
		'active',
		'expired',
		'revoked',
		'parent_inactive',
	]
	return (
		<details
			css={{ fontSize: typography.fontSize.sm, color: colors.textMuted }}
		>
			<summary css={{ cursor: 'pointer' }}>What the statuses mean</summary>
			<dl css={{ margin: '0.5rem 0 0', display: 'grid', gap: '0.4rem' }}>
				{statuses.map((status) => (
					<div key={status} css={{ display: 'flex', gap: '0.5rem' }}>
						<dt>
							<ProfileStatusBadge status={status} />
						</dt>
						<dd css={{ margin: 0 }}>{profileStatusExplanation(status)}</dd>
					</div>
				))}
			</dl>
		</details>
	)
}

function parentOf(
	tree: ReadonlyArray<ProfileTreeNode>,
	id: string,
	parent: string | null = null,
): string | null | undefined {
	for (const entry of tree) {
		if (entry.profile.id === id) return parent
		const found = parentOf(entry.children, id, entry.profile.id)
		if (found !== undefined) return found
	}
	return undefined
}

function ProfileTree(props: {
	tree: Array<ProfileTreeNode>
	selectedId: string | null
	onSelect: (id: string) => void
	tokens: Array<ProfileTokenItem>
	showOwner: boolean
}) {
	const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
	const [focusedId, setFocusedId] = useState<string | null>(props.selectedId)
	const refs = useRef(new Map<string, HTMLLIElement>())
	const visible = visibleTreeIds(props.tree, collapsed)
	const activeId =
		focusedId && visible.includes(focusedId) ? focusedId : (visible[0] ?? null)

	function focus(id: string | null | undefined) {
		if (!id) return
		setFocusedId(id)
		refs.current.get(id)?.focus()
	}
	function toggle(id: string, open?: boolean) {
		setCollapsed((current) => {
			const next = new Set(current)
			const isOpen = !next.has(id)
			if (open ?? !isOpen) next.delete(id)
			else next.add(id)
			return next
		})
	}
	function onKeyDown(event: KeyboardEvent<HTMLUListElement>) {
		if (!activeId) return
		const index = visible.indexOf(activeId)
		const node = findTreeNode(props.tree, activeId)
		const hasChildren = Boolean(node?.children.length)
		const open = hasChildren && !collapsed.has(activeId)
		switch (event.key) {
			case 'ArrowDown':
				focus(visible[index + 1])
				break
			case 'ArrowUp':
				focus(visible[index - 1])
				break
			case 'Home':
				focus(visible[0])
				break
			case 'End':
				focus(visible.at(-1))
				break
			case 'ArrowRight':
				if (hasChildren && !open) toggle(activeId, true)
				else if (open) focus(node?.children[0]?.profile.id)
				break
			case 'ArrowLeft':
				if (open) toggle(activeId, false)
				else focus(parentOf(props.tree, activeId))
				break
			case 'Enter':
			case ' ':
				props.onSelect(activeId)
				break
			default:
				return
		}
		event.preventDefault()
	}

	function renderNodes(nodes: Array<ProfileTreeNode>) {
		return nodes.map((node) => {
			const id = node.profile.id
			const hasChildren = node.children.length > 0
			const open = hasChildren && !collapsed.has(id)
			const inactive = node.profile.status !== 'active'
			const tokenCount = tokensForProfile(props.tokens, id).filter(
				(token) => token.status === 'active',
			).length
			return (
				<li
					key={id}
					ref={(element) => {
						if (element) refs.current.set(id, element)
						else refs.current.delete(id)
					}}
					role="treeitem"
					aria-level={node.level}
					aria-selected={props.selectedId === id}
					aria-expanded={hasChildren ? open : undefined}
					aria-label={`${node.profile.name}, ${profileStatusLabel(node.profile.status)}, level ${node.profile.depth}`}
					tabIndex={activeId === id ? 0 : -1}
					data-profile-id={id}
					data-profile-status={node.profile.status}
					onFocus={(event) => {
						if (event.target === event.currentTarget) setFocusedId(id)
					}}
					onClick={(event) => {
						event.stopPropagation()
						setFocusedId(id)
						props.onSelect(id)
					}}
					css={treeItemCss}
				>
					<div
						css={rowCss(props.selectedId === id, inactive)}
						data-parent-inactive={
							node.profile.status === 'parent_inactive' ? '' : undefined
						}
					>
						{hasChildren ? (
							<span
								aria-hidden="true"
								css={toggleCss}
								onClick={(event) => {
									event.stopPropagation()
									toggle(id)
								}}
							>
								{open ? '▾' : '▸'}
							</span>
						) : (
							<span aria-hidden="true" css={toggleCss}>
								•
							</span>
						)}
						<span
							css={{
								fontWeight: typography.fontWeight.semibold,
								textDecoration:
									node.profile.status === 'revoked' ? 'line-through' : 'none',
								minWidth: 0,
								overflow: 'hidden',
								textOverflow: 'ellipsis',
							}}
						>
							{node.profile.name}
						</span>
						<ProfileStatusBadge status={node.profile.status} />
						<span css={rowMetaCss}>
							{props.showOwner && node.profile.actingHandle
								? `@${node.profile.actingHandle} · `
								: ''}
							L{node.profile.depth}
							{tokenCount
								? ` · ${tokenCount} token${tokenCount === 1 ? '' : 's'}`
								: ''}
							{node.detached ? ' · parent hidden' : ''}
						</span>
					</div>
					{hasChildren && open ? (
						<ul role="group" css={groupCss}>
							{renderNodes(node.children)}
						</ul>
					) : null}
				</li>
			)
		})
	}

	return (
		<ul
			role="tree"
			aria-label="Agent profiles hierarchy"
			data-testid="profiles-tree"
			onKeyDown={onKeyDown}
			css={treeCss}
		>
			{renderNodes(props.tree)}
		</ul>
	)
}

function toLocalInput(iso: string | null) {
	if (!iso) return ''
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return ''
	const offset = date.getTimezoneOffset() * 60_000
	return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}

function fromLocalInput(value: string) {
	const date = new Date(value)
	return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function failureText(result: MutationResult) {
	if (result.ok) return null
	return result.error === 'profile_expiry_extension'
		? `${result.message} (profile_expiry_extension)`
		: result.message
}

function ProfileDetail(props: {
	node: ProfileTreeNode
	payload: EnabledData
	onAddSubProfile: () => void
}) {
	const { node, payload } = props
	const profile = node.profile
	const viewer = payload.viewer
	const refresh = useRefreshProfilesPage()
	const block = subProfileBlock(profile, viewer)
	const tokens = tokensForProfile(payload.tokens, profile.id)
	const editable = canEditProfile(profile, viewer)
	const parentLimit =
		profile.chain.length > 1
			? (payload.profiles
					.filter((entry) =>
						profile.chain.slice(0, -1).some((link) => link.id === entry.id),
					)
					.map((entry) => entry.expiresAt)
					.filter((value): value is string => Boolean(value))
					.sort()[0] ?? null)
			: null

	return (
		<AccountManagementPanel ariaLabel={`Profile ${profile.name}`}>
			<div
				data-testid="profile-detail"
				css={{ display: 'grid', gap: spacing.md }}
			>
				<div css={{ display: 'grid', gap: '0.35rem' }}>
					<nav aria-label="Parent chain" css={chainCss}>
						{profile.chain.map((link, index) => (
							<span key={link.id}>
								{index > 0 ? <span aria-hidden="true"> › </span> : null}
								<span
									aria-current={link.id === profile.id ? 'true' : undefined}
									css={{
										fontWeight:
											link.id === profile.id
												? typography.fontWeight.semibold
												: undefined,
									}}
								>
									{link.name}
								</span>
							</span>
						))}
					</nav>
					<div
						css={{
							display: 'flex',
							gap: '0.6rem',
							alignItems: 'center',
							flexWrap: 'wrap',
						}}
					>
						<h2 css={{ margin: 0, fontSize: typography.fontSize.lg }}>
							{profile.name}
						</h2>
						<ProfileStatusBadge status={profile.status} />
					</div>
					<p css={{ margin: 0, color: colors.textMuted }}>
						{profileStatusExplanation(profile.status)}
					</p>
				</div>
				<MetadataGrid
					items={[
						{
							label: 'Own expiry',
							value: (
								<TimestampValue value={profile.expiresAt} fallback="Never" />
							),
						},
						{
							label: 'Effective expiry (with parents)',
							value: (
								<TimestampValue
									value={profile.effectiveExpiresAt}
									fallback="Never"
								/>
							),
						},
						{
							label: 'Level',
							value: `${profile.depth} of ${profileTreeMaxDepth}`,
						},
						{
							label: 'Acts for',
							value: profile.actingHandle
								? `@${profile.actingHandle}`
								: 'A member',
						},
						{
							label: 'Created',
							value: <TimestampValue value={profile.createdAt} />,
						},
						{
							label: 'Profile id',
							value: <IdValue value={profile.id} label="profile id" />,
						},
					]}
				/>
				<GrantsList grants={profile.grants} />
				<div css={accountActionsCss}>
					{block === null ? (
						<button
							type="button"
							css={getGhostButtonCss({ size: 'sm' })}
							onClick={props.onAddSubProfile}
						>
							Add sub-profile
						</button>
					) : null}
					{canRevokeProfile(profile, viewer) ? (
						<RevokeProfileButton
							orgSlug={payload.orgSlug}
							profile={profile}
							descendants={descendantCount(node)}
							onDone={refresh}
						/>
					) : null}
				</div>
				{block && block !== 'inactive' && profile.status === 'active' ? (
					<p css={accountFieldNoteCss}>{subProfileBlockMessage(block)}</p>
				) : null}
				{editable ? (
					<ShortenExpiryForm
						orgSlug={payload.orgSlug}
						profile={profile}
						parentLimit={parentLimit}
						onDone={refresh}
					/>
				) : profile.actingUserId !== viewer.userId ? (
					<p css={accountFieldNoteCss}>
						Owners can revoke this profile but not edit it.
					</p>
				) : null}
				{profile.actingUserId === viewer.userId ? (
					<ProfileTokens
						orgSlug={payload.orgSlug}
						profile={profile}
						tokens={tokens}
						onChange={refresh}
					/>
				) : null}
			</div>
		</AccountManagementPanel>
	)
}

function grantResourceLabel(type: string) {
	return type === 'execution_context'
		? 'Execution context'
		: type[0]?.toUpperCase() + type.slice(1)
}

function GrantsList(props: { grants: ProfileItem['grants'] }) {
	return (
		<section aria-label="Grants" css={{ display: 'grid', gap: '0.5rem' }}>
			<h3 css={subheadCss}>What it can reach</h3>
			{props.grants.length === 0 ? (
				<p css={{ margin: 0, color: colors.textMuted }}>
					No grants. Requests as this profile reach only what is shared with it
					directly, such as packages shared with the profile on their
					Collaborators tab.
				</p>
			) : (
				<table css={tableCss}>
					<thead>
						<tr>
							<th scope="col">Resource</th>
							<th scope="col">Type</th>
							<th scope="col">Permissions</th>
						</tr>
					</thead>
					<tbody>
						{props.grants.map((grant) => (
							<tr key={`${grant.resourceType}:${grant.resourceId}`}>
								<td>
									{grant.href ? (
										<SiteLink href={grant.href} css={primaryLinkCss}>
											{grant.label ?? grant.resourceId}
										</SiteLink>
									) : (
										(grant.label ?? <code>{grant.resourceId}</code>)
									)}
								</td>
								<td>{grantResourceLabel(grant.resourceType)}</td>
								<td>
									<span
										css={{ display: 'flex', flexWrap: 'wrap', gap: '0.3rem' }}
									>
										{grant.permissions.map((permission) => (
											<code key={permission} css={chipCss}>
												{permission}
											</code>
										))}
									</span>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</section>
	)
}

function ShortenExpiryForm(props: {
	orgSlug: string
	profile: ProfileItem
	parentLimit: string | null
	onDone: () => Promise<unknown>
}) {
	const [value, setValue] = useState(toLocalInput(props.profile.expiresAt))
	const [message, setMessage] = useState<string | null>(null)
	const [pending, setPending] = useState(false)
	const max = props.profile.effectiveExpiresAt

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const next = fromLocalInput(value)
		if (!next) return setMessage('Pick a valid date and time.')
		const problem = expiryChangeProblem({
			current: props.profile.effectiveExpiresAt,
			parentLimit: props.parentLimit,
			next,
		})
		if (problem) return setMessage(problem)
		setPending(true)
		try {
			const result = (await shortenProfileExpiry({
				data: {
					orgSlug: props.orgSlug,
					profileId: props.profile.id,
					expiresAt: next,
				},
			})) as MutationResult
			setMessage(failureText(result))
			if (result.ok) await props.onDone()
		} catch (error) {
			setMessage(thrownText(error))
		} finally {
			setPending(false)
		}
	}

	return (
		<form onSubmit={submit} noValidate css={{ display: 'grid', gap: '0.5rem' }}>
			<h3 css={subheadCss}>Expiry</h3>
			<label css={accountFieldCss}>
				<span css={accountFieldLabelCss}>Stops working at</span>
				<input
					type="datetime-local"
					value={value}
					max={toLocalInput(max) || undefined}
					onChange={(event) => setValue(event.target.value)}
					css={accountInputCss}
				/>
				<span css={accountFieldNoteCss}>
					Expiry only moves earlier. A later time, or clearing it, is refused
					with <code>profile_expiry_extension</code>; create a new profile for
					more time.
				</span>
			</label>
			<div css={accountActionsCss}>
				<button
					type="submit"
					disabled={pending}
					css={getGhostButtonCss({ size: 'sm' })}
				>
					{pending ? 'Saving…' : 'Shorten expiry'}
				</button>
			</div>
			{message ? (
				<AccountManagementMessage tone="error">
					{message}
				</AccountManagementMessage>
			) : null}
		</form>
	)
}

function RevokeProfileButton(props: {
	orgSlug: string
	profile: ProfileItem
	descendants: number
	onDone: () => Promise<unknown>
}) {
	const dialog = useRef<HTMLDialogElement>(null)
	const [message, setMessage] = useState<string | null>(null)
	const [pending, setPending] = useState(false)

	async function confirm() {
		setPending(true)
		try {
			const result = (await revokeProfile({
				data: { orgSlug: props.orgSlug, profileId: props.profile.id },
			})) as MutationResult
			setMessage(failureText(result))
			if (result.ok) {
				dialog.current?.close()
				await props.onDone()
			}
		} catch (error) {
			setMessage(thrownText(error))
		} finally {
			setPending(false)
		}
	}

	return (
		<>
			<button
				type="button"
				css={getDangerPillCss({ size: 'sm' })}
				onClick={() => dialog.current?.showModal()}
			>
				Revoke
			</button>
			<dialog
				ref={dialog}
				aria-labelledby={`revoke-${props.profile.id}`}
				css={dialogCss}
			>
				<h2
					id={`revoke-${props.profile.id}`}
					css={{ margin: 0, fontSize: typography.fontSize.lg }}
				>
					Revoke {props.profile.name}?
				</h2>
				<p css={{ margin: 0 }}>
					Revoking is final and cannot be undone. Requests and tokens acting as
					this profile stop working right away
					{props.descendants
						? `, and so do its ${props.descendants} sub-profile${props.descendants === 1 ? '' : 's'}`
						: ', and so would any sub-profile below it'}
					.
				</p>
				{message ? (
					<AccountManagementMessage tone="error">
						{message}
					</AccountManagementMessage>
				) : null}
				<div css={accountActionsCss}>
					<button
						type="button"
						disabled={pending}
						css={getDangerPillCss({ size: 'sm' })}
						onClick={() => void confirm()}
					>
						{pending ? 'Revoking…' : 'Revoke for good'}
					</button>
					<button
						type="button"
						css={getGhostButtonCss({ size: 'sm' })}
						onClick={() => dialog.current?.close()}
					>
						Cancel
					</button>
				</div>
			</dialog>
		</>
	)
}

const defaultTokenScopes = ['org:read', 'org:execute']

function ProfileTokens(props: {
	orgSlug: string
	profile: ProfileItem
	tokens: Array<ProfileTokenItem>
	onChange: () => Promise<unknown>
}) {
	const { profile } = props
	const scopeChoices = useMemo(
		() =>
			[
				...new Set([
					...defaultTokenScopes,
					...profile.grants.flatMap((grant) => grant.permissions),
				]),
			].sort(),
		[profile.grants],
	)
	const [name, setName] = useState(profile.name)
	const [lifetime, setLifetime] = useState<'short' | 'long'>('short')
	const [scopes, setScopes] = useState<Set<string>>(() => new Set(scopeChoices))
	const [secret, setSecret] = useState<string | null>(null)
	const [message, setMessage] = useState<string | null>(null)
	const [pending, setPending] = useState(false)
	useEffect(() => () => setSecret(null), [])

	async function mint(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!scopes.size) return setMessage('Pick at least one scope.')
		setPending(true)
		setMessage(null)
		try {
			const result = (await createProfileToken({
				data: {
					orgSlug: props.orgSlug,
					profileId: profile.id,
					name: name.trim() || profile.name,
					scopes: [...scopes],
					lifetime,
				},
			})) as MutationResult
			if (result.ok && typeof result.token === 'string') {
				setSecret(result.token)
				await props.onChange()
			} else setMessage(failureText(result))
		} catch (error) {
			setMessage(thrownText(error))
		} finally {
			setPending(false)
		}
	}

	async function revoke(tokenId: string) {
		try {
			const result = (await revokeProfileToken({
				data: { orgSlug: props.orgSlug, tokenId },
			})) as MutationResult
			setMessage(failureText(result))
			if (result.ok) await props.onChange()
		} catch (error) {
			setMessage(thrownText(error))
		}
	}

	return (
		<section
			aria-label="Profile tokens"
			css={{ display: 'grid', gap: '0.6rem' }}
		>
			<h3 css={subheadCss}>Tokens</h3>
			{props.tokens.length === 0 ? (
				<p css={{ margin: 0, color: colors.textMuted }}>
					No tokens act as this profile yet.
				</p>
			) : (
				<table css={tableCss} data-testid="profile-tokens">
					<thead>
						<tr>
							<th scope="col">Name</th>
							<th scope="col">Status</th>
							<th scope="col">Expires</th>
							<th scope="col">
								<span
									css={{
										position: 'absolute',
										width: 1,
										height: 1,
										overflow: 'hidden',
										clip: 'rect(0 0 0 0)',
									}}
								>
									Actions
								</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{props.tokens.map((token) => (
							<tr key={token.id}>
								<td>{token.name}</td>
								<td>{token.status}</td>
								<td>
									<TimestampValue
										value={token.status === 'active' ? token.expiresAt : null}
									/>
								</td>
								<td>
									{token.status === 'active' ? (
										<button
											type="button"
											css={getDangerPillCss({ size: 'sm' })}
											onClick={() => void revoke(token.id)}
											aria-label={`Revoke token ${token.name}`}
										>
											Revoke
										</button>
									) : null}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{secret ? (
				<div role="status" css={secretCss} data-testid="profile-token-secret">
					<strong>Copy this token now. Kody will not show it again.</strong>
					<code css={{ overflowWrap: 'anywhere' }}>{secret}</code>
					<div css={accountActionsCss}>
						<CopyTextButton
							value={secret}
							variant="secondary"
							idleLabel="Copy token"
						/>
						<button
							type="button"
							css={getGhostButtonCss({ size: 'sm' })}
							onClick={() => setSecret(null)}
						>
							Done
						</button>
					</div>
				</div>
			) : profile.status === 'active' ? (
				<form
					onSubmit={mint}
					noValidate
					css={{ display: 'grid', gap: '0.5rem' }}
				>
					<label css={accountFieldCss}>
						<span css={accountFieldLabelCss}>Token name</span>
						<input
							value={name}
							maxLength={100}
							onChange={(event) => setName(event.target.value)}
							css={accountInputCss}
						/>
					</label>
					<label css={accountFieldCss}>
						<span css={accountFieldLabelCss}>Lifetime</span>
						<select
							value={lifetime}
							onChange={(event) =>
								setLifetime(event.target.value === 'long' ? 'long' : 'short')
							}
							css={getSelectCss()}
						>
							<option value="short">Short: 1 hour idle, 24 hours max</option>
							<option value="long">Long: 14 days idle, 3 months max</option>
						</select>
						<span css={accountFieldNoteCss}>
							Never outlives the profile chain’s expiry.
						</span>
					</label>
					<fieldset css={fieldsetCss}>
						<legend css={accountFieldLabelCss}>Scopes</legend>
						{scopeChoices.map((scope) => (
							<label key={scope} css={checkLabelCss}>
								<input
									type="checkbox"
									checked={scopes.has(scope)}
									onChange={(event) =>
										setScopes((current) => {
											const next = new Set(current)
											if (event.target.checked) next.add(scope)
											else next.delete(scope)
											return next
										})
									}
								/>
								<code>{scope}</code>
							</label>
						))}
					</fieldset>
					<div css={accountActionsCss}>
						<button
							type="submit"
							disabled={pending}
							css={getGhostButtonCss({ size: 'sm' })}
						>
							{pending ? 'Creating…' : 'Create profile token'}
						</button>
					</div>
				</form>
			) : null}
			{message ? (
				<AccountManagementMessage tone="error">
					{message}
				</AccountManagementMessage>
			) : null}
		</section>
	)
}

function thrownText(error: unknown) {
	return error instanceof Error && error.message
		? error.message
		: 'Something went wrong.'
}

function CreateProfilePanel(props: {
	orgSlug: string
	parent: ProfileItem | null
	grantOptions: Array<ProfileGrantOption>
	onCancel: () => void
	onCreated: (id: string | null) => void
}) {
	const { parent } = props
	const refresh = useRefreshProfilesPage()
	const [name, setName] = useState('')
	const [expiry, setExpiry] = useState('')
	const [picked, setPicked] = useState<Map<string, Set<string>>>(
		() => new Map(),
	)
	const [message, setMessage] = useState<string | null>(null)
	const [pending, setPending] = useState(false)
	const limit = parent?.effectiveExpiresAt ?? null

	function keyOf(option: ProfileGrantOption) {
		return `${option.resourceType}:${option.resourceId}`
	}
	function togglePermission(
		option: ProfileGrantOption,
		permission: string,
		on: boolean,
	) {
		setPicked((current) => {
			const next = new Map(current)
			const set = new Set(next.get(keyOf(option)) ?? [])
			if (on) set.add(permission)
			else set.delete(permission)
			if (set.size) next.set(keyOf(option), set)
			else next.delete(keyOf(option))
			return next
		})
	}

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const trimmed = name.trim()
		if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(trimmed))
			return setMessage(
				'Use lowercase letters, digits, and dashes, starting with a letter or digit.',
			)
		let expiresAt: string | null = null
		if (expiry) {
			expiresAt = fromLocalInput(expiry)
			const problem = expiresAt
				? expiryChangeProblem({
						current: null,
						parentLimit: limit,
						next: expiresAt,
					})
				: 'Pick a valid date and time.'
			if (problem) return setMessage(problem)
		}
		const grants = props.grantOptions.flatMap((option) => {
			const permissions = [...(picked.get(keyOf(option)) ?? [])]
			return permissions.length
				? [
						{
							resourceType: option.resourceType,
							resourceId: option.resourceId,
							permissions,
						},
					]
				: []
		})
		setPending(true)
		setMessage(null)
		try {
			const result = (await createProfile({
				data: {
					orgSlug: props.orgSlug,
					name: trimmed,
					parentProfileId: parent?.id ?? null,
					expiresAt,
					grants,
				},
			})) as MutationResult
			if (!result.ok) return setMessage(failureText(result))
			props.onCreated(
				typeof result.profileId === 'string' ? result.profileId : null,
			)
			await refresh()
		} catch (error) {
			setMessage(thrownText(error))
		} finally {
			setPending(false)
		}
	}

	return (
		<AccountManagementPanel
			asForm
			onSubmit={submit}
			title={parent ? `New sub-profile under ${parent.name}` : 'New profile'}
			description={
				parent
					? `It sits at level ${parent.depth + 1} of ${profileTreeMaxDepth} and can only hold what ${parent.chain.map((link) => link.name).join(' › ')} holds.`
					: 'A top-level profile for one agent or bot. Each grant must be one you hold now.'
			}
		>
			<div
				data-testid="profile-create"
				css={{ display: 'grid', gap: spacing.md }}
			>
				<label css={accountFieldCss}>
					<span css={accountFieldLabelCss}>Name</span>
					<input
						name="name"
						required
						autoFocus
						value={name}
						maxLength={63}
						placeholder="release-bot"
						onChange={(event) => setName(event.target.value.toLowerCase())}
						css={accountInputCss}
					/>
					<span css={accountFieldNoteCss}>
						Lowercase letters, digits, and dashes. Unique among your profiles
						under the same parent.
					</span>
				</label>
				<label css={accountFieldCss}>
					<span css={accountFieldLabelCss}>Expires (optional)</span>
					<input
						type="datetime-local"
						value={expiry}
						max={toLocalInput(limit) || undefined}
						onChange={(event) => setExpiry(event.target.value)}
						css={accountInputCss}
					/>
					<span css={accountFieldNoteCss}>
						{limit
							? 'Leave empty to inherit the parent chain’s expiry. It can never be later than that.'
							: 'Leave empty for no expiry. You can shorten it later, never extend it.'}
					</span>
				</label>
				<fieldset css={fieldsetCss}>
					<legend css={accountFieldLabelCss}>Grants</legend>
					{props.grantOptions.length === 0 ? (
						<p css={{ margin: 0, color: colors.textMuted }}>
							{parent
								? `${parent.name} holds no grants, so this sub-profile cannot hold any either.`
								: 'Nothing to grant yet. You can still create the profile and share packages with it later.'}
						</p>
					) : (
						props.grantOptions.map((option) => (
							<div key={keyOf(option)} css={grantOptionCss}>
								<span css={{ fontWeight: typography.fontWeight.semibold }}>
									{option.label}{' '}
									<span css={{ color: colors.textMuted, fontWeight: 'normal' }}>
										{grantResourceLabel(option.resourceType)}
									</span>
								</span>
								<span
									css={{
										display: 'flex',
										flexWrap: 'wrap',
										gap: '0.3rem 0.9rem',
									}}
								>
									{option.permissions.map((permission) => (
										<label key={permission} css={checkLabelCss}>
											<input
												type="checkbox"
												checked={
													picked.get(keyOf(option))?.has(permission) ?? false
												}
												onChange={(event) =>
													togglePermission(
														option,
														permission,
														event.target.checked,
													)
												}
											/>
											<code>{permission}</code>
										</label>
									))}
								</span>
							</div>
						))
					)}
					<span css={accountFieldNoteCss}>
						{parent
							? 'Only grants every parent still holds are offered. Kody checks again when you save.'
							: 'Kody refuses any permission you do not hold on that resource.'}
					</span>
				</fieldset>
				{message ? (
					<AccountManagementMessage tone="error">
						{message}
					</AccountManagementMessage>
				) : null}
				<div css={accountActionsCss}>
					<button
						type="submit"
						disabled={pending}
						css={getPillButtonCss({ size: 'sm' })}
					>
						{pending
							? 'Creating…'
							: parent
								? 'Create sub-profile'
								: 'Create profile'}
					</button>
					<button
						type="button"
						css={getGhostButtonCss({ size: 'sm' })}
						onClick={props.onCancel}
					>
						Cancel
					</button>
				</div>
			</div>
		</AccountManagementPanel>
	)
}

function AgentHints(props: {
	orgSlug: string
	personalOrg: boolean
	profileId?: string
}) {
	const hints = profileAgentHints(props)
	return (
		<details css={hintsCss} data-testid="profiles-agent-hints">
			<summary
				css={{ cursor: 'pointer', fontWeight: typography.fontWeight.semibold }}
			>
				Do this from an agent (MCP or CLI)
			</summary>
			<p css={{ margin: '0.5rem 0 0', color: colors.textMuted }}>
				Every action here is the same capability agents call. Through Kody MCP{' '}
				<code>execute</code>:
			</p>
			<pre css={preCss}>{hints.mcp.join('\n')}</pre>
			<p css={{ margin: 0, color: colors.textMuted }}>
				Or with <code>npx @kodycodes/cli</code>:
			</p>
			<pre css={preCss}>{hints.cli.join('\n')}</pre>
		</details>
	)
}

const layoutCss: CSSObject = {
	display: 'grid',
	gap: spacing.lg,
	gridTemplateColumns: 'repeat(auto-fit, minmax(min(22rem, 100%), 1fr))',
	alignItems: 'start',
}

const segmentedCss: CSSObject = {
	display: 'inline-flex',
	gap: '0.25rem',
	padding: '0.2rem',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.full,
	width: 'fit-content',
}

function segmentCss(active: boolean): CSSObject {
	return {
		padding: '0.3rem 0.85rem',
		borderRadius: radius.full,
		textDecoration: 'none',
		fontSize: typography.fontSize.sm,
		color: active ? colors.onPrimary : colors.text,
		backgroundColor: active ? colors.primary : 'transparent',
	}
}

const treeCss: CSSObject = {
	listStyle: 'none',
	margin: 0,
	padding: 0,
	display: 'grid',
	gap: '0.15rem',
}

const groupCss: CSSObject = {
	listStyle: 'none',
	margin: '0.15rem 0 0 0.85rem',
	padding: '0 0 0 0.9rem',
	borderInlineStart: `1px solid ${colors.border}`,
	display: 'grid',
	gap: '0.15rem',
}

const treeItemCss: CSSObject = {
	position: 'relative',
	outline: 'none',
	'ul[role="group"] > &::before': {
		content: '""',
		position: 'absolute',
		insetInlineStart: '-0.9rem',
		top: '1.05rem',
		width: '0.8rem',
		borderTop: `1px solid ${colors.border}`,
	},
	'&:focus-visible > div': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: 1,
	},
}

function rowCss(selected: boolean, inactive: boolean): CSSObject {
	return {
		display: 'flex',
		alignItems: 'center',
		gap: '0.5rem',
		minHeight: '2.1rem',
		padding: '0.25rem 0.5rem',
		borderRadius: radius.md,
		cursor: 'pointer',
		border: `1px solid ${selected ? colors.primary : 'transparent'}`,
		backgroundColor: selected ? colors.primarySoftest : 'transparent',
		opacity: inactive ? 0.72 : 1,
		'&[data-parent-inactive]': {
			borderStyle: 'dashed',
			borderColor: selected ? colors.primary : colors.border,
		},
		':hover': { backgroundColor: colors.primarySoftest },
	}
}

const toggleCss: CSSObject = {
	width: '1rem',
	flexShrink: 0,
	textAlign: 'center',
	color: colors.textMuted,
}

const rowMetaCss: CSSObject = {
	marginInlineStart: 'auto',
	color: colors.textMuted,
	fontSize: typography.fontSize.xs,
	whiteSpace: 'nowrap',
}

const chainCss: CSSObject = {
	color: colors.textMuted,
	fontSize: typography.fontSize.sm,
}

const subheadCss: CSSObject = {
	margin: 0,
	fontSize: typography.fontSize.base,
}

const tableCss: CSSObject = {
	width: '100%',
	borderCollapse: 'collapse',
	fontSize: typography.fontSize.sm,
	'th, td': {
		textAlign: 'start',
		padding: '0.4rem 0.5rem',
		borderBottom: `1px solid ${colors.borderSubtle}`,
		verticalAlign: 'top',
	},
	th: { color: colors.textMuted, fontWeight: typography.fontWeight.medium },
}

const chipCss: CSSObject = {
	fontSize: typography.fontSize.xs,
	padding: '0.05rem 0.35rem',
	borderRadius: radius.sm,
	border: `1px solid ${colors.border}`,
	backgroundColor: colors.background,
}

const fieldsetCss: CSSObject = {
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	padding: '0.6rem 0.8rem',
	margin: 0,
	display: 'grid',
	gap: '0.6rem',
}

const grantOptionCss: CSSObject = {
	display: 'grid',
	gap: '0.3rem',
	paddingBottom: '0.5rem',
	borderBottom: `1px solid ${colors.borderSubtle}`,
}

const checkLabelCss: CSSObject = {
	display: 'inline-flex',
	alignItems: 'center',
	gap: '0.35rem',
	fontSize: typography.fontSize.sm,
}

const secretCss: CSSObject = {
	display: 'grid',
	gap: '0.5rem',
	padding: '0.75rem',
	borderRadius: radius.md,
	border: `1px solid ${colors.warning}`,
	backgroundColor: `color-mix(in srgb, ${colors.warning} 10%, transparent)`,
}

const dialogCss: CSSObject = {
	maxWidth: '28rem',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.lg,
	padding: spacing.lg,
	backgroundColor: colors.surface,
	color: colors.text,
	'&[open]': { display: 'grid', gap: spacing.md },
	'&::backdrop': { backgroundColor: 'rgba(0, 0, 0, 0.45)' },
}

const hintsCss: CSSObject = {
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	padding: '0.75rem 1rem',
	display: 'grid',
	gap: '0.5rem',
}

const preCss: CSSObject = {
	margin: 0,
	padding: '0.6rem 0.75rem',
	borderRadius: radius.sm,
	backgroundColor: colors.background,
	border: `1px solid ${colors.border}`,
	overflowX: 'auto',
	fontSize: typography.fontSize.xs,
}
