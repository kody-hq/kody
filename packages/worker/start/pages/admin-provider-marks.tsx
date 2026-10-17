/** @jsxImportSource @emotion/react */
import { publicAsset } from '../public-assets.ts'
import type { ProviderMarkSaveInput } from '#universal/admin-provider-mutations.ts'
import {
	saveAdminProviderMark,
	deleteAdminProviderMark,
} from '#start/server/admin-mutations'
import { type CSSObject } from '@emotion/react'
import {
	useEffect,
	useRef,
	useState,
	type ChangeEvent,
	type FormEvent,
} from 'react'
import { useMatchedPageScope } from '../use-matched-page-scope.ts'
import { useMutation } from '@tanstack/react-query'
import { usePageInvalidation } from '../page-invalidation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'

import { normalizeProviderKey } from '@kody-internal/shared/url-hosts.ts'

import {
	filterMarks,
	groupMarks,
	markGroupKey,
	splitAliasInput,
} from '#client/routes/admin-provider-marks-shared.ts'
import {
	type AdminProviderMark,
	type AdminProviderMarksLoaderData,
} from '#universal/loader-data.ts'
import {
	fieldCss,
	fieldLabelCss,
	getDangerPillCss,
	getGhostButtonCss,
	getLogoWellCss,
	getPillButtonCss,
	hoverMq,
	nativeDisclosureCss,
} from '#universal/styles/style-primitives.ts'
import {
	colors,
	radius,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	accountInputCss,
	AccountManagementMessage,
	AccountManagementShell,
	AdminPageHeader,
} from './account-management-components.tsx'
import { RecordTableSearch } from './record-table.tsx'

type ActionState = 'idle' | 'saving' | 'deleting'

const markGroupCss = {
	...nativeDisclosureCss,
	border: `1px solid ${colors.border}`,
	borderRadius: radius.md,
	padding: spacing.sm,
	'& > summary': {
		...nativeDisclosureCss['& > summary'],
		width: '100%',
		display: 'flex',
		justifyContent: 'space-between',
		alignItems: 'center',
		gap: spacing.sm,
		fontVariantNumeric: 'tabular-nums',
	},
	'&[open] > summary': { marginBottom: spacing.sm },
} satisfies CSSObject

const markGridCss = {
	display: 'grid',
	gridTemplateColumns: 'repeat(auto-fill, minmax(2.25rem, 1fr))',
	gap: '0.25rem',
} satisfies CSSObject

const markTileCss = {
	display: 'grid',
	placeItems: 'center',
	aspectRatio: '1 / 1',
	padding: '0.2rem',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.sm,
	background: 'transparent',
	color: 'inherit',
	cursor: 'pointer',
	minWidth: 0,
	'&[data-selected]': {
		borderColor: colors.primary,
		backgroundColor: colors.primarySoftest,
	},
	[hoverMq]: {
		'&:not([data-selected]):hover': { backgroundColor: colors.background },
	},
} satisfies CSSObject

