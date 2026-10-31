// Runs `kody daemon` the way the desktop app does: as an IPC child whose
// 'stop' message (or a lost parent) drains in-process. On Windows that is the
// only graceful stop; a signal from outside is a hard TerminateProcess.
const { pathToFileURL } = require('node:url')
const { join } = require('node:path')

require('../../packages/desktop/owner-lifetime.cjs').bindOwnerLifetime()

async function main() {
	const { runCli } = await import(
		pathToFileURL(join(__dirname, '../../packages/cli/dist/cli.js')).href
	)
	process.exit(await runCli(process.argv.slice(2)))
}
main().catch((error) => {
	process.stderr.write(`${error.message}\n`)
	process.exit(1)
})
