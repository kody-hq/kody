/** @jsxImportSource @emotion/react */
import { createFileRoute, stripSearchParams } from '@tanstack/react-router'
import { createPageQuery, loadPageQuery, usePageQuery } from '../page-query.ts'
import { loadSkillsPage } from '#start/server/skills'
import { SkillsPage, type SkillsSearch } from '../pages/skills.tsx'

const pageQuery = createPageQuery('loadSkillsPage', loadSkillsPage, {
	freshAuthorization: true,
})

export const Route = createFileRoute('/_app/@{$orgSlug}_/-/skills')({
	staticData: {
		presentationSearchKeys: [
			'q',
			'page',
			'pageSize',
			'sort',
			'desc',
			'package',
			'activity',
			'view',
		],
		workspaceSwitch: { section: 'skills' },
		navigation: { rail: 'workspace', item: 'skills' },
		orgScope: { section: 'skills' },
		shell: { gutters: 'page' },
	},
	validateSearch: (search: Record<string, unknown>) => ({
		page:
			Number.isSafeInteger(Number(search.page)) && Number(search.page) > 0
				? Number(search.page)
				: 1,
		pageSize: [10, 25, 50, 100].includes(Number(search.pageSize))
			? Number(search.pageSize)
			: 25,
		desc:
			search.desc === true || search.desc === 'true'
				? true
				: search.desc === false || search.desc === 'false'
					? false
					: undefined,
		sort: (['reads', 'recent', 'package'].includes(String(search.sort))
			? search.sort
			: 'name') as SkillsSearch['sort'],
		package: typeof search.package === 'string' ? search.package : '',
		activity: (search.activity === 'read' || search.activity === 'unread'
			? search.activity
			: 'all') as SkillsSearch['activity'],
		q: typeof search.q === 'string' ? search.q : '',
		view: search.view === 'packages' ? ('packages' as const) : ('all' as const),
		skill: typeof search.skill === 'string' ? search.skill : undefined,
		file: typeof search.file === 'string' ? search.file : undefined,
	}),
	search: {
		middlewares: [
			stripSearchParams({
				q: '',
				page: 1,
				pageSize: 25,
				view: 'all',
				sort: 'name',
				package: '',
				activity: 'all',
			}),
		],
	},
	loaderDeps: ({ search }) => ({ skill: search.skill, file: search.file }),
	beforeLoad: ({ params, search }) => ({
		pageQueryInput: {
			orgSlug: params.orgSlug,
			skill: search.skill,
			file: search.file,
		},
	}),
	shouldReload: ({ context }) => !context.inPlaceNavigation,
	loader: ({ context, preload }) =>
		loadPageQuery(
			context.queryClient,
			pageQuery(context.actorKey, context.pageQueryInput),
			preload,
		),
	head: () => ({ meta: [{ title: 'Skills' }] }),
	component: Page,
})

function Page() {
	const { actorKey, pageQueryInput, pageLocation } = Route.useRouteContext()
	const { data } = usePageQuery(pageQuery(actorKey, pageQueryInput))
	const search = Route.useSearch()
	const navigate = Route.useNavigate()
	return (
		<SkillsPage
			data={data}
			search={search}
			currentHref={pageLocation.href}
			onFilter={(patch) =>
				void navigate({
					search: (previous) => ({ ...previous, ...patch }),
					replace: true,
					resetScroll: false,
				})
			}
			onSearch={(q) =>
				void navigate({
					search: (previous) => ({ ...previous, q, page: 1 }),
					replace: true,
					resetScroll: false,
				})
			}
		/>
	)
}
