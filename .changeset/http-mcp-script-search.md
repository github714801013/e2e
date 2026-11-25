---
"e2e": patch
---

`list_test_scripts` now searches instead of enumerating: `keyword` is required, a text scan picks the files whose source contains it, only the best 100 candidates plus any file that may declare a setup test are collected, and the results are ordered by BM25 relevance over path, test titles, and tags. `e2e list` gains `--imports-named`, which imports only the files the positionals or `--prefix` select instead of every discovered file. A search that matches nothing starts no collection, and `total`/`truncated` describe the scan matches. A `prefix` that resolves outside the test root is `POLICY_DENIED`. Script tool results are compact JSON, `uncollected[].reason` is capped at 8 KiB, and the collection child's deadline is 60 seconds.
