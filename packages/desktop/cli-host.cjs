const { pathToFileURL } = require('node:url')

const { bindOwnerLifetime } = require('./owner-lifetime.cjs')
bindOwnerLifetime()

async function main() {
	const { runCli } = await import(
		pathToFileURL(require.resolve('@kodycodes/cli')).href
	)
	const code = await runCli(process.argv.slice(2))
	process.exit(code)
}
main().catch((error) => {
	process.stderr.write(`${error.message}\n`)
	process.exit(1)
})
