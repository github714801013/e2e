---
"e2e": patch
---

An `initialize` request that carries a session id the HTTP gateway no longer knows reopens a session under that same id, so a client that lost its session to a gateway restart keeps the handle it holds; any other request with an unknown id is still `404`.
