// One runner per machine: the desktop app and the kody CLI share this
// machine's registration and its daemon. This decides who owns the runner
// from `kody daemon status --json` and what the machine controls offer.

const launcherNames = {
	systemd: 'CLI service (systemd)',
	launchd: 'CLI service (launchd)',
	terminal: 'kody daemon in a terminal',
	desktop: 'another Kody desktop app',
}

function runnerView({ status, ownRunning, hasRegistration }) {
	if (ownRunning)
		return {
			mode: 'desktop',
			label: 'Runner running (this app)',
			canStart: false,
			canStop: true,
			canRestart: true,
		}
	// A stopped service can coexist with a terminal or desktop daemon holding
	// the lock; that holder is the runner (`kody daemon stop` stops it too).
	if (status?.installed && !(status.running === false && status.runner)) {
		const name = launcherNames[status.manager] ?? 'CLI service'
		return {
			mode: 'service',
			label: status.running
				? `Runner running: ${name}${status.runningVersion ? `, kody ${status.runningVersion}` : ''}`
				: `Runner stopped: ${name}`,
			canStart: !status.running,
			canStop: status.running,
			canRestart: status.running,
		}
	}
	if (status?.runner) {
		return {
			mode: 'external',
			label: `Runner running: ${launcherNames[status.runner.launcher] ?? 'kody daemon'} (pid ${status.runner.pid}), kody ${status.runner.version}`,
			canStart: false,
			canStop: true,
			canRestart: false,
		}
	}
	return {
		mode: 'none',
		label: 'Runner stopped',
		canStart: hasRegistration,
		canStop: false,
		canRestart: false,
	}
}

// The registration the CLI already holds on this machine, if any.
function existingRegistration(status) {
	if (!status) return null
	const valid = (id) => typeof id === 'string' && /^ec_[A-Za-z0-9_-]+$/.test(id)
	if (valid(status.ecid))
		return { ecid: status.ecid, name: status.contextName ?? null }
	const first = Array.isArray(status.contexts)
		? status.contexts.find((context) => valid(context?.ecid))
		: null
	return first ? { ecid: first.ecid, name: first.name ?? null } : null
}

// A service or another daemon already runs it: the app adopts that runner.
function shouldAdopt(status) {
	return Boolean(status?.installed || status?.runner)
}

module.exports = {
	existingRegistration,
	runnerView,
	shouldAdopt,
}
