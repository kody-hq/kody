import * as Y from 'yjs'
import { fromBase64, toBase64 } from './contracts.ts'
import { replaceTextRange } from './document.ts'

type FileView = {
	id: string
	name: string
	content: string
	state: string
	version: number
	canEdit: boolean
	canManage: boolean
	storageAvailable: boolean
	access: Record<string, 'view' | 'edit'> | null
	revisions: Array<{ id: string; author: string; createdAt: string }>
}
const root = document.querySelector<HTMLDivElement>('#app')!
root.innerHTML = `
<header><a href="/">Files</a><label>Local participant <select id="person"><option value="alice">Alice</option><option value="bob">Bob</option><option value="agent">Writing agent</option><option value="viewer">Viewer</option><option value="outsider">Other workspace</option></select></label></header>
<main><aside><form id="create"><label for="name">Document name</label><div class="row"><input id="name" required maxlength="100" value="Shared notes"><button>Create</button></div></form><nav aria-label="Documents" id="files"></nav></aside>
<section><p id="error" role="alert" hidden></p><div id="empty">Create or open a document.</div><article id="document" hidden><div class="row"><h1 id="title"></h1><span id="status" role="status"></span></div><p id="people"></p><textarea id="editor" aria-label="Markdown" spellcheck="false"></textarea><div class="row actions"><button id="checkpoint">Save checkpoint</button><button id="export">Export with history</button><button id="copy">Copy link</button></div><details><summary>History</summary><div id="history"></div></details><details id="storage"><summary>Storage</summary><p id="location"></p><div class="row"><button id="move">Move storage</button><button id="finish">Remove recovery copy</button></div><p class="note">External storage uses a second local bucket unless an S3 connection is configured.</p></details><details id="sharing"><summary>Access</summary><label>Bob <select id="bob-access"><option value="edit">Can edit</option><option value="view">Can view</option><option value="none">No access</option></select></label><button id="grant">Update access</button></details></article></section></main>
<dialog id="revision"><h2>Checkpoint</h2><pre id="revision-content"></pre><form method="dialog"><button>Close</button></form></dialog>`
function element<T extends HTMLElement>(id: string) {
	return document.getElementById(id) as T
}
const editor = element<HTMLTextAreaElement>('editor')
const participant = element<HTMLSelectElement>('person')
const params = new URLSearchParams(location.search)
participant.value =
	params.get('person') ??
	sessionStorage.getItem('files-spike-person') ??
	'alice'
if (!participant.value) participant.value = 'alice'
let doc: Y.Doc | null = null
let socket: WebSocket | null = null
let file: FileView | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let stopped = false
let needsRecovery = false
let pending = new Map<string, string>()
let currentFileId = params.get('file')
let composing = false
let compositionBase: Uint8Array | null = null