export function AdminProviderMarksRoute({
	initialData,
}: {
	initialData: AdminProviderMarksLoaderData
}) {
	const marks = initialData.marks
	const [message, setMessage] = useState<string | null>(null)
	const [messageTone, setMessageTone] = useState<'info' | 'error'>('info')
	const [search, setSearch] = useState('')
	const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
	const [creating, setCreating] = useState(false)
	const [pendingLogoBase64, setPendingLogoBase64] = useState<
		string | undefined
	>(undefined)
	const logoReadRevision = useRef(0)
	const logoReader = useRef<FileReader | null>(null)
	const [removeLogoChecked, setRemoveLogoChecked] = useState(false)
	const [formRevision, setFormRevision] = useState(0)
	const [openGroups, setOpenGroups] = useState(() => new Set<string>())
	const [deleteConfirmed, setDeleteConfirmed] = useState(false)
	const busy = useRef(false)
	const mounted = useRef(true)
	const editorRef = useRef<HTMLFormElement>(null)
	useEffect(() => {
		editorRef.current?.scrollIntoView({
			block: 'nearest',
			behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
				? 'auto'
				: 'smooth',
		})
	}, [formRevision])
	const captureSubmitter = useSubmitterScope()
	const invalidate = usePageInvalidation(mutationResources)
	const saveMutation = useMutation({
		gcTime: 0,
		mutationFn: saveAdminProviderMark,
		onMutate: () => invalidate,
		onSettled: (_data, _error, _input, reconcile) => reconcile?.(),
	})
	const removeMutation = useMutation({
		gcTime: 0,
		mutationFn: deleteAdminProviderMark,
		onMutate: () => invalidate,
		onSettled: (_data, _error, _input, reconcile) => reconcile?.(),
	})
	const actionState: ActionState = saveMutation.isPending
		? 'saving'
		: removeMutation.isPending
			? 'deleting'
			: 'idle'

	const currentHref = useMatchedPageScope().pageLocation.href
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
			logoReader.current?.abort()
		}
	}, [])
	function setGroup(key: string, open: boolean) {
		setOpenGroups((previous) => {
			if (previous.has(key) === open) return previous
			const next = new Set(previous)
			if (open) next.add(key)
			else next.delete(key)
			return next
		})
	}

	const primaryButtonCss = getPillButtonCss({ size: 'sm' })
	const ghostButtonCss = getGhostButtonCss({ size: 'sm' })
	const dangerButtonCss = getDangerPillCss({ size: 'sm' })

	function resetFormState() {
		setPendingLogoBase64(undefined)
		setRemoveLogoChecked(false)
		setDeleteConfirmed(false)
		logoReadRevision.current += 1
		logoReader.current?.abort()
	}

	function selectMark(slug: string | null) {
		setCreating(false)
		setSelectedSlug(slug)
		if (slug) setGroup(markGroupKey(slug), true)
		resetFormState()
		setFormRevision((value) => value + 1)
	}

	function handleLogoFileChange(event: ChangeEvent<HTMLInputElement>) {
		const input = event.currentTarget
		if (!(input instanceof HTMLInputElement)) return
		const file = input.files?.[0]
		if (!file) {
			logoReadRevision.current += 1
			setPendingLogoBase64(undefined)

			return
		}
		setRemoveLogoChecked(false)
		const revision = ++logoReadRevision.current
		logoReader.current?.abort()
		const reader = new FileReader()
		logoReader.current = reader
		reader.onload = () => {
			if (revision !== logoReadRevision.current || !mounted.current) return
			if (typeof reader.result !== 'string') return
			const commaIndex = reader.result.indexOf(',')
			setPendingLogoBase64(
				commaIndex >= 0 ? reader.result.slice(commaIndex + 1) : reader.result,
			)
		}
		reader.readAsDataURL(file)
	}

	async function submitAction(
		submit: () => Promise<unknown>,
		successMessage: string,
	) {
		if (busy.current) return false
		const isCurrent = captureSubmitter()
		busy.current = true
		setMessage(null)

		try {
			await submit()
			if (!mounted.current || !isCurrent()) return false
			setMessage(successMessage)
			setMessageTone('info')
			resetFormState()
			return true
		} catch (error) {
			if (!mounted.current || !isCurrent()) return false
			setMessage(
				error instanceof Error
					? error.message
					: 'Unable to save provider mark.',
			)
			setMessageTone('error')
			return false
		} finally {
			busy.current = false
		}
	}

	function handleSaveFormSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		if (!(event.currentTarget instanceof HTMLFormElement)) return
		const formData = new FormData(event.currentTarget)
		const slug = selectedSlug ?? String(formData.get('slug') ?? '').trim()
		const label = String(formData.get('label') ?? '').trim()
		const aliases = splitAliasInput(String(formData.get('aliases') ?? ''))
		if (!slug) {
			setMessage('Slug is required.')
			setMessageTone('error')

			return
		}
		const body: ProviderMarkSaveInput = {
			slug,
			label,
			aliases,
		}
		if (removeLogoChecked) {
			body.logoBase64 = ''
		} else if (pendingLogoBase64 !== undefined) {
			body.logoBase64 = pendingLogoBase64
		}
		void submitAction(
			() => saveMutation.mutateAsync({ data: body }),
			`Saved provider mark ${slug}.`,
		).then((ok) => {
			if (!ok) return
			setCreating(false)
			const canonicalSlug = normalizeProviderKey(slug)
			setSelectedSlug(canonicalSlug)
			setGroup(markGroupKey(canonicalSlug), true)
			setFormRevision((value) => value + 1)
		})
	}

	function handleDelete(mark: AdminProviderMark) {
		void submitAction(
			() => removeMutation.mutateAsync({ data: { slug: mark.slug } }),
			`Deleted provider mark ${mark.slug}.`,
		).then((ok) => {
			if (!ok) return
			setCreating(false)
			setSelectedSlug(null)
			setFormRevision((value) => value + 1)
		})
	}

	function renderMarkGlyph(
		mark: Pick<AdminProviderMark, 'label' | 'logoPath'>,
	) {
		return (
			<span css={getLogoWellCss({ size: '1.75rem', radius: '0' })}>
				{mark.logoPath ? (
					<img
						src={publicAsset(mark.logoPath)}
						alt=""
						width={20}
						height={20}
						css={{
							display: 'block',
							width: '70%',
							height: '70%',
							objectFit: 'contain',
						}}
					/>
				) : (
					mark.label.trim().charAt(0).toUpperCase() || '?'
				)}
			</span>
		)
	}

	function renderEditor(editingMark: AdminProviderMark | null) {
		const isMutating = actionState !== 'idle'
		return (
			<form
				method="post"
				key={formRevision}
				data-testid="provider-mark-editor"
				ref={editorRef}
				css={{
					display: 'grid',
					gap: spacing.md,
					borderBottom: `1px solid ${colors.border}`,
					paddingBottom: spacing.md,
				}}
				onSubmit={handleSaveFormSubmit}
			>
				<h2 css={{ margin: 0, fontSize: typography.fontSize.lg }}>
					{editingMark ? `Edit ${editingMark.slug}` : 'New provider mark'}
				</h2>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Slug</span>
					<input
						data-field-ring
						name="slug"
						required
						disabled={isMutating || editingMark != null}
						defaultValue={editingMark?.slug ?? ''}
						placeholder="google"
						css={accountInputCss}
					/>
				</label>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Label</span>
					<input
						data-field-ring
						name="label"
						disabled={isMutating}
						defaultValue={editingMark?.label ?? ''}
						placeholder="Google"
						css={accountInputCss}
					/>
				</label>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>
						Aliases (provider keys and authorize hosts)
					</span>
					<input
						data-field-ring
						name="aliases"
						disabled={isMutating}
						defaultValue={editingMark?.aliases.join(', ') ?? ''}
						placeholder="accounts.google.com, googleapis.com"
						css={accountInputCss}
					/>
					<span
						css={{
							color: colors.textMuted,
							fontSize: typography.fontSize.sm,
						}}
					>
						{editingMark?.builtInAliases.length
							? `Built-in matches (not stored): ${editingMark.builtInAliases.join(', ')}.`
							: `Also matches this slug as a host label and family keys like ${editingMark?.slug ?? 'slug'}-*.`}
					</span>
				</label>
				<label css={fieldCss}>
					<span css={fieldLabelCss}>Logo</span>
					<input
						data-field-ring
						name="logo"
						type="file"
						accept="image/svg+xml,image/png,image/jpeg,image/webp"
						disabled={isMutating}
						css={accountInputCss}
						onChange={handleLogoFileChange}
					/>
				</label>
				{editingMark?.logoPath ? (
					<label
						css={{
							...fieldCss,
							display: 'flex',
							flexDirection: 'row',
							alignItems: 'center',
							gap: spacing.sm,
						}}
					>
						<img
							src={publicAsset(editingMark.logoPath)}
							alt=""
							width={32}
							height={32}
						/>
						<input
							name="removeLogo"
							type="checkbox"
							checked={removeLogoChecked}
							disabled={isMutating}
							onChange={(event) => {
								const checkbox = event.currentTarget
								if (!(checkbox instanceof HTMLInputElement)) return
								setRemoveLogoChecked(checkbox.checked)
							}}
						/>
						<span css={fieldLabelCss}>Remove logo</span>
					</label>
				) : null}
				<div
					css={{
						display: 'flex',
						gap: spacing.sm,
						flexWrap: 'wrap',
					}}
				>
					<button type="submit" disabled={isMutating} css={primaryButtonCss}>
						{actionState === 'saving' ? 'Saving…' : 'Save mark'}
					</button>
					<button
						type="button"
						disabled={isMutating}
						css={ghostButtonCss}
						onClick={() => {
							setCreating(false)
							setSelectedSlug(null)
							resetFormState()
						}}
					>
						Cancel
					</button>
					{editingMark ? (
						<button
							type="button"
							disabled={isMutating}
							css={dangerButtonCss}
							onBlur={() => setDeleteConfirmed(false)}
							onClick={() => {
								if (deleteConfirmed) handleDelete(editingMark)
								else setDeleteConfirmed(true)
							}}
						>
							{deleteConfirmed
								? 'Click again to delete'
								: actionState === 'deleting'
									? 'Deleting…'
									: 'Delete'}
						</button>
					) : null}
				</div>
			</form>
		)
	}

	const filteredMarks = filterMarks(marks, search)
	const groups = groupMarks(filteredMarks)
	const searchActive = search.trim().length > 0
	const editingMark = creating
		? null
		: (marks.find((item) => item.slug === selectedSlug) ?? null)
	const isMutating = actionState !== 'idle'
	return (
		<AccountManagementShell
			currentHref={currentHref}
			busy={actionState !== 'idle'}
		>
			<AdminPageHeader
				title="Admin provider marks"
				description="Operator-owned brand marks for saved integrations. Open a letter, pick a mark, and edit it in that group. Login and onboarding keep their inline icons."
				currentHref={currentHref}
			/>
			{message ? (
				<AccountManagementMessage tone={messageTone}>
					{message}
				</AccountManagementMessage>
			) : null}

			<RecordTableSearch
				key="provider-marks-search"
				label="Filter marks"
				placeholder="Filter marks"
				value={search}
				onInput={(value) => {
					setSearch(value)
				}}
			/>
			<p
				css={{
					margin: 0,
					color: colors.textMuted,
					fontSize: typography.fontSize.sm,
					fontVariantNumeric: 'tabular-nums',
				}}
			>
				{searchActive
					? `${filteredMarks.length} match${filteredMarks.length === 1 ? '' : 'es'} of ${marks.length} marks`
					: `${marks.length} marks`}
			</p>
			<details
				open={creating}
				data-testid="add-mark"
				css={markGroupCss}
				onToggle={(event) => {
					if (!(event.currentTarget instanceof HTMLDetailsElement)) return
					if (event.currentTarget.open && !creating) {
						selectMark(null)
						setCreating(true)
					} else if (!event.currentTarget.open && creating) {
						setCreating(false)
						resetFormState()
					}
				}}
			>
				<summary>Add mark</summary>
				{creating ? renderEditor(null) : null}
			</details>
			{filteredMarks.length === 0 ? (
				<p css={{ color: colors.textMuted }}>
					{searchActive
						? 'No marks match this filter.'
						: 'No provider marks yet.'}
				</p>
			) : (
				<div
					data-testid="provider-mark-groups"
					css={{
						display: 'grid',
						gap: spacing.sm,
					}}
				>
					{groups.map((group) => {
						const groupOpen = searchActive || openGroups.has(group.key)
						const groupEditing =
							editingMark != null &&
							markGroupKey(editingMark.slug) === group.key
						return (
							<details
								key={group.key}
								open={groupOpen}
								data-testid={`mark-group-${group.key}`}
								css={markGroupCss}
								onToggle={(event) => {
									if (!(event.currentTarget instanceof HTMLDetailsElement)) {
										return
									}
									if (searchActive) {
										return
									}
									if (event.currentTarget.open) {
										setGroup(group.key, true)
									} else {
										setGroup(group.key, false)
										if (
											selectedSlug &&
											markGroupKey(selectedSlug) === group.key
										) {
											selectMark(null)
										}
									}
								}}
							>
								<summary>
									<span>{group.key}</span>
									<span css={{ color: colors.textMuted }}>
										{group.marks.length}
									</span>
								</summary>
								{groupOpen ? (
									<div css={{ display: 'grid', gap: spacing.md }}>
										{groupEditing && editingMark
											? renderEditor(editingMark)
											: null}
										<div css={markGridCss}>
											{group.marks.map((item) => (
												<button
													key={item.slug}
													type="button"
													title={`${item.label} (${item.slug})`}
													aria-label={`${item.label} (${item.slug})`}
													aria-pressed={
														selectedSlug === item.slug && !creating
															? 'true'
															: 'false'
													}
													data-testid={`mark-tile-${item.slug}`}
													data-selected={
														selectedSlug === item.slug && !creating
															? 'true'
															: undefined
													}
													disabled={isMutating}
													css={markTileCss}
													onClick={() => {
														if (isMutating) return
														if (selectedSlug === item.slug && !creating) {
															selectMark(null)
														} else {
															selectMark(item.slug)
														}
													}}
												>
													{renderMarkGlyph(item)}
												</button>
											))}
										</div>
									</div>
								) : null}
							</details>
						)
					})}
				</div>
			)}
		</AccountManagementShell>
	)
}

const mutationResources = [
	'loadAdminProviderMarks',
	'loadIntegrationsPage',
	'loadMcpServersPage',
	'loadOnboarding',
] as const
