/** @jsxImportSource @emotion/react */
import { deletePackage } from '#start/server/package-mutations'
import { usePackageMutation } from '../package-mutation.ts'
import { useSubmitterScope } from '../use-submitter-scope.ts'
import { type CSSObject } from '@emotion/react'
import {
	useState,
	useRef,
	type FormEvent,
	type ChangeEvent,
	useEffect,
} from 'react'
import { mergeCss } from '../components/merge-css.ts'

import { writeClipboardText } from '#client/clipboard.ts'
import { useRouter } from '@tanstack/react-router'
import { copyPromptTooltipCss } from '../components/fork-outdated-copy-button.tsx'
import { renderIcon } from '../components/icon.tsx'
import { routes } from '#universal/routes.ts'
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import {
	getAccentCalloutCss,
	getDangerPillCss,
	getGhostButtonCss,
	hoverMq,
} from '#universal/styles/style-primitives.ts'
import {
	accountActionsCss,
	accountFieldCss,
	accountFieldLabelCss,
	accountFieldNoteCss,
	accountInputCss,
} from './account-management-components.tsx'
import { type AccountPackageDetail } from '#universal/loader-data.ts'

type DeleteStatus = 'idle' | 'deleting'

const packageDeleteCopyTooltip = 'Copy'
const packageDeleteCopyTooltipId = 'package-delete-copy-name-tooltip'

export function AccountPackageDeleteDialog(props: {
	ownerUsername: string
	packageDetail: AccountPackageDetail
}) {
	const [confirmation, setConfirmation] = useState('')
	const [status, setStatus] = useState<DeleteStatus>('idle')
	const [error, setError] = useState<string | null>(null)
	const dialogRef = useRef<HTMLDialogElement>(null)
	const mutation = usePackageMutation(
		props.packageDetail.id,
		deletePackage,
		'delete',
		'deleted',
	)
	const capture = useSubmitterScope()
	const router = useRouter()
	const busyRef = useRef(false),
		mounted = useRef(false)
	const [copyFeedback, setCopyFeedback] = useState<string | null>(null)
	useEffect(() => {
		mounted.current = true
		return () => {
			mounted.current = false
		}
	}, [])
	useEffect(() => {
		if (!copyFeedback) return
		const timer = setTimeout(() => setCopyFeedback(null), 2000)
		return () => clearTimeout(timer)
	}, [copyFeedback])
	async function copyName() {
		try {
			await writeClipboardText(props.packageDetail.name)
			if (mounted.current) setCopyFeedback('Copied')
		} catch {
			if (mounted.current) setCopyFeedback('Copy failed')
		}
	}

	function closeDialog() {
		if (busyRef.current) return
		setConfirmation('')
		setError(null)
		setStatus('idle')
		dialogRef.current?.close()
	}

	useEffect(() => {
		const dialog = dialogRef.current
		if (!dialog) return
		const onBackdrop = (event: MouseEvent) => {
			if (event.target !== dialog || busyRef.current) return
			setConfirmation('')
			setError(null)
			setStatus('idle')
			dialog.close()
		}
		dialog.addEventListener('click', onBackdrop)
		return () => dialog.removeEventListener('click', onBackdrop)
	}, [])

	function openDialog() {
		setConfirmation('')
		setError(null)
		setStatus('idle')

		dialogRef.current?.showModal()
	}

	function updateConfirmation(event: ChangeEvent<HTMLInputElement>) {
		if (!(event.currentTarget instanceof HTMLInputElement)) return
		setConfirmation(event.currentTarget.value)
	}

	async function handleDeleteSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault()
		const packageDetail = props.packageDetail
		if (busyRef.current || confirmation.trim() !== packageDetail.name) return
		busyRef.current = true
		setStatus('deleting')
		setError(null)

		const isCurrent = capture()
		try {
			const payload = await mutation.submit({
				packageId: props.packageDetail.id,
				confirmName: confirmation.trim(),
			})
			if (!payload.deleted) throw new Error('Unable to delete this package.')
			if (!isCurrent()) return
			busyRef.current = false
			closeDialog()
			void router.navigate({
				to: routes.profile.href({ username: props.ownerUsername }),
			})
		} catch (caught) {
			if (!isCurrent()) return
			setError(
				caught instanceof Error
					? caught.message
					: 'Unable to delete this package.',
			)
			setStatus('idle')
		} finally {
			busyRef.current = false
		}
	}

	const packageName = props.packageDetail.name
	const isDeleting = status === 'deleting'
	const canSubmit = confirmation.trim() === packageName && !isDeleting
	return (
		<>
			<div
				css={{ display: 'grid', gap: spacing.sm }}
				data-testid="package-delete-controls"
			>
				<p css={accountFieldNoteCss}>
					Permanently delete this package, its jobs, storage, secrets, tokens,
					and public listing if it has one. Existing forks keep their copies.
					This cannot be undone.
				</p>
				<div css={accountActionsCss}>
					<button
						type="button"
						data-testid="package-delete"
						css={getDangerPillCss({ size: 'sm' })}
						onClick={openDialog}
					>
						Delete package
					</button>
				</div>
			</div>
			<dialog
				aria-labelledby="delete-package-title"
				data-testid="package-delete-dialog"
				css={deleteDialogCss}
				ref={dialogRef}
				onCancel={(event) => {
					event.preventDefault()
					closeDialog()
				}}
			>
				<form
					method="dialog"
					css={deleteDialogFormCss}
					onSubmit={handleDeleteSubmit}
				>
					<h3 id="delete-package-title" css={deleteDialogTitleCss}>
						Delete {packageName}
						<button
							type="button"
							// Copy feedback belongs to this button.
							data-testid="package-delete-copy-name"
							data-copy-prompt=""
							data-copy-text={packageName}
							data-copy-tooltip={copyFeedback ?? packageDeleteCopyTooltip}
							aria-label="Copy package name"
							aria-describedby={packageDeleteCopyTooltipId}
							css={packageDeleteCopyButtonCss}
							onClick={() => void copyName()}
						>
							{renderIcon('copy', { size: '0.85em' })}
							<span
								id={packageDeleteCopyTooltipId}
								role="tooltip"
								aria-hidden="true"
							>
								{copyFeedback ?? packageDeleteCopyTooltip}
							</span>
						</button>
						?
					</h3>
					<div
						css={getAccentCalloutCss({
							accentColor: colors.error,
						})}
					>
						<p css={{ margin: 0 }}>
							This cannot be undone. Type <strong>{packageName}</strong> to
							confirm.
						</p>
					</div>
					<label css={accountFieldCss}>
						<span css={accountFieldLabelCss}>Type the name of the package</span>
						<input
							type="text"
							name="confirmation"
							data-testid="package-delete-confirmation"
							data-field-ring
							autoComplete="off"
							spellCheck={false}
							required
							placeholder={packageName}
							value={confirmation}
							css={accountInputCss}
							onChange={updateConfirmation}
						/>
					</label>
					{error ? (
						<p
							role="alert"
							css={{
								margin: 0,
								color: colors.error,
								fontSize: typography.fontSize.sm,
							}}
						>
							{error}
						</p>
					) : null}
					<div css={accountActionsCss}>
						<button
							type="button"
							disabled={isDeleting}
							css={getGhostButtonCss({ size: 'sm' })}
							onClick={closeDialog}
						>
							Cancel
						</button>
						<button
							type="submit"
							disabled={!canSubmit}
							data-testid="package-delete-confirm"
							css={getDangerPillCss({ size: 'sm' })}
						>
							{isDeleting ? 'Deleting…' : 'Delete package'}
						</button>
					</div>
				</form>
			</dialog>
		</>
	)
}

