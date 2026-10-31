require('../owner-lifetime.cjs').bindOwnerLifetime()
const { spawn } = require('node:child_process')
const command = process.argv[2]
if (command === 'fail') {
	process.stderr.write('Registration refused\n')
	process.exit(2)
} else if (command === 'wait') {
	process.stdout.write('Waiting\n')
	setInterval(() => {}, 1000)
} else if (command === 'daemon') {
	const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'])
	process.stdout.write(`${worker.pid}\n`)
	process.on('SIGTERM', () => {
		worker.kill()
		worker.on('close', () => process.exit(0))
	})
} else {
	process.stdout.write(JSON.stringify(process.argv.slice(2)))
	process.exit(0)
}
