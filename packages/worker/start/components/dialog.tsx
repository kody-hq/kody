/** @jsxImportSource @emotion/react */
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Dialog as BaseDialog } from '@base-ui/react/dialog'
import type { ComponentProps, ReactNode } from 'react'
import { colors, shadows, spacing } from '#universal/styles/tokens.ts'
import { getSquircleCss } from '#universal/styles/style-primitives.ts'

const dialogWidths = { sm: 448, md: 512, lg: 640 } as const

type DialogName =
	| {
			/** Visible heading; also the dialog's accessible name. */
			title: ReactNode
			/** Announced with the title when the dialog opens. */
			description?: ReactNode
			'aria-label'?: never
	  }
	| { 'aria-label': string; title?: never; description?: never }

type DialogKind =
	| {
			/** Close on a click outside. Escape always closes. */
			dismissOnOutsideClick?: boolean
			role?: 'dialog'
	  }
	/** Confirms a destructive or irreversible action: only Escape or a button closes it. */
	| { role: 'alertdialog'; dismissOnOutsideClick?: never }

export type DialogProps = Omit<
	ComponentProps<'div'>,
	'title' | 'role' | 'aria-label' | 'children'
> &
	DialogName &
	DialogKind & {
		open: boolean
		/** Escape, an outside click, or `DialogClose` asked to close. */
		onClose: () => void
		size?: keyof typeof dialogWidths
		/** `side` slides in from the inline end at full height. */
		placement?: 'center' | 'side'
		/** The content draws its own padding (sections, headers, footers). */
		flush?: boolean
		children: ReactNode
	}

/**
 * Modal dialog. Focus moves inside on open, Tab stays inside, and focus
 * returns to the opener on close.
 */
export function Dialog({
	open,
	onClose,
	size = 'sm',
	placement = 'center',
	flush = false,
	title,
	description,
	role,
	dismissOnOutsideClick,
	children,
	...props
}: DialogProps) {
	const Primitive = role === 'alertdialog' ? AlertDialog : BaseDialog
	const width = dialogWidths[size]
	return (
		<Primitive.Root
			open={open}
			{...(role !== 'alertdialog' && {
				disablePointerDismissal: !dismissOnOutsideClick,
			})}
			onOpenChange={(next) => {
				if (!next) onClose()
			}}
		>
			<Primitive.Portal>
				<Primitive.Backdrop
					css={{
						position: 'fixed',
						inset: 0,
						zIndex: 1000,
						background:
							placement === 'side'
								? 'oklch(0 0 0 / 0.13)'
								: 'oklch(0 0 0 / 0.27)',
					}}
				/>
				<Primitive.Popup
					css={[
						popupCss,
						{
							width: `min(${width}px, calc(100vw - 32px))`,
							padding: flush ? 0 : 'clamp(16px, 4vw, 24px)',
						},
						placement === 'side' && {
							inset: '0 0 0 auto',
							transform: 'none',
							width: `min(${width}px, 100vw)`,
							height: '100dvh',
							maxHeight: '100dvh',
							display: 'flex',
							flexDirection: 'column',
							border: 0,
							borderInlineStart: `1px solid ${colors.border}`,
							borderRadius: 0,
							cornerShape: 'round',
							transition: 'transform 180ms ease-out',
							'&[data-starting-style]': { transform: 'translateX(100%)' },
							'@media (prefers-reduced-motion: reduce)': {
								transition: 'none',
							},
						},
					]}
					{...props}
				>
					{title === undefined ? (
						children
					) : (
						<div css={stackCss}>
							<Primitive.Title css={titleCss}>{title}</Primitive.Title>
							{description ? (
								<Primitive.Description css={descriptionCss}>
									{description}
								</Primitive.Description>
							) : null}
							{children}
						</div>
					)}
				</Primitive.Popup>
			</Primitive.Portal>
		</Primitive.Root>
	)
}

/** Right-aligned row for a dialog's buttons. */
export function DialogActions(props: ComponentProps<'div'>) {
	return <div css={actionsCss} {...props} />
}

const popupCss = {
	position: 'fixed',
	top: '50%',
	left: '50%',
	transform: 'translate(-50%, -50%)',
	zIndex: 1000,
	boxSizing: 'border-box',
	maxHeight: 'calc(100dvh - 32px)',
	overflowY: 'auto',
	color: colors.text,
	background: colors.surface,
	border: `1px solid ${colors.border}`,
	...getSquircleCss('lg'),
	boxShadow: shadows.md,
	outline: 'none',
} as const

const stackCss = { display: 'grid', gap: spacing.md, minWidth: 0 } as const

const titleCss = {
	margin: 0,
	fontSize: '1.2rem',
	fontWeight: 720,
	letterSpacing: '-0.014em',
	lineHeight: 1.2,
} as const

const descriptionCss = {
	margin: 0,
	fontSize: '0.92rem',
	color: colors.textMuted,
} as const

const actionsCss = {
	display: 'flex',
	flexWrap: 'wrap',
	justifyContent: 'flex-end',
	gap: '0.7rem',
} as const
