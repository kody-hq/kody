/** @jsxImportSource @emotion/react */
import {
	colors,
	radius,
	shadows,
	spacing,
	typography,
} from '#universal/styles/tokens.ts'
import { getPillButtonCss } from '#universal/styles/style-primitives.ts'

type UndoToastProps = {
	message: string
	undoLabel?: string
	onUndo: () => void
}

export function UndoToast(props: UndoToastProps) {
	return (
		<div
			role="status"
			aria-live="polite"
			data-testid="undo-toast"
			css={{
				position: 'fixed',
				left: '50%',
				bottom: spacing.xl,
				transform: 'translateX(-50%)',
				zIndex: 1000,
				display: 'flex',
				alignItems: 'center',
				gap: spacing.md,
				padding: `${spacing.sm} ${spacing.md}`,
				backgroundColor: colors.surface,
				color: colors.text,
				boxShadow: shadows.md,
				borderRadius: radius.lg,
				border: `1px solid ${colors.border}`,
				maxWidth: 'min(36rem, calc(100vw - 2rem))',
			}}
		>
			<p
				css={{
					margin: 0,
					fontSize: typography.fontSize.sm,
					minWidth: 0,
				}}
			>
				{props.message}
			</p>
			<button
				type="button"
				data-testid="undo-toast-undo"
				onClick={() => {
					props.onUndo()
				}}
				css={getPillButtonCss({ size: 'sm' })}
			>
				{props.undoLabel ?? 'Undo'}
			</button>
		</div>
	)
}
