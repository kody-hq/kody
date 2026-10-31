const { fork } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { join } = require('node:path')
const { killWindowsTree } = require('./process-tree.cjs')

class Runner extends EventEmitter {
	constructor() {
		super()
		this.children = new Set()
		this.daemon = null
		this.closing = false
		this.output = ''
	}

	launch(args, extraEnv = {}) {
		if (this.closing) throw new Error('Kody is quitting.')
		const env = {
			...process.env,
			...extraEnv,
			ELECTRON_RUN_AS_NODE: '1',
			KODY_CREDENTIAL_SOURCE: 'login',
			KODY_SKIP_SKILL_REFRESH: '1',
			KODY_SKIP_GIT_HELPER_REFRESH: '1',
		}
		// Desktop always uses production and the stored CLI login, never a token
		// or alternate origin inherited from the terminal that launched Electron.
		for (const key of [
			'KODY_API_TOKEN',
			'KODY_API_URL',
			'KODY_MCP_URL',
			'KODY_TARGET',
			'KODY_ORG',
			'KODY_MOCK_SESSION_ID',
			'NODE_OPTIONS',
			'NODE_PATH',
		])
			delete env[key]
		const child = fork(join(__dirname, 'cli-host.cjs'), args, {
			execArgv: [],
			env,
			silent: true,
			detached: process.platform !== 'win32',
		})
		return this.trackChild(child)
	}

	trackChild(child) {
		child.kodyStartedAt = Date.now()
		this.children.add(child)
		// A native crash can skip the CLI's finally block. The desktop still
		// owns this process group and must stop any workerd left behind.
		child.once('exit', () => this.killGroup(child))
		child.once('close', () => this.children.delete(child))
		child.on('error', () => {}) // Reported by the command or daemon below.
		return child
	}

	killGroup(child) {
		if (!child.pid) return
		if (process.platform === 'win32') {
			const done = new Promise((resolve) =>
				killWindowsTree(
					child.pid,
					child.kodyStartedAt ?? 0,
					resolve,
					child.exitCode === null && child.signalCode === null,
				),
			)
			this.treeKills = [...(this.treeKills ?? []), done]
			return
		}
		try {
			process.kill(-child.pid, 'SIGKILL')
		} catch (error) {
			if (error.code !== 'ESRCH') this.emit('shutdown-error', error)
		}
	}

	// `okCodes`: exit codes that still resolve with stdout (status exits 1 on
	// problems but prints its JSON).
	command(args, { okCodes = [0] } = {}) {
		const child = this.launch(args)
		return new Promise((resolve, reject) => {
			let output = ''
			let errors = ''
			const timer = setTimeout(() => {
				this.stopChild(child)
				reject(new Error('The CLI command timed out. Try again.'))
			}, 180_000)
			child.stdout.on('data', (chunk) => {
				output = (output + chunk).slice(-64 * 1024)
			})
			child.stderr.on('data', (chunk) => {
				errors = (errors + chunk).slice(-16 * 1024)
			})
			child.once('error', (error) => {
				clearTimeout(timer)
				reject(error)
			})
			child.once('close', (code) => {
				clearTimeout(timer)
				if (okCodes.includes(code)) resolve(output)
				else reject(new Error(errors.trim() || `CLI exited with code ${code}.`))
			})
		})
	}

	start(ecid) {
		if (!/^ec_[A-Za-z0-9_-]+$/.test(ecid))
			throw new Error('Register this machine first.')
		if (this.daemon) return
		// The CLI takes the machine's runner lock for this context, so this
		// refuses with a clear message when a service or terminal runs it.
		const child = this.launch(['daemon', '--context', ecid], {
			KODY_DAEMON_LAUNCHER: 'desktop',
		})
		this.daemon = child
		this.output = ''
		const log = (chunk) => {
			this.output = (this.output + chunk).slice(-32 * 1024)
			this.emit('change')
		}
		child.stdout.on('data', log)
		child.stderr.on('data', log)
		child.once('error', (error) => log(`${error.message}\n`))
		child.once('close', (code) => {
			if (this.daemon === child) this.daemon = null
			this.emit('change')
			if (!this.closing && !child.kodyStopping) this.emit('ended', code)
		})
		this.emit('change')
	}

	stopChild(child) {
		child.kodyStopping = true
		if (child.connected) child.send('stop', () => {})
	}

	async stop() {
		if (this.daemon) await this.settle(this.daemon)
	}

	async settle(child) {
		if (child.exitCode !== null || child.signalCode !== null) return
		await new Promise((resolve) => {
			const timer = setTimeout(() => {
				// POSIX process group includes workerd, not just the CLI parent.
				try {
					this.killGroup(child)
				} catch (error) {
					if (error.code !== 'ESRCH') this.emit('shutdown-error', error)
				}
			}, 6500)
			child.once('close', () => {
				clearTimeout(timer)
				resolve()
			})
			this.stopChild(child)
		})
	}

	async close() {
		this.closing = true
		await Promise.all([...this.children].map((child) => this.settle(child)))
		await Promise.all(this.treeKills ?? [])
	}
}
module.exports = { Runner }
