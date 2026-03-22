---
name: browser-screenshot
version: 1.0.0
trigger: ["screenshot", "capture", "snap", "screengrab"]
description: Opens a browser, navigates to a URL, and takes a full-page screenshot
inputs:
  - name: url
    type: url
    required: true
    description: The page URL to screenshot
  - name: full_page
    type: boolean
    required: false
    description: Capture full scrollable page (default true)
tools:
  - browser
---

## Steps
1. Open managed browser instance
2. Navigate to {url}
3. Wait for page load (networkidle2)
4. Capture full-page screenshot (full_page={full_page})
5. Return base64 PNG image + page title + final URL