const deleteDialogCss = {
	width: 'min(32rem, calc(100vw - 2rem))',
	maxWidth: '32rem',
	padding: 0,
	overflow: 'visible',
	border: `1px solid ${colors.border}`,
	borderRadius: radius.lg,
	boxShadow: shadows.md,
	backgroundColor: colors.surface,
	color: colors.text,
	'&::backdrop': {
		backgroundColor: 'oklch(0 0 0 / 0.45)',
	},
} satisfies CSSObject

const deleteDialogFormCss = {
	display: 'grid',
	gap: spacing.md,
	padding: spacing.lg,
} satisfies CSSObject

const deleteDialogTitleCss = {
	margin: 0,
	fontSize: '1.2rem',
	fontWeight: 720,
	letterSpacing: '-0.014em',
	lineHeight: 1.2,
} satisfies CSSObject

const packageDeleteCopyButtonCss = mergeCss(copyPromptTooltipCss, {
	position: 'relative' as const,
	display: 'inline-flex',
	alignItems: 'center',
	justifyContent: 'center',
	verticalAlign: '-0.2em',
	width: '1.15rem',
	height: '1.15rem',
	marginInlineStart: '0.35rem',
	padding: 0,
	appearance: 'none' as const,
	flex: 'none',
	border: 'none',
	borderRadius: radius.sm,
	backgroundColor: 'transparent',
	color: colors.textMuted,
	cursor: 'pointer',
	[hoverMq]: {
		'&:hover': {
			color: colors.text,
		},
	},
	'&:focus-visible': {
		outline: `2px solid ${colors.primary}`,
		outlineOffset: '2px',
	},
})
