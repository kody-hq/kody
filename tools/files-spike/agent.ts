import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'

const { values } = parseArgs({
	options: {
		origin: { type: 'string', default: 'http://127.0.0.1:13752' },
		file: { type: 'string' },
		create: { type: 'string' },
		patch: { type: 'string' },
		checkpoint: { type: 'boolean' },
		export: { type: 'boolean' },
	},
})
const origin = new URL(values.origin)
if (!['localhost', '127.0.0.1'].includes(origin.hostname))
	throw new Error('This agent harness only connects to the local files spike.')
if (!values.create && (!values.file || !/^[a-f0-9-]{36}$/.test(values.file)))
	throw new Error('Pass --file <id> from the browser URL.')
if (
	[values.create, values.patch, values.checkpoint, values.export].filter(
		Boolean,
	).length > 1
)
	throw new Error('Choose one operation per invocation.')
const action = values.patch
	? '/patch'
	: values.checkpoint
		? '/checkpoint'
		: values.export
			? '/export'
			: ''
const body = values.create
	? JSON.stringify({ name: values.create })
	: values.patch
		? await readFile(values.patch, 'utf8')
		: values.checkpoint
			? '{}'
			: undefined
const response = await fetch(
	new URL(values.create ? '/files' : `/files/${values.file}${action}`, origin),
	{
		method: body ? 'POST' : 'GET',
		headers: {
			Authorization: 'Bearer agent',
			'Content-Type': 'application/json',
		},
		...(body ? { body } : {}),
	},
)
const result = await response.json()
console.log(JSON.stringify(result, null, 2))
if (!response.ok) process.exitCode = 1
