// A detached CLI owns its process group. Losing desktop IPC must stop both
// the CLI and any workerd processes, including an unresponsive child.
function bindOwnerLifetime() {
	let stopping = false
	function stop() {
		if (stopping) return
		stopping = true
		const deadline = setTimeout(() => {
			if (process.platform !== 'win32') process.kill(-process.pid, 'SIGKILL')
			else process.exit(1)
		}, 5000)
		deadline.unref()
		process.kill(process.pid, 'SIGTERM')
	}
	process.on('disconnect', stop)
	process.on('message', (message) => {
		if (message === 'stop') stop()
	})
}
module.exports = { bindOwnerLifetime }
