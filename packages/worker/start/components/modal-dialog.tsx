/** @jsxImportSource @emotion/react */
import { AlertDialog } from '@base-ui/react/alert-dialog'
import { Dialog } from '@base-ui/react/dialog'
import { type ReactNode } from 'react'
import { colors, radius, shadows } from '#universal/styles/tokens.ts'

export function ModalDialog({
	label,
	alert = false,
	onClose,
	width,
	sidePanel = false,
	flush = false,
	dismissOnOutside = false,
	testId,
	children,
}: {
	label: string
	alert?: boolean
	onClose: () => void
	width: number
	sidePanel?: boolean
	flush?: boolean
	dismissOnOutside?: boolean
	testId?: string
	children: ReactNode
}) {
	const Primitive = alert ? AlertDialog : Dialog
	return (
		<Primitive.Root
			open
			{...(!alert && { disablePointerDismissal: !dismissOnOutside })}
			onOpenChange={(open) => {
				if (!open) onClose()
			}}
		>
			<Primitive.Portal>
				<Primitive.Backdrop
					css={{
						position: 'fixed',
						inset: 0,
						background: sidePanel ? '#0002' : '#0004',
						zIndex: 1000,
					}}
				/>
				<Primitive.Popup
					aria-label={label}
					data-testid={testId}
					css={{
						position: 'fixed',
						top: '50%',
						left: '50%',
						transform: 'translate(-50%, -50%)',
						zIndex: 1000,
						width: `min(${width}px, calc(100vw - 32px))`,
						boxSizing: 'border-box',
						padding: flush ? 0 : 'clamp(16px, 4vw, 24px)',
						maxHeight: 'calc(100dvh - 32px)',
						overflowY: 'auto',
						color: colors.text,
						background: colors.surface,
						border: `1px solid ${colors.border}`,
						borderRadius: radius.lg,
						boxShadow: shadows.md,
						...(sidePanel && {
							inset: '0 0 0 auto',
							transform: 'none',
							width: `min(${width}px, 100vw)`,
							height: '100dvh',
							maxHeight: '100dvh',
							padding: 0,
							display: 'flex',
							flexDirection: 'column',
							border: 0,
							borderInlineStart: `1px solid ${colors.border}`,
							borderRadius: 0,
							transition: 'transform 180ms ease-out',
							'&[data-starting-style]': { transform: 'translateX(100%)' },
							'@media (prefers-reduced-motion: reduce)': { transition: 'none' },
						}),
						outline: 'none',
					}}
				>
					{children}
				</Primitive.Popup>
			</Primitive.Portal>
		</Primitive.Root>
	)
}
