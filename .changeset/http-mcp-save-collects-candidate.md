---
"e2e": patch
---

`save_test_script` collects the candidate before replacing the file: a script that does not collect is refused with `COLLECTION_ERROR` naming the file, and the existing file stays. Saves and collections take turns, so one bad save can no longer fail every later `list_test_scripts` for the project.
