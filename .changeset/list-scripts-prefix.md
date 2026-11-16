---
"e2e": patch
---

Make `e2e list --prefix <prefix>` narrow collection to the files under the prefix, so a test file outside it that cannot be imported no longer fails `list_test_scripts`. `ListOptions.prefix` exposes the same narrowing to `list()` from `e2e/runner`.
