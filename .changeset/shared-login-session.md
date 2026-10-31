---
"e2e": patch
---

Add a shared login to a target: `session: { account, login, check }` keeps one sign-in per account and site in `.e2e/sessions/shared/`, encrypted, and restores it before each test. Workers check in parallel and only a sign-in is serialized, so a test that meets a signed-out session signs in once and every other test reuses it, across runs. A failing `login` or `check` stops the run with `SESSION_LOGIN_FAILED` or `SESSION_CHECK_FAILED` instead of failing every test. Setup tests, tests naming a `session`, and tests with `sharedSession: false` keep their own sign-in.
