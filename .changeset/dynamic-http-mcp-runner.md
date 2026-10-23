---
"e2e": patch
---

Add `runDynamic` to `e2e/runner`: submit test files to one live run, reuse the authentication snapshots it established, and start workers on demand. Sealing drains the queue and produces one complete report, with repeat submissions kept as independent results.
