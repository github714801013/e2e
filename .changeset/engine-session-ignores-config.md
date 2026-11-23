---
"e2e": patch
---

`open_session` accepts `engine` in a directory that has an `e2e.config.ts`: the session opens on that engine, with the `app` the call names, and does not read the config file. A client can drive an app URL the server does not have a config for, such as a mock server on the caller's machine, while the session still has no credentials, secrets, project tools, or tests.
