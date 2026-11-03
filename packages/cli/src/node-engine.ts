/** Local execute shells out to workerd; this CLI supports that only on Node 22+. */
const minimumLocalExecuteNodeMajor = 22

/**
 * Refuse `execute --local` before workerd download or spawn when Node is too old.
 * `package.json` `engines` is advisory; npx and a direct `node` launch do not enforce it.
 */
export function assertLocalExecuteNodeEngine(
	version: string = process.versions.node,
): void {
	const major = nodeMajor(version)
	if (major !== null && major >= minimumLocalExecuteNodeMajor) return
	const reported = version.trim() || 'unknown'
	throw new Error(
		`execute --local needs Node.js ${minimumLocalExecuteNodeMajor} or newer (this process is v${reported}). Local execute runs your module in workerd. Upgrade Node.js and retry.`,
	)
}

function nodeMajor(version: string): number | null {
	const match = /^v?(\d+)/.exec(version.trim())
	if (!match) return null
	const major = Number(match[1])
	return Number.isInteger(major) ? major : null
}