function status(value: string) {
	element('status').textContent = value
}
function showError(error: unknown) {
	const message =
		error instanceof Error ? error.message : 'The operation failed.'
	element('error').textContent = message
	element('error').hidden = false
}
async function request<T>(
	path: string,
	method = 'GET',
	body?: unknown,
): Promise<T> {
	const response = await fetch(path, {
		method,
		headers: {
			Authorization: `Bearer ${participant.value}`,
			'Content-Type': 'application/json',
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	const result = (await response.json()) as T & {
		message?: string
		current?: string
		code?: string
	}
	if (!response.ok)
		throw new Error(result.message ?? result.code ?? 'Request failed.')
	return result
}
function send(update: Uint8Array) {
	const id = crypto.randomUUID()
	const encoded = toBase64(update)
	pending.set(id, encoded)
	status('Saving…')
	if (socket?.readyState === WebSocket.OPEN)
		socket.send(JSON.stringify({ type: 'update', id, update: encoded }))
}
function disconnect() {
	stopped = true
	if (reconnectTimer) clearTimeout(reconnectTimer)
	if (socket) {
		socket.onclose = null
		socket.close()
		socket = null
	}
	doc?.destroy()
	doc = null
	pending = new Map()
}
function renderText() {
	if (!doc || composing) return
	const next = doc.getText('content').toString()
	if (next === editor.value) return
	const start = editor.selectionStart
	const end = editor.selectionEnd
	editor.value = next
	editor.setSelectionRange(
		Math.min(start, next.length),
		Math.min(end, next.length),
	)
}
function connect() {
	if (!file || !doc) return
	stopped = false
	const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
	const active = new WebSocket(
		`${scheme}//${location.host}/files/${file.id}/socket`,
		['files-spike', `participant.${participant.value}`],
	)
	socket = active
	active.onmessage = (event) => {
		if (socket !== active || !doc) return
		const message = JSON.parse(event.data)
		if (message.type === 'ready') {
			if (file) file.storageAvailable = message.storageAvailable
			Y.applyUpdate(doc, fromBase64(message.state), 'remote')
			editor.readOnly = !message.canEdit
			element('people').textContent = message.people?.join(', ') ?? ''
			if (message.canEdit && pending.size && !needsRecovery) {
				pending.clear()
				send(Y.encodeStateAsUpdate(doc))
			} else
				status(
					message.storageAvailable
						? message.canEdit
							? 'Saved'
							: 'View only'
						: 'Storage unavailable, read only',
				)
			if (needsRecovery) {
				editor.readOnly = true
				status('Unsaved local edits, export before reloading')
			}
		} else if (message.type === 'people') {
			element('people').textContent = message.people.join(', ')
		} else if (message.type === 'update') {
			Y.applyUpdate(doc, fromBase64(message.update), 'remote')
			if (!pending.size) status(`Saved · ${message.author}`)
		} else if (message.type === 'ack') {
			pending.delete(message.id)
			if (!pending.size) status('Saved')
		} else if (message.type === 'error') {
			needsRecovery = true
			editor.readOnly = true
			showError(
				new Error(
					`${message.message} Local edits remain here. Export them before reloading.`,
				),
			)
			status('Edits need recovery')
		}
	}
	active.onclose = (event) => {
		if (socket !== active || stopped) return
		editor.readOnly = true
		if (event.code === 1008) {
			needsRecovery = true
			status('Access changed')
			showError(
				new Error('Access changed. Export local edits before reloading.'),
			)
			return
		}
		status(pending.size ? 'Reconnecting, local edits pending' : 'Reconnecting…')
		reconnectTimer = setTimeout(connect, 1_000)
	}
	active.onerror = () => status('Connection interrupted')
}
async function list() {
	const files = await request<Array<{ id: string; name: string }>>('/files')
	const nav = element('files')
	nav.replaceChildren()
	for (const item of files) {
		const link = document.createElement('a')
		link.textContent = item.name
		link.href = `/?file=${item.id}&person=${participant.value}`
		nav.append(link)
	}
}
async function open(id: string) {
	disconnect()
	file = await request<FileView>(`/files/${id}`)
	currentFileId = id
	needsRecovery = false
	doc = new Y.Doc()
	Y.applyUpdate(doc, fromBase64(file.state), 'remote')
	editor.value = file.content
	editor.readOnly = true
	doc.getText('content').observe(renderText)
	doc.on('update', (update: Uint8Array, origin: unknown) => {
		if (origin !== 'remote') send(update)
	})
	element('empty').hidden = true
	element('document').hidden = false
	element('title').textContent = file.name
	element('storage').hidden = !file.canManage
	element('sharing').hidden = !file.canManage
	element<HTMLSelectElement>('bob-access').value = file.access?.bob ?? 'none'
	element<HTMLButtonElement>('checkpoint').disabled = !file.canEdit
	const history = element('history')
	history.replaceChildren()
	for (const revision of [...file.revisions].reverse()) {
		const button = document.createElement('button')
		button.textContent = `${new Date(revision.createdAt).toLocaleString()} · ${revision.author}`
		button.onclick = () =>
			void request<{ content: string }>(`/files/${id}/revisions/${revision.id}`)
				.then((result) => {
					element('revision-content').textContent = result.content
					element<HTMLDialogElement>('revision').showModal()
				})
				.catch(showError)
		history.append(button)
	}
	connect()
}
editor.addEventListener('compositionstart', () => {
	composing = true
	compositionBase = doc ? Y.encodeStateAsUpdate(doc) : null
})
editor.addEventListener('compositionend', () => {
	const draft = editor.value
	if (doc && compositionBase) {
		const base = new Y.Doc()
		Y.applyUpdate(base, compositionBase)
		const original = base.getText('content').toString()
		let start = 0
		while (
			start < original.length &&
			start < draft.length &&
			original[start] === draft[start]
		)
			start++
		let end = 0
		while (
			end < original.length - start &&
			end < draft.length - start &&
			original[original.length - end - 1] === draft[draft.length - end - 1]
		)
			end++
		const from = Y.createAbsolutePositionFromRelativePosition(
			Y.createRelativePositionFromTypeIndex(base.getText('content'), start),
			doc,
		)
		const to = Y.createAbsolutePositionFromRelativePosition(
			Y.createRelativePositionFromTypeIndex(
				base.getText('content'),
				original.length - end,
			),
			doc,
		)
		const current = doc.getText('content')
		if (
			!from ||
			!to ||
			current.toString().slice(from.index, to.index) !==
				original.slice(start, original.length - end)
		) {
			needsRecovery = true
			editor.readOnly = true
			showError(
				new Error(
					'Another edit changed the text being composed. Export this local draft before reloading.',
				),
			)
		} else {
			doc.transact(() => {
				current.delete(from.index, to.index - from.index)
				current.insert(from.index, draft.slice(start, draft.length - end))
			})
		}
		base.destroy()
	}
	compositionBase = null
	composing = false
	if (!needsRecovery) renderText()
})
editor.oninput = () => {
	if (doc && !composing && !editor.readOnly)
		replaceTextRange(doc.getText('content'), editor.value)
}
participant.onchange = () => {
	if (pending.size || needsRecovery) {
		showError(
			new Error(
				'Export or wait for your local edits before switching participants.',
			),
		)
		return
	}
	sessionStorage.setItem('files-spike-person', participant.value)
	location.href = `/?person=${participant.value}${currentFileId ? `&file=${currentFileId}` : ''}`
}
element<HTMLFormElement>('create').onsubmit = (event) => {
	event.preventDefault()
	if (pending.size || needsRecovery) {
		showError(new Error('Save or export the current edits first.'))
		return
	}
	void request<FileView>('/files', 'POST', {
		name: element<HTMLInputElement>('name').value,
	})
		.then((result) => {
			history.replaceState(
				null,
				'',
				`/?file=${result.id}&person=${participant.value}`,
			)
			return Promise.all([open(result.id), list()])
		})
		.catch(showError)
}
element('checkpoint').onclick = () => {
	if (!file || pending.size || needsRecovery) {
		showError(
			new Error('Wait for all edits to save before creating a checkpoint.'),
		)
		return
	}
	void request(`/files/${file.id}/checkpoint`, 'POST')
		.then(() => file && open(file.id))
		.catch(showError)
}
function download(name: string, content: string) {
	const url = URL.createObjectURL(
		new Blob([content], { type: 'application/json' }),
	)
	const link = document.createElement('a')
	link.href = url
	link.download = name
	link.click()
	setTimeout(() => URL.revokeObjectURL(url), 1_000)
}
element('export').onclick = () => {
	if (!file) return
	if (pending.size || needsRecovery || !file.storageAvailable) {
		download(
			`${file.name}-local-draft.json`,
			JSON.stringify(
				{
					id: file.id,
					content: editor.value,
					acknowledged: pending.size === 0 && !needsRecovery,
					historyIncluded: false,
				},
				null,
				2,
			),
		)
		return
	}
	void request(`/files/${file.id}/export`)
		.then((result) =>
			download(`${file!.name}.json`, JSON.stringify(result, null, 2)),
		)
		.catch(showError)
}
element('copy').onclick = () =>
	void navigator.clipboard
		.writeText(`${location.origin}/?file=${file?.id}`)
		.then(() => status('Link copied'))
		.catch(showError)
element<HTMLDetailsElement>('storage').ontoggle = () => {
	if (!file || !element<HTMLDetailsElement>('storage').open) return
	void request<{ location: string; recoveryCopy: string | null }>(
		`/files/${file.id}/storage`,
	)
		.then((result) => {
			element('location').textContent =
				`${result.location}${result.recoveryCopy ? ` · recovery copy in ${result.recoveryCopy}` : ''}`
			element('move').textContent =
				result.location === 'included'
					? 'Move to external storage'
					: 'Move to included storage'
			element('move').dataset.target =
				result.location === 'included' ? 'external' : 'included'
			element<HTMLButtonElement>('finish').disabled = !result.recoveryCopy
		})
		.catch(showError)
}
element('move').onclick = () => {
	if (!file || pending.size || needsRecovery) {
		showError(new Error('Save your edits before moving storage.'))
		return
	}
	void request(`/files/${file.id}/move`, 'POST', {
		target: element('move').dataset.target,
	})
		.then(() => location.reload())
		.catch(showError)
}
element('finish').onclick = () => {
	if (
		file &&
		confirm(
			'Remove the old storage copy? The verified current copy and history will remain.',
		)
	)
		void request(`/files/${file.id}/finish-move`, 'POST')
			.then(() => location.reload())
			.catch(showError)
}
element('grant').onclick = () => {
	if (!file) return
	const role = element<HTMLSelectElement>('bob-access').value
	void request(`/files/${file.id}/grant`, 'POST', {
		personId: 'bob',
		role: role === 'none' ? null : role,
	})
		.then(() => status('Access updated'))
		.catch(showError)
}
window.addEventListener('beforeunload', (event) => {
	if (pending.size || needsRecovery) {
		event.preventDefault()
		event.returnValue = ''
	}
})
void list()
	.then(() => (currentFileId ? open(currentFileId) : undefined))
	.catch(showError)
