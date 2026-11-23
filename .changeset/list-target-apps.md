---
"e2e": patch
---

`list_test_scripts` now returns `targets`, every configured target as `{ name, url }` (`url` omitted for a target without an app address), and `e2e list --reporter json` returns the selected targets the same way. `list` from `e2e/runner` gains `ListResult.targetApps` for the same data. A caller can pick a target by the page address it covers; credentials never appear in it.
