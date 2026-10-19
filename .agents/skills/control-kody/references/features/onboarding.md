# Onboarding

## Seed / reach

After local signup or a user that has not finished onboarding:

```bash
npm run control-kody -- login
npm run control-kody -- request GET /onboarding --contains 'Onboarding'
```

## Assert

- `/onboarding`, `/onboarding/step-1`, `/onboarding/step-2`,
  `/onboarding/step-3`
- Agent/service variants: `/onboarding/step-1/$agent`,
  `/onboarding/step-2/$service`, `/onboarding/step-3/$agent`
