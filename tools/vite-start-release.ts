import { mkdir, readdir, rename } from 'node:fs/promises'
import path from 'node:path'
import { type Plugin } from 'vite'

/** A release namespace is an immutable full Git object ID. */
export function startReleaseBase(release: string | undefined): string {
	if (release === undefined || release === '') return '/'
	if (!/^[a-f0-9]{40}$/.test(release)) {
		throw new Error(
			'KODY_START_RELEASE must be a full lowercase Git commit SHA',
		)
	}
	return `/__start/${release}/`
}

/** Cloudflare serves physical asset paths relative to its emitted client directory. */
export function startReleaseAssets(base: string): Plugin {
	return {
		name: 'kody-start-release-assets',
		apply: 'build',
		enforce: 'post',
		buildApp: {
			order: 'post',
			async handler(builder) {
				if (base === '/') return
				const client = builder.environments.client
				if (!client?.isBuilt)
					throw new Error('Start release client build is missing')
				const directory = path.resolve(
					builder.config.root,
					client.config.build.outDir,
				)
				const entries = await readdir(directory)
				const destination = path.join(directory, base.slice(1))
				await mkdir(destination, { recursive: true })
				for (const entry of entries) {
					// Cloudflare control files apply to the whole asset binding.
					if (['.assetsignore', '_headers', '_redirects'].includes(entry))
						continue
					if (entry === '__start')
						throw new Error('Start release output already contains a namespace')
					await rename(
						path.join(directory, entry),
						path.join(destination, entry),
					)
				}
			},
		},
	}
}
