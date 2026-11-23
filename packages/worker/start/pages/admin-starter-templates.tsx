/** @jsxImportSource @emotion/react */
import { Alert } from '../components/alert.tsx'
import { Badge } from '../components/badge.tsx'
import { Button } from '../components/button.tsx'
import { Switch } from '../components/choice-controls.tsx'
import { Combobox } from '../components/combobox.tsx'
import { Field } from '../components/field.tsx'
import { renderIcon } from '../components/icon.tsx'
import { Input, Textarea } from '../components/input.tsx'
import { formatTimestampDate } from '../components/local-timestamp.tsx'
import { createUiFeedback, type UiFeedback } from '#client/ui-feedback.ts'
import { textSearch } from '../filter-search.ts'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import {
	filterStarterTemplates,
	moveStarter,
	starterTemplatesRoute,
} from '#client/routes/admin-starter-templates-shared.ts'
import {
	addAdminAppStarter,
	removeAdminAppStarter,
	reorderAdminAppStarters,
	updateAdminAppStarter,
} from '#start/server/admin-mutations'
import type {
	AdminStarterTemplate,
	AdminStarterTemplateCandidate,
	AdminStarterTemplateCheck,
	AdminStarterTemplatesLoaderData,
} from '#universal/loader-data.ts'
import {
	cardTitleCss,
	descriptionCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { useRouter } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { useState, type FormEvent } from 'react'
import { usePageInvalidation } from '../page-invalidation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import {
	AccountManagementMessage,
	AccountManagementShell,
	AdminPageHeader,
} from './account-management-components.tsx'
import {
	RecordChips,
	RecordTable,
	RecordTableSearch,
	recordBodyCss,
	recordCellClamp,
	recordStampCss,
} from './record-table.tsx'

function StarterPreview(props: {
	url: string | null
	missing?: boolean
	size?: 'sm' | 'md'
}) {
	const size = props.size ?? 'sm'
	const width = size === 'sm' ? 72 : 160
	const height = size === 'sm' ? 48 : 100
	const chrome = size === 'sm' ? 6 : 10
	const dot = {
		width: size === 'sm' ? 3 : 6,
		height: size === 'sm' ? 3 : 6,
		borderRadius: radius.full,
		backgroundColor: colors.primary,
	} as const
	return (
		<div
			aria-hidden="true"
			css={{
				width,
				height,
				flex: 'none',
				borderRadius: radius.sm,
				border: `1px solid ${colors.border}`,
				backgroundColor: colors.background,
				overflow: 'hidden',
				display: 'grid',
				gridTemplateRows: 'auto 1fr',
				boxShadow: `inset 0 0 0 1px ${colors.borderSubtle}`,
			}}
		>
			<div
				css={{
					height: chrome,
					backgroundColor: colors.primarySoft,
					display: 'flex',
					alignItems: 'center',
					gap: size === 'sm' ? 2 : 4,
					padding: `0 ${size === 'sm' ? 4 : 8}px`,
				}}
			>
				<span css={dot} />
				<span css={dot} />
				<span css={dot} />
			</div>
			{props.missing ? (
				<div
					css={{
						display: 'grid',
						placeItems: 'center',
						color: colors.danger,
						fontSize: typography.fontSize.xs,
						backgroundColor:
							'color-mix(in srgb, var(--color-danger) 8%, var(--color-surface))',
					}}
				>
					Missing
				</div>
			) : props.url ? (
				<img
					src={props.url}
					alt=""
					loading="lazy"
					css={{
						width: '100%',
						height: '100%',
						objectFit: 'cover',
						objectPosition: 'top',
						backgroundColor: colors.surface,
					}}
				/>
			) : (
				<div css={{ backgroundColor: colors.surface }} />
			)}
		</div>
	)
}

function RankControls(props: {
	rank: number
	first: boolean
	last: boolean
	disabled: boolean
	onMove: (by: -1 | 1) => void
}) {
	return (
		<div
			css={{ display: 'inline-flex', alignItems: 'center', gap: spacing.xs }}
		>
			<span
				css={{
					fontVariantNumeric: 'tabular-nums',
					fontWeight: typography.fontWeight.semibold,
					minWidth: '1.2ch',
				}}
			>
				{props.rank}
			</span>
			<span css={{ display: 'grid', gap: 1 }}>
				<Button
					type="button"
					variant="ghost"
					size="xs"
					iconOnly
					disabled={props.disabled || props.first}
					aria-label={`Move up from rank ${props.rank}`}
					onClick={() => props.onMove(-1)}
				>
					{renderIcon('chevron-up', { size: '0.85rem' })}
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="xs"
					iconOnly
					disabled={props.disabled || props.last}
					aria-label={`Move down from rank ${props.rank}`}
					onClick={() => props.onMove(1)}
				>
					{renderIcon('chevron-down', { size: '0.85rem' })}
				</Button>
			</span>
		</div>
	)
}

