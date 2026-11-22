/** @jsxImportSource @emotion/react */
import { useCallback, useRef } from 'react'
import { colors } from '#universal/styles/tokens.ts'
import { htmlPreviewPath } from '#universal/html-preview.ts'
export function HtmlPreview({
	content,
	orgSlug,
	inline,
	fill,
}: {
	content: string
	orgSlug: string
	inline: boolean
	fill: boolean
}) {
	const frame = useRef<HTMLIFrameElement>(null)
	const sendContent = () =>
		frame.current?.contentWindow?.postMessage(
			{ type: 'kody-html-preview', content },
			'*',
		)
	const frameRef = useCallback(
		(node: HTMLIFrameElement | null) => {
			frame.current = node
			node?.contentWindow?.postMessage(
				{ type: 'kody-html-preview', content },
				'*',
			)
		},
		[content],
	)

	return (
		<>
			<iframe
				ref={frameRef}
				src={htmlPreviewPath(orgSlug)}
				onLoad={sendContent}
				title="HTML preview"
				sandbox="allow-scripts"
				referrerPolicy="no-referrer"
				css={{
					width: '100%',
					display: 'block',
					minHeight: fill ? 0 : inline ? 230 : '55vh',
					flex: fill ? 1 : undefined,
					height: fill ? '100%' : undefined,
					boxSizing: 'border-box',
					border: fill ? 0 : `1px solid ${colors.border}`,
					borderRadius: fill ? 0 : 8,
					background: 'white',
				}}
			/>
		</>
	)
}
