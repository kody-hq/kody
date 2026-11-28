import * as Y from 'yjs'
import type { CollaborationActor } from '#universal/file-collaboration.ts'

export const agentSelectionMs = 400
export const agentHighlightMs = 30_000
type SharedType = Parameters<typeof Y.createRelativePositionFromTypeIndex>[0]

export type AgentEditRange = {
	start: Y.RelativePosition
	end: Y.RelativePosition
}
export type AgentEdit = {
	agent: Pick<CollaborationActor, 'id' | 'name'>
	before: AgentEditRange[]
	after: AgentEditRange[]
}

function range(type: SharedType, start: number, end: number) {
	return {
		start: Y.createRelativePositionFromTypeIndex(type, start),
		end: Y.createRelativePositionFromTypeIndex(
			type,
			end,
			start === end ? 0 : -1,
		),
	}
}

/** Inspect the incoming delta without editing the live document or its undo history. */
export function agentEditRanges(doc: Y.Doc, update: Uint8Array) {
	const probe = new Y.Doc()
	const before: AgentEditRange[] = []
	const after: AgentEditRange[] = []
	try {
		const text = probe.getText('content')
		const page = probe.getXmlFragment('default')
		Y.applyUpdate(probe, Y.encodeStateAsUpdate(doc))

		function collect(events: Y.YEvent<SharedType>[]) {
			for (const event of events) {
				const target = event.target
				const previous = Y.createAbsolutePositionFromRelativePosition(
					Y.createRelativePositionFromTypeIndex(target, 0, -1),
					doc,
				)?.type
				if (!previous) continue
				const oldTarget = previous

				let oldIndex = 0
				let newIndex = 0
				let change: { oldStart: number; newStart: number } | undefined
				function finish() {
					if (!change) return
					before.push(range(oldTarget, change.oldStart, oldIndex))
					after.push(range(target, change.newStart, newIndex))
					change = undefined
				}
				for (const step of event.delta) {
					if (step.retain) {
						finish()
						oldIndex += step.retain
						newIndex += step.retain
						if (step.attributes) {
							before.push(range(previous, oldIndex - step.retain, oldIndex))
							after.push(range(target, newIndex - step.retain, newIndex))
						}
					} else {
						change ??= { oldStart: oldIndex, newStart: newIndex }
						oldIndex += step.delete ?? 0
						if (step.insert !== undefined)
							newIndex +=
								typeof step.insert === 'string' || Array.isArray(step.insert)
									? step.insert.length
									: 1
					}
				}
				finish()

				if (
					event.keys.size &&
					target instanceof Y.XmlElement &&
					target.parent instanceof Y.XmlFragment &&
					previous instanceof Y.XmlElement &&
					previous.parent instanceof Y.XmlFragment
				) {
					const oldParent = previous.parent
					const newParent = target.parent
					const from = oldParent.toArray().indexOf(previous)
					const to = newParent.toArray().indexOf(target)
					if (from < 0 || to < 0) continue
					before.push(range(oldParent, from, from + 1))
					after.push(range(newParent, to, to + 1))
				}
			}
		}
		text.observeDeep(collect)
		page.observeDeep(collect)
		Y.applyUpdate(probe, update)
		return { before, after }
	} finally {
		probe.destroy()
	}
}