function StatusBadge(props: { status: AdminStarterTemplate['status'] }) {
	return props.status === 'ready' ? (
		<Badge tone="accent">Ready</Badge>
	) : (
		<Badge tone="danger">Failed</Badge>
	)
}

function CheckRow(props: { check: AdminStarterTemplateCheck }) {
	return (
		<div
			css={{
				display: 'grid',
				gridTemplateColumns: 'auto minmax(0, 1fr)',
				columnGap: spacing.sm,
				rowGap: 2,
				padding: `${spacing.xs} 0`,
				borderTop: `1px solid ${colors.borderSubtle}`,
			}}
		>
			<span
				css={{
					display: 'inline-flex',
					alignItems: 'center',
					gap: spacing.xs,
					color: props.check.ok ? colors.primaryText : colors.danger,
					fontWeight: typography.fontWeight.semibold,
					fontSize: typography.fontSize.sm,
					paddingTop: 1,
				}}
			>
				{renderIcon(props.check.ok ? 'check' : 'close', { size: '0.95rem' })}
				<code
					css={{
						fontFamily: typography.fontFamilyMono,
						fontSize: typography.fontSize.xs,
					}}
				>
					{props.check.label}
				</code>
			</span>
			<p
				css={{
					margin: 0,
					gridColumn: '2',
					color: props.check.ok ? colors.textMuted : colors.danger,
					fontSize: typography.fontSize.sm,
				}}
			>
				{props.check.detail}
			</p>
		</div>
	)
}

function ManifestPreview(props: { candidate: AdminStarterTemplateCandidate }) {
	const failed = props.candidate.checks.filter((check) => !check.ok)
	const previewCheck = props.candidate.checks.find(
		(check) => check.id === 'preview',
	)
	return (
		<div css={{ display: 'grid', gap: spacing.md }}>
			{failed.length === 0 ? (
				<Alert tone="info">
					This package is ready to add. Agents will see the name, description,
					and whenToUse text from the manifest.
				</Alert>
			) : (
				<Alert tone="error">
					This package cannot be added until the starter manifest and
					conventions pass. {failed.length}{' '}
					{failed.length === 1 ? 'check failed' : 'checks failed'}.
				</Alert>
			)}
			<div
				css={{
					display: 'grid',
					gridTemplateColumns: 'auto minmax(0, 1fr)',
					gap: spacing.md,
					alignItems: 'start',
				}}
			>
				<StarterPreview
					url={props.candidate.previewUrl}
					missing={previewCheck ? !previewCheck.ok : true}
					size="md"
				/>
				<div css={{ display: 'grid', gap: spacing.xs, minWidth: 0 }}>
					<h3 css={{ ...cardTitleCss, fontSize: typography.fontSize.base }}>
						Validated starter manifest
					</h3>
					<p css={descriptionCss}>
						Read from the kody.starter key in package.json, plus the starter
						conventions. These fields are not edited here. Fix them in the
						package, then add it again.
					</p>
					{previewCheck ? (
						<p css={{ ...descriptionCss, margin: 0 }}>
							Preview path: {previewCheck.detail}
						</p>
					) : null}
				</div>
			</div>
			<div>
				{props.candidate.checks.map((check) => (
					<CheckRow key={check.id} check={check} />
				))}
			</div>
		</div>
	)
}

