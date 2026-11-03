import type { AppEnv } from './src/env-schema.ts'

declare global {
	interface Env extends AppEnv {}

	// `cloudflare:workers` / `cloudflare:test` type `env` as `Cloudflare.Env`.
	namespace Cloudflare {
		interface Env extends AppEnv {}
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
