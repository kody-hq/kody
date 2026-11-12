/** @jsxImportSource @emotion/react */
import { createPortal } from 'react-dom'
import { formatForDisplay } from '@tanstack/react-hotkeys'
import { colors } from '#universal/styles/tokens.ts'

export function CommentSelectionToolbar({
	rect,
	onComment,
}: {
	rect: { left: number; top: number; bottom: number; width: number }
	onComment: () => void
}) {
	return createPortal(
		<div
			role="toolbar"
			aria-label="Text selection"
			css={{
				position: 'fixed',
				left: Math.max(
					8,
					Math.min(window.innerWidth - 178, rect.left + rect.width / 2 - 82),
				),
				top: rect.top > 46 ? rect.top - 40 : rect.bottom + 7,
				zIndex: 80,
				background: colors.surface,
				border: `1px solid ${colors.border}`,
				borderRadius: 7,
				boxShadow: '0 3px 12px #0002',
				animation: 'comment-toolbar-enter 100ms ease-out',
				'@keyframes comment-toolbar-enter': {
					from: { opacity: 0, transform: 'translateY(3px)' },
					to: { opacity: 1, transform: 'translateY(0)' },
				},
				'@media(prefers-reduced-motion:reduce)': { animation: 'none' },
			}}
		>
			<button
				type="button"
				aria-label="Comment on selection"
				onMouseDown={(event) => event.preventDefault()}
				onClick={onComment}
				css={{
					display: 'flex',
					alignItems: 'center',
					gap: 9,
					padding: '7px 10px',
					border: 0,
					borderRadius: 6,
					color: colors.text,
					background: 'transparent',
					fontSize: 12,
					fontWeight: 500,
					cursor: 'pointer',
					'&:hover': { background: colors.borderSubtle },
					'&:focus-visible': { outline: `2px solid ${colors.primary}` },
				}}
			>
				<svg
					width="14"
					height="14"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.7"
					aria-hidden="true"
				>
					<path d="M21 15a3 3 0 0 1-3 3H7l-5 4V5a3 3 0 0 1 3-3h13a3 3 0 0 1 3 3Z" />
				</svg>
				Comment
				<kbd css={{ color: colors.textMuted, fontSize: 10, fontWeight: 400 }}>
					{formatForDisplay('Mod+Alt+M')}
				</kbd>
			</button>
		</div>,
		document.body,
	)
}