function AddStarterForm(props: {
	payload: AdminStarterTemplatesLoaderData
	defaultRank: number
	disabled: boolean
	onPick: (packageName: string) => void
	onAdd: (input: { package: string; rank: number; enabled: boolean }) => void
	onCancel: () => void
}) {
	const { candidate, candidateError, candidates } = props.payload
	const [enabled, setEnabled] = useState(true)
	const canAdd = candidate?.canAdd ?? false
	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!candidate || !canAdd) return
		const rank = Number(new FormData(event.currentTarget).get('rank'))
		props.onAdd({
			package: candidate.packageName,
			rank: Number.isInteger(rank) && rank >= 1 ? rank : props.defaultRank,
			enabled,
		})
	}
	return (
		<form css={recordBodyCss} onSubmit={handleSubmit}>
			<div css={{ display: 'grid', gap: spacing.xs }}>
				<h2 css={cardTitleCss}>Add starter</h2>
				<p css={descriptionCss}>
					Pick an existing package from the Kody org. This does not create a
					package. Kody reads the kody.starter key and checks the starter
					conventions before you can add it to the list.
				</p>
			</div>
			<div css={{ display: 'grid', gap: spacing.xs }}>
				<Combobox
					id="starter-package"
					label="Kody org package"
					placeholder="Search packages in the Kody org"
					value={candidate?.packageName ?? ''}
					disabled={props.disabled}
					options={candidates.map((option) => ({
						id: option.packageName,
						label: option.packageName,
						keywords: [option.kodyId],
					}))}
					onChange={props.onPick}
				/>
				<p css={descriptionCss}>
					Search packages in the Kody org. Packages already on this list are
					omitted.
				</p>
			</div>
			{candidateError ? <Alert tone="error">{candidateError}</Alert> : null}
			{candidate ? <ManifestPreview candidate={candidate} /> : null}
			{candidate && canAdd ? (
				<div
					css={{
						display: 'grid',
						gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
						gap: spacing.md,
					}}
				>
					<Field
						label="Rank"
						description="Where this starter appears in the recommended list. Lower numbers are recommended first."
					>
						<Input
							name="rank"
							type="number"
							defaultValue={props.defaultRank}
							min={1}
							max={props.defaultRank}
						/>
					</Field>
					<Field
						label="Enabled"
						description="When off, the starter stays on the list but is not recommended to agents."
					>
						<Switch checked={enabled} onCheckedChange={setEnabled} />
					</Field>
				</div>
			) : null}
			<div
				css={{
					display: 'flex',
					flexWrap: 'wrap',
					gap: spacing.sm,
					alignItems: 'center',
				}}
			>
				<Button
					type="submit"
					variant={canAdd ? 'primary' : 'secondary'}
					disabled={!canAdd || props.disabled}
				>
					Add to starters
				</Button>
				<Button type="button" variant="secondary" onClick={props.onCancel}>
					Cancel
				</Button>
				{candidate && !canAdd ? (
					<span
						css={{ color: colors.danger, fontSize: typography.fontSize.sm }}
					>
						Add is blocked until every check passes.
					</span>
				) : null}
			</div>
		</form>
	)
}

function EditStarterForm(props: {
	starter: AdminStarterTemplate
	disabled: boolean
	onSave: (input: { rank: number; enabled: boolean; note: string }) => void
	onCancel: () => void
	onRemove: () => void
}) {
	const [enabled, setEnabled] = useState(props.starter.enabled)
	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const formData = new FormData(event.currentTarget)
		const rank = Number(formData.get('rank'))
		props.onSave({
			rank: Number.isInteger(rank) && rank >= 1 ? rank : props.starter.rank,
			enabled,
			note: String(formData.get('adminNote') ?? ''),
		})
	}
	return (
		<form css={recordBodyCss} onSubmit={handleSubmit}>
			<div
				css={{
					display: 'flex',
					justifyContent: 'space-between',
					gap: spacing.md,
					flexWrap: 'wrap',
					alignItems: 'flex-start',
				}}
			>
				<div css={{ display: 'grid', gap: spacing.xs, minWidth: 0 }}>
					<h2 css={cardTitleCss}>Edit list settings</h2>
					<p css={descriptionCss}>
						These settings belong to the recommended list, not to the package.
						To change the name, description, or preview, update the package and
						publish it.
					</p>
				</div>
				<StatusBadge status={props.starter.status} />
			</div>
			<div
				css={{
					display: 'grid',
					gridTemplateColumns: 'auto minmax(0, 1fr)',
					gap: spacing.md,
					alignItems: 'start',
				}}
			>
				<StarterPreview
					url={props.starter.previewUrl}
					missing={!props.starter.previewUrl}
					size="md"
				/>
				<div css={{ display: 'grid', gap: spacing.xs, minWidth: 0 }}>
					<strong>{props.starter.name}</strong>
					<code
						css={{
							fontFamily: typography.fontFamilyMono,
							fontSize: typography.fontSize.sm,
							color: colors.textMuted,
						}}
					>
						{props.starter.packageName}
					</code>
					<p css={{ margin: 0, color: colors.textMuted }}>
						{props.starter.description}
					</p>
					<RecordChips items={props.starter.tags} />
				</div>
			</div>
			<div
				css={{
					display: 'grid',
					gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
					gap: spacing.md,
				}}
			>
				<Field label="Rank" description="Lower numbers are recommended first.">
					<Input
						name="rank"
						type="number"
						min={1}
						defaultValue={props.starter.rank}
					/>
				</Field>
				<Field
					label="Enabled"
					description="When off, agents are not recommended this starter. The package stays on the list."
				>
					<Switch checked={enabled} onCheckedChange={setEnabled} />
				</Field>
			</div>
			<Field
				label="Admin note"
				description="Optional note for operators. Agents never see this."
			>
				<Textarea
					name="adminNote"
					rows={3}
					maxLength={500}
					defaultValue={props.starter.note ?? ''}
					placeholder="Why this starter is ranked or turned off"
				/>
			</Field>
			<div
				css={{
					display: 'flex',
					flexWrap: 'wrap',
					gap: spacing.sm,
					alignItems: 'center',
				}}
			>
				<Button type="submit" variant="primary" disabled={props.disabled}>
					Save changes
				</Button>
				<Button type="button" variant="secondary" onClick={props.onCancel}>
					Cancel edit
				</Button>
			</div>
			<div
				css={{
					display: 'grid',
					gap: spacing.sm,
					paddingTop: spacing.md,
					borderTop: `1px solid ${colors.borderSubtle}`,
				}}
			>
				<h3 css={{ ...cardTitleCss, fontSize: typography.fontSize.base }}>
					Remove from starters
				</h3>
				<p css={descriptionCss}>
					Removes this package from the recommended list. The package itself is
					not deleted.
				</p>
				<div>
					<Button
						type="button"
						variant="danger"
						disabled={props.disabled}
						onClick={props.onRemove}
					>
						Remove from starters
					</Button>
				</div>
			</div>
		</form>
	)
}

