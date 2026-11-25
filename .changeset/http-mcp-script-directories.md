---
"e2e": patch
---

`save_test_script` creates missing parent directories under the test root, so a gateway client can save `tests/<project>/<module>/<scenario>.e2e.ts` in one call.
