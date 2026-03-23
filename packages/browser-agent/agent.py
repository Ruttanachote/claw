#!/usr/bin/env python3
"""
IKAI Browser Sub-Agent — powered by browser-use
================================================
Called by IKAI as a subprocess for complex browser automation tasks.

Usage:
  python agent.py '<task JSON>'

The task JSON is:
  {
    "task": "Go to github.com and find the top trending repo",
    "max_steps": 20        # optional, default 20
  }

Environment variables (injected by IKAI):
  IKAI_API_KEY          — LLM API key
  IKAI_BASE_URL         — LLM base URL (e.g. https://openrouter.ai/api/v1)
  IKAI_MODEL            — LLM model name (e.g. anthropic/claude-sonnet-4-6)
  IKAI_SUB_AGENT_MODEL  — optional override model for sub-agent
  BROWSER_AGENT_CDP_URL — optional, connect to an existing Chrome via CDP
                           (e.g. ws://localhost:9222 — for visible panel integration)

Install:
  pip install browser-use langchain-openai playwright
  playwright install chromium
"""

import asyncio
import sys
import json
import os


def _patch_provider(llm, provider: str):
    """browser-use checks llm.provider — patch it in if missing."""
    if not hasattr(llm, "provider"):
        try:
            object.__setattr__(llm, "provider", provider)
        except Exception:
            pass
    return llm


def build_llm():
    """Build the LLM client from IKAI environment variables."""
    api_key  = os.environ.get("IKAI_API_KEY", "")
    base_url = os.environ.get("IKAI_BASE_URL", "")
    model    = os.environ.get("IKAI_SUB_AGENT_MODEL") or os.environ.get("IKAI_MODEL", "")

    if not api_key:
        raise RuntimeError(
            "IKAI_API_KEY is not set. Make sure your API key is configured in claw.config.toml"
        )

    # Prefer OpenAI-compatible client for OpenRouter or any custom base_url
    if base_url and "openrouter" in base_url:
        from langchain_openai import ChatOpenAI  # type: ignore
        llm = ChatOpenAI(
            model=model or "anthropic/claude-haiku-4-5-20251001",
            openai_api_key=api_key,
            openai_api_base=base_url,
            default_headers={
                "HTTP-Referer": "https://ikai.app",
                "X-Title": "IKAI Browser Agent",
            },
            timeout=120,
        )
        return _patch_provider(llm, "openai")

    # Direct Anthropic
    if not base_url or "anthropic.com" in base_url:
        from langchain_anthropic import ChatAnthropic  # type: ignore
        llm = ChatAnthropic(
            model=model or "claude-haiku-4-5-20251001",
            api_key=api_key,
            timeout=120,
            stop=None,
        )
        return _patch_provider(llm, "anthropic")

    # Generic OpenAI-compatible (LiteLLM proxy, Ollama, etc.)
    from langchain_openai import ChatOpenAI  # type: ignore
    llm = ChatOpenAI(
        model=model,
        openai_api_key=api_key,
        openai_api_base=base_url,
        timeout=120,
    )
    return _patch_provider(llm, "openai")


async def run_browser_agent(task: str, max_steps: int = 20) -> str:
    try:
        from browser_use import Agent  # type: ignore
    except ImportError:
        raise RuntimeError(
            "browser-use is not installed.\n"
            "Run: pip install browser-use langchain-openai playwright && playwright install chromium"
        )

    llm      = build_llm()
    cdp_url  = os.environ.get("BROWSER_AGENT_CDP_URL", "")

    agent_kwargs: dict = {"task": task, "llm": llm, "max_steps": max_steps}

    # If CDP URL is provided, connect to the visible panel browser
    if cdp_url:
        try:
            from browser_use.browser.browser import Browser, BrowserConfig  # type: ignore
            browser = Browser(config=BrowserConfig(cdp_url=cdp_url))
            agent_kwargs["browser"] = browser
        except Exception:
            pass  # fall back to standalone browser

    agent  = Agent(**agent_kwargs)
    result = await agent.run()

    # Extract final result — API varies slightly across browser-use versions
    if hasattr(result, "final_result"):
        final = result.final_result()
    elif hasattr(result, "history") and result.history:
        final = str(result.history[-1])
    else:
        final = str(result)

    return final or "(browser-use returned no result)"


async def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: agent.py '<task JSON>'"}))
        sys.exit(1)

    raw = sys.argv[1]
    try:
        payload = json.loads(raw)
        task      = str(payload.get("task", ""))
        max_steps = int(payload.get("max_steps", 20))
    except (json.JSONDecodeError, ValueError):
        # Fallback: treat argument as plain string task
        task      = raw
        max_steps = 20

    if not task:
        print(json.dumps({"error": "task is empty"}))
        sys.exit(1)

    try:
        result = await run_browser_agent(task, max_steps)
        print(json.dumps({"result": result}))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