function StarterNameCell(props: {
	starter: AdminStarterTemplate
	moved: boolean
}) {
	return (
		<div
			css={{
				display: 'grid',
				gridTemplateColumns: 'auto minmax(0, 1fr)',
				gap: spacing.sm,
				alignItems: 'start',
				opacity: props.starter.enabled ? 1 : 0.72,
			}}
		>
			<StarterPreview
				url={props.starter.previewUrl}
				missing={!props.starter.previewUrl}
			/>
			<div css={{ display: 'grid', gap: 2, minWidth: 0 }}>
				<span
					css={{
						display: 'flex',
						flexWrap: 'wrap',
						gap: spacing.xs,
						alignItems: 'center',
					}}
				>
					<span css={{ fontWeight: typography.fontWeight.semibold }}>
						{props.starter.name}
					</span>
					{props.moved ? <Badge tone="accent">Moved</Badge> : null}
				</span>
				<code
					css={{
						fontFamily: typography.fontFamilyMono,
						fontSize: typography.fontSize.xs,
						color: colors.textMuted,
						...recordCellClamp(36),
					}}
				>
					{props.starter.packageName}
				</code>
				<span
					css={{
						color: colors.textMuted,
						fontSize: typography.fontSize.sm,
						display: '-webkit-box',
						WebkitLineClamp: 2,
						WebkitBoxOrient: 'vertical',
						overflow: 'hidden',
					}}
				>
					{props.starter.description}
				</span>
				<RecordChips items={props.starter.tags} />
			</div>
		</div>
	)
}

function SaveOrderBar(props: {
	disabled: boolean
	onDiscard: () => void
	onSave: () => void
}) {
	return (
		<div
			css={{
				display: 'flex',
				flexWrap: 'wrap',
				alignItems: 'center',
				justifyContent: 'space-between',
				gap: spacing.md,
				padding: spacing.md,
				border: `1px solid ${colors.border}`,
				borderRadius: radius.md,
				backgroundColor: colors.primarySoftest,
				boxShadow: shadows.sm,
			}}
		>
			<p css={{ margin: 0 }}>
				Starter order has changed. Save to update what agents are recommended
				first.
			</p>
			<div css={{ display: 'flex', flexWrap: 'wrap', gap: spacing.sm }}>
				<Button type="button" variant="secondary" onClick={props.onDiscard}>
					Discard
				</Button>
				<Button
					type="button"
					variant="primary"
					disabled={props.disabled}
					onClick={props.onSave}
				>
					Save order
				</Button>
			</div>
		</div>
	)
}

