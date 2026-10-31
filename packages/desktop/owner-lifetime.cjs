// A detached CLI owns its process group. Losing desktop IPC must stop both
// the CLI and any workerd processes, including an unresponsive child.
function bindOwnerLifetime() {
	let stopping = false
	function stop() {
		if (stopping) return
		stopping = true
		const deadline = setTimeout(() => {
			if (process.platform !== 'win32') process.kill(-process.pid, 'SIGKILL')
			else process.exit(1) // 'exit' handlers still kill tracked workers.
		}, 5000)
		deadline.unref()
		// On Windows, signalling yourself is a hard TerminateProcess that skips
		// the daemon's drain and cleanup: run its SIGTERM handlers in-process.
		if (process.platform !== 'win32') process.kill(process.pid, 'SIGTERM')
		else if (process.listenerCount('SIGTERM') > 0)
			process.emit('SIGTERM', 'SIGTERM')
		else process.exit(0)
	}
	process.on('disconnect', stop)
	process.on('message', (message) => {
		if (message === 'stop') stop()
	})
}
module.exports = { bindOwnerLifetime }
