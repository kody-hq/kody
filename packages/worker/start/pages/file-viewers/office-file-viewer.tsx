/** @jsxImportSource @emotion/react */
import { WorkspaceFileStatus } from '../workspace-file-status.tsx'
import { colors } from '#universal/styles/tokens.ts'
import { useEffect, useRef, useState } from 'react'
import scripts from 'virtual:kody-office-viewers'
function OfficeViewer({
	kind,
	src,
	name,
	download,
	inline = false,
	orgSlug,
}: {
	kind: 'docx' | 'xlsx' | 'pptx'
	orgSlug: string
	src: string
	name: string
	download: string
	inline?: boolean
}) {
	const frame = useRef<HTMLIFrameElement>(null),
		ready = useRef(false),
		bytes = useRef<ArrayBuffer | null>(null)
	const [error, setError] = useState(false)

	const href = `/office-preview/${encodeURIComponent(orgSlug)}/${kind}?script=${encodeURIComponent(scripts[kind])}`
	function send() {
		if (ready.current && bytes.current && frame.current?.contentWindow) {
			const buffer = bytes.current
			bytes.current = null
			frame.current.contentWindow.postMessage(
				{ type: 'kody-office-preview', bytes: buffer },
				'*',
				[buffer],
			)
		}
	}
	useEffect(() => {
		const handle = (event: MessageEvent) => {
			if (
				event.source === frame.current?.contentWindow &&
				event.origin === 'null' &&
				event.data?.type === 'kody-office-preview-status'
			) {
				if (event.data.state === 'error') setError(true)
				if (event.data.state === 'ready') {
					ready.current = true
					send()
				}
			}
		}
		window.addEventListener('message', handle)
		frame.current?.contentWindow?.postMessage(
			{ type: 'kody-office-preview-probe' },
			'*',
		)
		return () => window.removeEventListener('message', handle)
	}, [])
	useEffect(() => {
		const controller = new AbortController()
		void fetch(src, { signal: controller.signal })
			.then((response) => {
				if (!response.ok) throw new Error('File unavailable')
				return response.arrayBuffer()
			})
			.then((buffer) => {
				if (controller.signal.aborted) return
				bytes.current = buffer
				send()
			})
			.catch(() => {
				if (!controller.signal.aborted) setError(true)
			})
		return () => {
			controller.abort()
			bytes.current = null
		}
	}, [src])
	if (error)
		return (
			<WorkspaceFileStatus
				message="Could not load this file."
				action={{ label: 'Download', href: download }}
			/>
		)
	return (
		<iframe
			ref={frame}
			title={name}
			src={href}
			sandbox="allow-scripts"
			referrerPolicy="no-referrer"
			onLoad={() => {
				ready.current = true
				send()
			}}
			css={{
				display: 'block',
				width: '100%',
				height: inline ? 460 : '100%',
				minHeight: inline ? 460 : 0,
				flex: 1,
				border: 0,
				background: colors.background,
			}}
		/>
	)
}
type Props = Omit<Parameters<typeof OfficeViewer>[0], 'kind'>
export function DocxViewer(props: Props) {
	return <OfficeViewer {...props} kind="docx" />
}
export function XlsxViewer(props: Props) {
	return <OfficeViewer {...props} kind="xlsx" />
}
export function PptxViewer(props: Props) {
	return <OfficeViewer {...props} kind="pptx" />
}