const startersTableCss = {
	'@container (min-width: 621px)': {
		'& thead th:nth-child(1), & tbody tr:not([data-record-row]) > td:nth-child(1)':
			{ width: '4.75rem' },
		'& thead th:nth-child(3), & tbody tr:not([data-record-row]) > td:nth-child(3)':
			{ width: '7rem' },
		'& thead th:nth-child(4), & tbody tr:not([data-record-row]) > td:nth-child(4)':
			{ width: '7rem' },
		'& thead th:nth-child(5), & tbody tr:not([data-record-row]) > td:nth-child(5)':
			{ width: '7.5rem' },
		'& td[data-primary]': {
			whiteSpace: 'normal',
			overflow: 'visible',
		},
	},
	'& td[data-primary] a': {
		display: 'block',
		whiteSpace: 'normal',
	},
} as const

export function AdminStarterTemplatesPage(props: {
	payload: AdminStarterTemplatesLoaderData
	currentHref: string
	selection: { selectedId: string | null; isCreating: boolean }
}) {
	const { starters } = props.payload
	const { pageLocation } = useMatchedPageScope()
	const router = useRouter()
	const captureSubmitter = useSubmitterScope()
	const invalidate = usePageInvalidation(['loadAdminStarterTemplates'])
	const mutationOptions = {
		gcTime: 0,
		onMutate: () => invalidate,
		onSettled: (
			_data: unknown,
			_error: unknown,
			_input: unknown,
			reconcile: (() => void) | undefined,
		) => reconcile?.(),
	}
	const addMutation = useMutation({
		...mutationOptions,
		mutationFn: addAdminAppStarter,
	})
	const updateMutation = useMutation({
		...mutationOptions,
		mutationFn: updateAdminAppStarter,
	})
	const reorderMutation = useMutation({
		...mutationOptions,
		mutationFn: reorderAdminAppStarters,
	})
	const removeMutation = useMutation({
		...mutationOptions,
		mutationFn: removeAdminAppStarter,
	})
	const isMutating =
		addMutation.isPending ||
		updateMutation.isPending ||
		reorderMutation.isPending ||
		removeMutation.isPending
	const [feedback, setFeedback] = useState<UiFeedback | null>(null)
	const [pendingOrder, setPendingOrder] = useState<Array<string> | null>(null)
	const [movedId, setMovedId] = useState<string | null>(null)

	const searchStr = pageLocation.searchStr
	const filters = textSearch(pageLocation.search)
	const search = filters.q?.trim() ?? ''
	const byId = new Map(starters.map((starter) => [starter.packageId, starter]))
	const ordered = (pendingOrder ?? starters.map((starter) => starter.packageId))
		.map((id, index) => {
			const starter = byId.get(id)
			return starter ? { ...starter, rank: index + 1 } : null
		})
		.filter((starter) => starter !== null)
	const visible = filterStarterTemplates(ordered, search)
	const selection = props.selection
	const editingStarter = selection.isCreating
		? null
		: (starters.find((starter) => starter.packageId === selection.selectedId) ??
			null)

	const navigate = (href: string) => router.navigate({ href, replace: true })
	const listHref = starterTemplatesRoute.buildListHref(searchStr)

	async function run(action: () => Promise<unknown>, nextHref?: string) {
		if (isMutating) return
		const isCurrent = captureSubmitter()
		setFeedback(null)
		try {
			await action()
			if (!isCurrent()) return
			if (nextHref) await navigate(nextHref)
		} catch (error) {
			if (!isCurrent()) return
			setFeedback(
				createUiFeedback(
					error instanceof Error ? error.message : 'Something went wrong.',
					'error',
				),
			)
		}
	}

	function updateSearch(q: string) {
		const samePage = router.latestLocation.pathname === pageLocation.pathname
		return router.navigate({
			to: pageLocation.pathname,
			replace: true,
			resetScroll: false,
			search: (previous: Record<string, unknown>) => {
				const next: Record<string, unknown> = samePage
					? previous
					: pageLocation.search
				return { ...next, q: q || undefined }
			},
		})
	}

	function move(packageId: string, by: -1 | 1) {
		const base = pendingOrder ?? starters.map((starter) => starter.packageId)
		const next = moveStarter(base, packageId, by)
		const unchanged = next.every(
			(id, index) => id === starters[index]?.packageId,
		)
		setPendingOrder(unchanged ? null : next)
		setMovedId(unchanged ? null : packageId)
	}

	function discardOrder() {
		setPendingOrder(null)
		setMovedId(null)
	}

	return (
		<AccountManagementShell layout="list" currentHref={props.currentHref}>
			<AdminPageHeader
				title="Starter templates"
				description="Choose which packages in the Kody org are recommended when an agent decides to build an app. This list does not create packages. It adds existing packages, ranks them, and turns them on or off."
				currentHref={props.currentHref}
			/>
			{feedback?.message ? (
				<AccountManagementMessage tone={feedback.tone}>
					<span css={{ whiteSpace: 'pre-line' }}>{feedback.message}</span>
				</AccountManagementMessage>
			) : null}
			{pendingOrder ? (
				<SaveOrderBar
					disabled={isMutating}
					onDiscard={discardOrder}
					onSave={() =>
						void run(async () => {
							await reorderMutation.mutateAsync({
								data: { packageIds: pendingOrder },
							})
							discardOrder()
						})
					}
				/>
			) : null}
			<div css={startersTableCss}>
				<RecordTable
					mode="expand"
					stackWhenNarrow
					busy={isMutating}
					ariaLabel="Starter templates"
					selectedId={selection.selectedId}
					createRow={
						selection.isCreating
							? {
									href: isMutating
										? undefined
										: starterTemplatesRoute.buildNewHref(searchStr),
									label: 'Add starter',
								}
							: undefined
					}
					onNavigate={() => setFeedback(null)}
					countLabel={`${visible.length} of ${starters.length} starters`}
					emptyLabel="No starter templates yet. Add a Kody org package to get started."
					toolbar={
						<>
							<RecordTableSearch
								label="Search starters"
								placeholder="Search name, package, or tag"
								value={filters.q ?? ''}
								onInput={(value) => updateSearch(value)}
							/>
							<Button
								type="button"
								variant="primary"
								disabled={isMutating}
								onClick={() =>
									void navigate(starterTemplatesRoute.buildNewHref(searchStr))
								}
							>
								Add starter
							</Button>
						</>
					}
					columns={[
						{ key: 'rank', label: 'Rank' },
						{ key: 'name', label: 'Name', primary: true },
						{ key: 'enabled', label: 'Enabled' },
						{ key: 'status', label: 'Manifest' },
						{ key: 'updated', label: 'Updated' },
					]}
					rows={visible.map((starter) => ({
						id: starter.packageId,
						href: isMutating
							? undefined
							: starterTemplatesRoute.buildDetailHref(
									starter.packageId,
									searchStr,
								),
						selectionLabel: starter.name,
						cells: {
							rank: (
								<RankControls
									rank={starter.rank}
									first={starter.rank === 1}
									last={starter.rank === ordered.length}
									disabled={isMutating}
									onMove={(by) => move(starter.packageId, by)}
								/>
							),
							name: (
								<StarterNameCell
									starter={starter}
									moved={movedId === starter.packageId}
								/>
							),
							enabled: (
								<Switch
									checked={starter.enabled}
									disabled={isMutating}
									onCheckedChange={(enabled) =>
										void run(() =>
											updateMutation.mutateAsync({
												data: { packageId: starter.packageId, enabled },
											}),
										)
									}
									aria-label={
										starter.enabled
											? `Disable ${starter.name}`
											: `Enable ${starter.name}`
									}
								/>
							),
							status: <StatusBadge status={starter.status} />,
							updated: (
								<span css={recordStampCss}>
									{starter.updatedAt
										? formatTimestampDate(starter.updatedAt)
										: ''}
								</span>
							),
						},
					}))}
					record={
						selection.isCreating ? (
							<AddStarterForm
								payload={props.payload}
								defaultRank={starters.length + 1}
								disabled={isMutating}
								onPick={(packageName) =>
									void router.navigate({
										to: pageLocation.pathname,
										replace: true,
										resetScroll: false,
										search: { ...pageLocation.search, package: packageName },
									})
								}
								onAdd={(input) =>
									void run(
										() => addMutation.mutateAsync({ data: input }),
										listHref,
									)
								}
								onCancel={() => void navigate(listHref)}
							/>
						) : editingStarter ? (
							<EditStarterForm
								key={editingStarter.packageId}
								starter={editingStarter}
								disabled={isMutating}
								onSave={(input) =>
									void run(
										() =>
											updateMutation.mutateAsync({
												data: { packageId: editingStarter.packageId, ...input },
											}),
										listHref,
									)
								}
								onCancel={() => void navigate(listHref)}
								onRemove={() =>
									void run(
										() =>
											removeMutation.mutateAsync({
												data: { packageId: editingStarter.packageId },
											}),
										listHref,
									)
								}
							/>
						) : null
					}
				/>
			</div>
		</AccountManagementShell>
	)
}
