---
"e2e": patch
---

`e2e mcp` marks secrets whose names start with `<target>.` as belonging to that target in a session's opening text, so a client with several targets configured picks the right secret with `type_secret`.
