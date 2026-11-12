import { zipDirectory } from '#universal/zip-directory.ts'
export function officeHost(
	kind: 'docx' | 'xlsx' | 'pptx',
	render: (bytes: ArrayBuffer, root: HTMLElement) => Promise<void>,
) {
	let started = false
	window.addEventListener('message', (event) => {
		if (
			event.source === parent &&
			event.origin === document.documentElement.dataset.appOrigin &&
			event.data?.type === 'kody-office-preview-probe'
		) {
			parent.postMessage(
				{ type: 'kody-office-preview-status', state: 'ready' },
				'*',
			)
			return
		}
		if (
			started ||
			event.source !== parent ||
			event.origin !== document.documentElement.dataset.appOrigin ||
			event.data?.type !== 'kody-office-preview' ||
			!(event.data.bytes instanceof ArrayBuffer) ||
			event.data.bytes.byteLength > 16 * 1024 * 1024
		)
			return
		started = true
		const root = document.getElementById('preview')!
		void Promise.resolve()
			.then(() => {
				const files = zipDirectory(event.data.bytes)
				const required = {
					docx: 'word/document.xml',
					xlsx: 'xl/workbook.xml',
					pptx: 'ppt/presentation.xml',
				}[kind]
				if (!files.some((file) => file.name === required))
					throw new Error('Invalid Office document')
				root.replaceChildren()
				return render(event.data.bytes, root)
			})
			.catch(() => {
				parent.postMessage(
					{ type: 'kody-office-preview-status', state: 'error' },
					'*',
				)
				root.replaceChildren()
				const message = document.createElement('p')
				message.setAttribute('role', 'alert')
				message.textContent =
					'Could not preview this file. Download the original to open it.'
				root.append(message)
			})
	})
	parent.postMessage(
		{ type: 'kody-office-preview-status', state: 'ready' },
		'*',
	)
}
