/** @jsxImportSource @emotion/react */
import type { ReactNode } from 'react'

export function WorkspaceHeader({
	children,
	document = false,
}: {
	children: ReactNode
	document?: boolean
}) {
	return (
		<div
			data-workspace-toolbar={document ? '' : undefined}
			css={{
				display: 'flex',
				alignItems: 'center',
				flexWrap: 'nowrap',
				gap: 8,
				minWidth: 0,
				minHeight: 36,
				flexShrink: 0,
				boxSizing: 'border-box',
				...(document
					? { width: '100%', order: -1, paddingBottom: 7 }
					: { marginBottom: 8, overflowX: 'auto' }),
				'@media (max-width: 600px)': {
					flexWrap: 'wrap',
					rowGap: 4,
					paddingBlockEnd: 7,
					overflowX: 'visible',
				},
			}}
		>
			{children}
		</div>
	)
}
