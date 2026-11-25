---
"e2e": patch
---

Keep a job's artifacts for `e2e mcp --http` and serve them: before a finished run's output is removed, the gateway copies the files its report names (screenshots, videos, downloads, and logs) into `.e2e/http-jobs/artifacts/<jobId>/`, and the new `list_test_artifacts` tool returns their kinds, sizes, redaction, and an authenticated download URL. Files are kept with the job record for 14 days, at most 256 MiB each and 1 GiB per job.
