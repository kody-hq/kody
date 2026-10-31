const { fork } = require('node:child_process')
const { EventEmitter } = require('node:events')
const { join } = require('node:path')

class Runner extends EventEmitter {
	constructor() {
		super()
		this.children = new Set()
		this.daemon = null
		this.closing = false
		this.output = ''
	}

	launch(args) {
		if (this.closing) throw new Error('Kody is quitting.')
		const env = {
			...process.env,
			ELECTRON_RUN_AS_NODE: '1',
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
		this.children.add(child)
		// A native crash can skip the CLI's finally block. The desktop still
		// owns this process group and must stop any workerd left behind.
		child.once('exit', () => this.killGroup(child))
		child.once('close', () => this.children.delete(child))
		child.on('error', () => {}) // Reported by the command or daemon below.
		return child
	}

	killGroup(child) {
		if (process.platform === 'win32' || !child.pid) return
		try {
			process.kill(-child.pid, 'SIGKILL')
		} catch (error) {
			if (error.code !== 'ESRCH') this.emit('shutdown-error', error)
		}
	}

	command(args) {
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
				if (code === 0) resolve(output)
				else reject(new Error(errors.trim() || `CLI exited with code ${code}.`))
			})
		})
	}

	start(ecid) {
		if (!/^ec_[A-Za-z0-9_-]+$/.test(ecid))
			throw new Error('Register this machine first.')
		if (process.platform === 'win32')
			throw new Error(
				'Local execution currently supports macOS and Linux. The CLI workerd runtime does not support Windows yet.',
			)
		if (this.daemon) return
		const child = this.launch(['daemon', '--context', ecid])
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
					if (process.platform !== 'win32') this.killGroup(child)
					else child.kill('SIGKILL')
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
	}
}
module.exports = { Runner }
