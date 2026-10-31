const { machineName } = require('./machine-name.cjs')
const { registrationIdentity } = require('./registration-identity.cjs')

// This controller exposes fixed machine actions, never arbitrary CLI commands.
class DesktopExecution {
	constructor({
		runner,
		read,
		write,
		viewer,
		hostname,
		platform = process.platform,
		confirmCommands = async () => false,
	}) {
		Object.assign(this, {
			runner,
			read,
			write,
			viewer,
			platform,
			confirmCommands,
		})
		this.commandsEnabled = null
		this.name = machineName(hostname)
		this.busy = false
		this.authorized = null
		this.error = null
	}
	owns(state, viewer) {
		return (
			state.owner?.username === viewer.username &&
			state.owner?.orgSlug === viewer.orgSlug
		)
	}
	async identity(viewer) {
		const identity = JSON.parse(
			await this.runner.command(['whoami', '--org', viewer.orgSlug, '--json']),
		)
		registrationIdentity(identity)
		if (
			identity.user.email.toLowerCase() !== viewer.email.toLowerCase() ||
			identity.org !== viewer.orgSlug ||
			identity.credential?.source !== 'login'
		)
			throw new Error(
				'The CLI account does not match this workspace. Sign in to this machine again with the same account.',
			)
		return identity
	}
	async snapshot(viewer) {
		const state = this.read()
		const owns = viewer && this.owns(state, viewer)
		if (!this.busy) {
			if (!owns && this.runner.daemon) await this.runner.stop()
			if (
				owns &&
				state.ecid &&
				state.enabled &&
				!this.runner.daemon &&
				!this.error &&
				this.platform !== 'win32'
			)
				this.runner.start(state.ecid)
		}
		return {
			name: owns && state.name ? state.name : this.name,
			platform: this.platform,
			supported: this.platform !== 'win32',
			signedIn: !!viewer,
			busy: this.busy,
			contextId: owns ? state.ecid : null,
			hasSetup: !!state.ecid,
			commandsEnabled: owns ? this.commandsEnabled : null,
			running: !!owns && !!this.runner.daemon,
			needsVerification: !!viewer && !!state.ecid && !state.owner,
			blocked: !!viewer && !!state.ecid && !!state.owner && !owns,
			onboardingSeen:
				!!viewer && (state.onboardingSeen ?? []).includes(viewer.username),
			cliReady:
				!!viewer && this.authorized === `${viewer.username}:${viewer.orgSlug}`,
			error: owns ? this.error : null,
		}
	}
	async request(command, input) {
		if (command === 'state') return this.snapshot(await this.viewer())
		if (this.busy)
			throw new Error('Machine setup is already running. Please wait.')
		const viewer = await this.viewer()
		if (this.busy)
			throw new Error('Machine setup is already running. Please wait.')
		if (!viewer)
			throw new Error('Sign in to Kody before setting up this machine.')
		const state = this.read()
		if (command === 'forget') {
			this.busy = true
			try {
				await this.runner.stop()
				this.write({
					ecid: null,
					enabled: false,
					owner: null,
					onboardingSeen: [
						...new Set([...(state.onboardingSeen ?? []), viewer.username]),
					],
				})
				this.commandsEnabled = null
				this.authorized = null
				this.error = null
			} finally {
				this.busy = false
			}
			return this.snapshot(viewer)
		}
		if (state.ecid && state.owner && !this.owns(state, viewer))
			throw new Error(
				'This app manages a registration for another workspace. Switch to that account to manage it.',
			)
		if (command === 'dismiss' || command === 'complete') {
			if (command === 'complete' && (!state.ecid || !this.owns(state, viewer)))
				throw new Error('Finish registering this machine first.')
			this.write({
				...state,
				onboardingSeen: [
					...new Set([...(state.onboardingSeen ?? []), viewer.username]),
				],
			})
			return this.snapshot(viewer)
		}
		if (
			![
				'sign-in',
				'connect',
				'start',
				'stop',
				'commands-status',
				'commands-on',
				'commands-off',
			].includes(command)
		)
			throw new Error('Unknown machine action.')
		if (this.platform === 'win32')
			throw new Error(
				'Local execution is not available on Windows in this version.',
			)
		this.busy = true
		try {
			if (command.startsWith('commands-')) {
				if (!state.ecid || !this.owns(state, viewer))
					throw new Error('Set up this machine first.')
				if (command === 'commands-on' && !(await this.confirmCommands()))
					return this.snapshot(await this.viewer())
				const current = await this.viewer()
				if (
					current?.username !== viewer.username ||
					current.orgSlug !== viewer.orgSlug
				)
					throw new Error('The signed-in account changed. Start setup again.')
				const args = [
					'context',
					'commands',
					command.slice('commands-'.length),
					'--context',
					state.ecid,
					'--json',
				]
				if (command !== 'commands-status') await this.runner.command(args)
				const status = JSON.parse(
					await this.runner.command([
						'context',
						'commands',
						'status',
						'--context',
						state.ecid,
						'--json',
					]),
				)
				this.commandsEnabled =
					status.local?.enabled === true &&
					status.contexts?.[0]?.commands?.enabled === true
			} else if (command === 'sign-in') {
				await this.runner.command(['login', '--org', viewer.orgSlug])
				const current = await this.viewer()
				if (
					current?.username !== viewer.username ||
					current.orgSlug !== viewer.orgSlug
				)
					throw new Error('The signed-in account changed. Start setup again.')
				await this.identity(viewer)
				// Older shells saved a context ID without its account. Adopt it only after
				// authenticating and checking server-side ownership, never by ID alone.
				if (state.ecid && !state.owner) {
					const listed = JSON.parse(
						await this.runner.command([
							'context',
							'list',
							'--org',
							viewer.orgSlug,
							'--json',
						]),
					)
					const context = listed.contexts?.find(
						(item) => item.id === state.ecid,
					)
					if (
						context?.operator?.handle !== viewer.username ||
						context?.ownerOrg?.slug !== viewer.orgSlug ||
						context.status === 'revoked'
					)
						throw new Error(
							'The existing desktop registration does not belong to this workspace. Forget this app’s setup before registering another account.',
						)
					this.write({
						...state,
						owner: { username: viewer.username, orgSlug: viewer.orgSlug },
						name: context.name,
					})
				}
				this.authorized = `${viewer.username}:${viewer.orgSlug}`
			} else if (command === 'connect') {
				if (this.authorized !== `${viewer.username}:${viewer.orgSlug}`)
					throw new Error('Sign in to this machine before enabling execution.')
				if (
					typeof input !== 'string' ||
					!/^[a-z0-9][a-z0-9-]{0,62}$/.test(input)
				)
					throw new Error(
						'Use 1 to 63 lowercase letters, digits, or dashes for the machine name.',
					)
				await this.identity(viewer)
				let next = this.read()
				if (!next.ecid) {
					const registered = JSON.parse(
						await this.runner.command([
							'context',
							'register',
							'--org',
							viewer.orgSlug,
							'--name',
							input,
							'--json',
						]),
					)
					if (!/^ec_[A-Za-z0-9_-]+$/.test(registered.ecid ?? ''))
						throw new Error('The machine could not be registered. Try again.')
					next = {
						...next,
						ecid: registered.ecid,
						name: input,
						owner: { username: viewer.username, orgSlug: viewer.orgSlug },
					}
					this.write(next)
				}
				// Persist before starting so retrying a failed chain update never creates
				// another context or loses the local key's registration.
				this.error = null
				this.write({ ...next, enabled: true })
				this.runner.start(next.ecid)
			} else {
				if (!state.ecid || !this.owns(state, viewer))
					throw new Error('Set up this machine first.')
				this.error = null
				this.write({ ...state, enabled: command === 'start' })
				if (command === 'start') this.runner.start(state.ecid)
				else await this.runner.stop()
			}
		} finally {
			this.busy = false
		}
		return this.snapshot(await this.viewer())
	}
}
module.exports = { DesktopExecution }
