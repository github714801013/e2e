---
"e2e": patch
---

`app.url` accepts plain HTTP on private network hosts (RFC 1918 IPv4 and IPv6 unique local addresses), in addition to loopback, so a test can drive a mock server on another host in the same internal network. Public hosts still require HTTPS.
