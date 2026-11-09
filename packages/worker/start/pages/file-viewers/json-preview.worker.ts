import {
	describeJson,
	jsonSourceLines,
	type JsonRequest,
	type JsonResponse,
} from '#universal/json-preview.ts'
const values = new Map<string, unknown>()
const keys = new Map<string, string[]>()
function send(message: JsonResponse) {
	self.postMessage(message)
}
self.onmessage = async (event: MessageEvent<JsonRequest>) => {
	const request = event.data
	try {
		if (request.type === 'load') {
			let source = request.content
			if (source === undefined) {
				const response = await fetch(request.src)
				if (!response.ok) throw new Error('Could not load JSON.')
				source = await response.text()
			}
			const lines = jsonSourceLines(source)
			try {
				const value: unknown = JSON.parse(source)
				values.clear()
				keys.clear()
				values.set('', value)
				send({ type: 'ready', lines, root: describeJson('', '$', value) })
			} catch (cause) {
				send({
					type: 'ready',
					lines,
					invalid: cause instanceof Error ? cause.message : 'Invalid JSON.',
				})
			}
		} else {
			const value = values.get(request.id)
			if (value === null || typeof value !== 'object')
				throw new Error('This value has no children.')
			const array = Array.isArray(value)
			let names = keys.get(request.id)
			if (!array && !names) {
				names = Object.keys(value)
				keys.set(request.id, names)
			}
			const total = array ? value.length : names!.length
			const children = []
			for (
				let index = request.offset;
				index < Math.min(total, request.offset + 500);
				index++
			) {
				const name = array ? String(index) : names![index]!,
					id =
						request.id + '/' + name.replaceAll('~', '~0').replaceAll('/', '~1')
				const child = (value as Record<string, unknown>)[name]
				values.set(id, child)
				children.push(describeJson(id, name, child))
			}
			send({
				type: 'children',
				id: request.id,
				offset: request.offset,
				children,
				total,
			})
		}
	} catch (cause) {
		send({
			type: 'error',
			message: cause instanceof Error ? cause.message : 'Could not read JSON.',
		})
	}
}
