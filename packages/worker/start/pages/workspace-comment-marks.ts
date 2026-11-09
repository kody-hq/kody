import { Extension } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import * as Y from 'yjs'
import {
	relativePositionToAbsolutePosition,
	ySyncPluginKey,
} from '@tiptap/y-tiptap'
import {
	type FileThread,
	type CommentAnchor,
} from '#universal/file-collaboration.ts'

export function workspaceCommentMarks(
	current: () => {
		threads: FileThread[]
		select?: (thread: FileThread) => void
		activeThreadId?: string | null
		draftAnchor?: CommentAnchor
	},
) {
	return Extension.create({
		name: 'workspaceCommentMarks',
		addProseMirrorPlugins() {
			return [
				new Plugin({
					props: {
						decorations(state) {
							const marks: Decoration[] = []
							const binding = ySyncPluginKey.getState(state)?.binding
							const data = current()
							const threads = data.threads.filter(
								(thread) =>
									(!thread.resolvedAt || thread.id === data.activeThreadId) &&
									!thread.outdated &&
									thread.anchor.kind !== 'file',
							)
							const anchors = threads.map((thread) => ({
								anchor: thread.anchor,
								id: thread.id,
								active: thread.id === data.activeThreadId,
							}))
							if (data.draftAnchor && data.draftAnchor.kind !== 'file')
								anchors.push({ anchor: data.draftAnchor, id: '', active: true })
							for (const entry of anchors) {
								const { anchor } = entry
								const attrs: Record<string, string> = {
									class: `workspace-comment-anchor${entry.active ? ' workspace-comment-active' : ''}`,
								}
								if (entry.id) attrs['data-comment-thread'] = entry.id
								else attrs['data-comment-draft'] = 'true'
								if (anchor.kind === 'block') {
									const id = anchor.blockId
									state.doc.forEach((node, offset) => {
										if (node.attrs.id === id)
											marks.push(
												Decoration.node(offset, offset + node.nodeSize, attrs),
											)
									})
								} else if (anchor.kind === 'text' && binding) {
									try {
										const from = relativePositionToAbsolutePosition(
											binding.doc,
											binding.type,
											Y.createRelativePositionFromJSON(
												JSON.parse(anchor.start),
											),
											binding.mapping,
										)
										const to = relativePositionToAbsolutePosition(
											binding.doc,
											binding.type,
											Y.createRelativePositionFromJSON(JSON.parse(anchor.end)),
											binding.mapping,
										)
										if (from !== null && to !== null && from !== to)
											marks.push(
												Decoration.inline(
													Math.min(from, to),
													Math.max(from, to),
													attrs,
												),
											)
									} catch {
										/* Deleted anchors remain available in the discussion rail. */
									}
								}
							}
							state.doc.forEach((node, offset) => {
								const grouped = threads.filter(
									(thread) =>
										(thread.anchor.kind === 'block' ||
											thread.anchor.kind === 'text') &&
										thread.anchor.blockId === node.attrs.id,
								)
								if (!grouped.length) return
								marks.push(
									Decoration.widget(
										offset + node.nodeSize - 1,
										() => {
											const button = document.createElement('button')
											button.type = 'button'
											button.contentEditable = 'false'
											button.className = 'workspace-comment-marker'
											button.setAttribute(
												'aria-label',
												`Open ${grouped.length === 1 ? 'discussion' : `${grouped.length} discussions`} on this block`,
											)
											button.textContent = String(grouped.length)
											button.addEventListener('mousedown', (event) =>
												event.preventDefault(),
											)
											button.addEventListener('click', (event) => {
												event.stopPropagation()
												const data = current()
												data.select?.(
													data.threads.find(
														(thread) =>
															grouped.some((item) => item.id === thread.id) &&
															thread.id === data.activeThreadId,
													) ?? grouped[0]!,
												)
											})
											return button
										},
										{
											key: `comment-marker:${node.attrs.id}:${grouped.map((thread) => thread.id).join(',')}`,
											stopEvent: () => true,
										},
									),
								)
							})
							return DecorationSet.create(state.doc, marks)
						},
						handleClick(_view, _pos, event) {
							const id =
								event.target instanceof Element
									? event.target
											.closest('[data-comment-thread]')
											?.getAttribute('data-comment-thread')
									: null
							const thread = current().threads.find(
								(thread) => thread.id === id,
							)
							if (thread) current().select?.(thread)
							return false
						},
					},
				}),
			]
		},
	})
}
