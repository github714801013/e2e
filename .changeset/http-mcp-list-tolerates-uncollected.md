---
"e2e": patch
---

`list_test_scripts` no longer fails when a test file cannot be collected: the file is named under a new `uncollected` result field and the rest of the list is returned. `e2e list` gains `--allow-uncollected`, and `list` from `e2e/runner` gains `allowUncollected` and `ListResult.uncollected`, for the same behavior.
