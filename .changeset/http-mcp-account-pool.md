---
"e2e": patch
---

HTTP MCP mode can serve an account pool. With `E2E_HTTP_MCP_ACCOUNTS_DIR` and `E2E_TARGETS_BASE_FILE` set, an account is one target plus a description, `run_test` and `open_session` take `accountDescription` instead of a target, `list_test_scripts` lists pooled accounts beside configured targets, and each account keeps its own shared login. Passwords stay in the pool's `secrets.env` and the child environment, never in the generated runtime targets file, a response, or a log. `E2E_HTTP_MCP_ADMIN_TOKEN` (at least 32 characters) unlocks `/admin` and `/admin/api/accounts` for adding and maintaining accounts. A shared login saved before this release is signed in once more, since the state's key now includes the target name.
