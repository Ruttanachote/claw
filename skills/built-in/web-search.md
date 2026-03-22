---
name: web-search
version: 1.0.0
trigger: ["search", "google", "look up", "find", "lookup", "browse"]
description: Searches the web and returns a summary of top results
inputs:
  - name: query
    type: string
    required: true
    description: The search query
  - name: num_results
    type: number
    required: false
    description: Number of results to return (default 5)
tools:
  - browser
---

## Steps
1. Open managed browser instance
2. Navigate to https://www.google.com/search?q={query}
3. Wait for results page load
4. Extract top {num_results} result titles, snippets, and URLs
5. Return structured list of results
