import { readFile, rm } from 'node:fs/promises'
import { isExecutedDirectly } from './node-runtime.ts'
import {
	generateStartRouteTree,
	startRouteTreeCheckPath,
	startRouteTreePath,
} from './generate-start-route-tree.ts'

export function startRouteTreeDrift(committed: string, generated: string) {
	if (committed === generated) return null
	const committedLines = committed.split('\n')
	const generatedLines = generated.split('\n')
	const samples: Array<string> = []
	const limit = Math.max(committedLines.length, generatedLines.length)
	for (let index = 0; index < limit && samples.length < 12; index += 1) {
		const before = committedLines[index]
		const after = generatedLines[index]
		if (before === after) continue
		samples.push(
			`line ${String(index + 1)}\n- ${before ?? '<missing>'}\n+ ${after ?? '<missing>'}`,
		)
	}
	return samples
}

export async function checkStartRouteTree() {
	let generated: string
	try {
		await generateStartRouteTree(startRouteTreeCheckPath)
		generated = await readFile(startRouteTreeCheckPath, 'utf8')
	} finally {
		await rm(startRouteTreeCheckPath, { force: true })
	}
	const committed = await readFile(startRouteTreePath, 'utf8')
	const drift = startRouteTreeDrift(committed, generated)
	if (!drift) return
	console.error(
		`${startRouteTreePath} does not match \`npm run routes:generate\`.`,
	)
	console.error(
		'Run `npm run routes:generate` and commit that file. Do not hand-edit it.',
	)
	for (const sample of drift) console.error(sample)
	process.exitCode = 1
}

if (isExecutedDirectly(import.meta.url)) {
	await checkStartRouteTree()
}
