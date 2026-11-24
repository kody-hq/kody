import type { AppEnv } from './src/env-schema.ts'

declare global {
	interface Env extends AppEnv {}

	// `cloudflare:workers` / `cloudflare:test` type `env` as `Cloudflare.Env`.
	namespace Cloudflare {
		interface Env extends AppEnv {}
	}

	// The worker projects do not load `vite/client`; these are the Vite
	// constants the Worker-side entry reads.
	interface ImportMetaEnv {
		readonly DEV: boolean
		readonly VITE_KODY_PERF_PROBE?: string
	}
	interface ImportMeta {
		readonly env: ImportMetaEnv
	}

	interface CustomExportedHandler<Props = {}> {
		fetch: (
			request: Request,
			env: Env,
			ctx: ExecutionContext<Props>,
		) => Response | Promise<Response>
	}
}

export {}
