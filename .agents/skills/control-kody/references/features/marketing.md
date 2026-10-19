# Public marketing pages

## Seed / reach

No login required.

```bash
npm run control-kody -- request GET / --skip-login --contains 'Kody'
npm run control-kody -- request GET /pricing --skip-login --contains 'Pricing'
npm run control-kody -- request GET /docs --skip-login
npm run control-kody -- health --origin https://kody.codes
```

## Assert

- Core: `/`, `/pricing`, `/docs`, `/docs/$slug`, `/blog`, `/support`, `/about`,
  `/contact`, `/privacy`, `/terms`, `/faq`, `/discord`
- Feeds: `/llms.txt`, `/sitemap.xml`, `/robots.txt`, `/guides.json`
- Compare / use-cases / features pages under `/compare`, `/use-cases`,
  `/features`, `/for`, `/with`
