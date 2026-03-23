# IKAI Browser Sub-Agent

Powers IKAI's `browser_agent` tool — delegates complex multi-step browser tasks
to a `browser-use` agent that autonomously navigates, clicks, fills forms, and
extracts information.

## One-time setup

```bash
pip install browser-use langchain-openai playwright
playwright install chromium
```

Then copy (or symlink) this directory to `~/.claw/browser-agent/`:

```bash
mkdir -p ~/.claw/browser-agent
cp packages/browser-agent/agent.py ~/.claw/browser-agent/
```

## Usage (called automatically by IKAI)

```bash
IKAI_API_KEY=sk-...  IKAI_BASE_URL=https://openrouter.ai/api/v1  IKAI_MODEL=anthropic/claude-haiku-4-5-20251001  python ~/.claw/browser-agent/agent.py '{"task": "Go to news.ycombinator.com and return the top 5 story titles"}'
```

## Connecting to the IKAI visible panel (advanced)

To make browser-use control the same browser the user sees, set:

```
BROWSER_AGENT_CDP_URL=ws://localhost:9222
```

And enable remote debugging in `app/main/src/window.ts`:

```typescript
app.commandLine.appendSwitch("remote-debugging-port", "9222");
```
