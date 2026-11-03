import type { AdminProviderMarksLoaderData } from '#universal/loader-data.ts'
import {
	buildProviderMarkLogoPath,
	builtInProviderMarkAliases,
	listPlatformProviderMarks,
} from '#worker/integrations/provider-marks.ts'

export async function loadAdminProviderMarksData(
	env: Pick<Env, 'APP_DB'>,
): Promise<AdminProviderMarksLoaderData> {
	const marks = await listPlatformProviderMarks({ db: env.APP_DB })
	return {
		ok: true,
		marks: marks.map((mark) => ({
			slug: mark.slug,
			label: mark.label,
			aliases: mark.aliases,
			builtInAliases: builtInProviderMarkAliases(mark.slug),
			logoPath: buildProviderMarkLogoPath(mark),
			createdAt: mark.createdAt,
			updatedAt: mark.updatedAt,
		})),
	}
}
