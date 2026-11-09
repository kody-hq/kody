/** @jsxImportSource @emotion/react */
import { useContext } from 'react'
import { colors } from '#universal/styles/tokens.ts'
import { type CommentAnchor } from '#universal/file-collaboration.ts'
import { FileAnchorContext } from './file-anchor-context.ts'
import { CommentIcon } from './file-comments.tsx'

export function FileAnchorMarker({
	matches,
	label,
	onOpen,
	imagePin = false,
}: {
	matches: (anchor: CommentAnchor) => boolean
	label: string
	onOpen?: () => void
	imagePin?: boolean
}) {
	const context = useContext(FileAnchorContext)
	if (!context) return null
	const threads = context.threads.filter(
		(thread) =>
			!thread.outdated &&
			(!thread.resolvedAt || context.activeId === thread.id) &&
			matches(thread.anchor),
	)
	if (!threads.length) return null
	const active = threads.findIndex((thread) => thread.id === context.activeId)
	return (
		<button
			type="button"
			data-file-anchor-thread={threads.map((thread) => thread.id).join(' ')}
			aria-label={
				imagePin && threads.length > 1
					? `${label} (${threads.length} discussions)`
					: label
			}
			title={label}
			aria-pressed={active >= 0}
			onClick={(event) => {
				event.stopPropagation()
				onOpen?.()
				context.onSelect(threads[(active + 1) % threads.length]!)
			}}
			onKeyDown={(event) => event.stopPropagation()}
			css={{
				display: 'inline-flex',
				alignItems: 'center',
				gap: 3,
				verticalAlign: 'middle',
				marginInlineStart: imagePin ? 0 : 4,
				padding: imagePin ? 0 : 3,
				border: imagePin ? 0 : `1px solid ${colors.borderSubtle}`,
				borderRadius: 5,
				background: imagePin
					? 'transparent'
					: active >= 0
						? colors.primarySoft
						: colors.surface,
				color: active >= 0 ? colors.primary : colors.textMuted,
				font: 'inherit',
				lineHeight: 1,
				cursor: 'pointer',
				'&:hover': { color: colors.primary },
			}}
		>
			{imagePin ? (
				<svg
					aria-hidden="true"
					width="24"
					height="24"
					viewBox="0 0 24 24"
					css={{
						color: active >= 0 ? colors.primaryActive : colors.primary,
						filter: 'drop-shadow(0 1px 2px rgb(0 0 0 / 65%))',
						'button:hover &': { color: colors.primaryHover },
					}}
				>
					<path
						d="M5 22V7a4 4 0 0 1 4-4h9a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4h-7z"
						fill="currentColor"
						stroke={colors.surface}
						strokeLinejoin="round"
						strokeWidth="2"
					/>
				</svg>
			) : (
				<>
					<CommentIcon />
					{threads.length > 1 ? threads.length : null}
				</>
			)}
		</button>
	)
}
