/** The CLI needs Node 22.19+ (`package.json` `engines`; `kody app check` runs Lighthouse 13). */
const minimumNodeVersion = [22, 19, 0] as const
const minimumNodeLabel = minimumNodeVersion.slice(0, 2).join('.')

/**
 * Refuse a local-runtime command before any download or spawn when Node is too
 * old. `package.json` `engines` is advisory; npx and a direct `node` launch do
 * not enforce it.
 */
export function assertNodeEngine(
	input: { command: string; reason: string },
	version: string = process.versions.node,
): void {
	const parsed = parseNodeVersion(version)
	if (parsed && compareVersions(parsed, minimumNodeVersion) >= 0) return
	const reported = version.trim() || 'unknown'
	throw new Error(
		`${input.command} needs Node.js ${minimumNodeLabel} or newer (this process is v${reported}). ${input.reason} Upgrade Node.js and retry.`,
	)
}

export const localExecuteNodeEngine = {
	command: 'execute --local',
	reason: 'Local execute runs your module in workerd.',
}

export const appCheckNodeEngine = {
	command: 'kody app check',
	reason: 'The check runs Lighthouse 13.',
}

function parseNodeVersion(
	version: string,
): readonly [number, number, number] | null {
	const match = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version.trim())
	if (!match) return null
	return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
}

function compareVersions(
	a: readonly [number, number, number],
	b: readonly [number, number, number],
): number {
	for (let index = 0; index < 3; index++) {
		const diff = a[index]! - b[index]!
		if (diff !== 0) return diff
	}
	return 0
}
