import type { SkillDefinition } from "@claw/skill-runner";
import { buildSkillsCatalogue } from "@claw/skill-runner";
import type { ToolDefinition } from "./types.js";
import os from "os";

export interface SystemPromptContext {
  homeDir: string;
  platform: string;
  username: string;
  shellBin?: string;
}

// ── System prompt ─────────────────────────────────────────────
export function buildSystemPrompt(
  skills: SkillDefinition[],
  ctx?: Partial<SystemPromptContext>
): string {
  const catalogue = buildSkillsCatalogue(skills);
  const homeDir  = ctx?.homeDir  ?? os.homedir();
  const platform = ctx?.platform ?? process.platform;
  const username = ctx?.username ?? os.userInfo().username;

  // Platform-specific shell details
  const isWin    = platform === "win32";
  const pathSep  = isWin ? "\\" : "/";
  // shellBin can be injected from tools (source of truth) or derived from platform
  const shellBin = ctx?.shellBin ?? (isWin ? "powershell.exe" : "/bin/sh");
  const shellHint = isWin
    ? `Shell: powershell.exe
  - Use PowerShell syntax for ALL shell commands
  - Common aliases that work: ls, cd, cat, pwd, mkdir, rm, cp, mv, echo
  - Example: ls ${homeDir}\\Desktop
  - Example: cat ${homeDir}\\Documents\\notes.txt
  - Example: Get-Process | Select-Object Name, CPU
  - Paths use backslashes: C:\\Users\\${username}\\`
    : `Shell: /bin/sh (bash compatible)
  - Use standard Unix/bash syntax
  - Example: ls -la ${homeDir}/Desktop
  - Example: cat ${homeDir}/Documents/notes.txt
  - Example: find ${homeDir} -name "*.pdf" -type f
  - Paths use forward slashes: /home/${username}/`;

  return `You are IKAI, a personal AI agent running as a desktop app on the user's machine.
You are precise, efficient, and always verify your work before answering.

## Environment
- **Home directory**: ${homeDir}
- **OS**: ${platform}
- **Username**: ${username}
- **Path separator**: ${pathSep}
- **Shell binary**: ${shellBin}
${shellHint}

## IMPORTANT — File access rules
- Always use ABSOLUTE paths for all file and shell operations.
- Relative paths resolve relative to the home directory: ${homeDir}
- Use "${homeDir}" as the base when constructing paths.
- The tilde shorthand "~" is also supported and expands to: ${homeDir}
- To see what's on the user's machine, start with: list_dir("~") or list_dir("${homeDir}")
- Never say you cannot access the filesystem — you have full read/write access.
- The shell tool runs commands via ${shellBin} — always use ${isWin ? "PowerShell" : "bash/sh"} syntax.

## Your capabilities
- **browser_agent**: Your ONLY browser tool. Delegates web tasks to an autonomous browser-use sub-agent that controls the visible panel in real-time (user sees every action). Describe the task in natural language — the sub-agent navigates, clicks, fills forms, scrolls, and extracts data on its own. Use this for ALL web tasks: searching, reading pages, filling forms, extracting data, etc.
- **shell**: Run any terminal command on the user's machine via ${shellBin} (cwd defaults to ${homeDir})
- **read_file**: Read a file from the filesystem (supports ~, absolute and relative paths)
- **write_file**: Write / create a file on the filesystem
- **list_dir**: List directory contents (default: lists home directory)
- **memory_read**: Read a value from your long-term key-value memory (persists across sessions)
- **memory_write**: Write a value to your long-term key-value memory
- **run_skill**: Execute a named skill from the skill library
- **schedule_cron**: Schedule a skill to run on a recurring cron schedule

## Available skills
${catalogue}

## Rules
1. Think step by step before acting. Decompose the user's request into clear sub-tasks.
2. Use tools when needed — don't guess content you could fetch or verify.
3. For any file/directory task, use shell or file tools — ALWAYS use absolute paths starting with "${homeDir}".
4. After each tool call, evaluate the result before deciding the next step.
5. If a tool returns an error, include the EXACT error text in your reply and try a different approach (max 2 retries per step).
6. Use memory_write to persist facts you'll need later (user preferences, project info, etc.).
7. When you have a final answer, respond in plain language without tool calls.
8. Be concise but complete.
9. If you cannot complete the task, explain exactly WHY with the specific error — never a vague excuse.

## CRITICAL — Error handling behavior
- NEVER say "ลอง restart app" or tell the user to restart anything.
- NEVER apologize ("ขอโทษ", "sorry", "I apologize") when a tool fails — just report the error and try again.
- NEVER say you "cannot access" the filesystem — you have full access via the shell and file tools.
- If a tool returns an error, quote the EXACT error message (e.g. "shell failed — exit code: 1 / 'ls' is not recognized...") so the user sees what happened.
- ALWAYS attempt at least one retry with a corrected approach before giving up.
- If all retries fail, output the raw error text so the user can diagnose it — not a paraphrase.

## Output format
- For simple answers: plain prose
- For lists / structured data: markdown
- For code: fenced code blocks with language tag
- Never expose raw tool call JSON in your final answer`.trim();
}

// ── Tool definitions (sent to LLM) ────────────────────────────
export function buildToolDefinitions(): ToolDefinition[] {
  return [
    // ── browser_agent ─────────────────────────────────────────
    {
      type: "function",
      function: {
        name: "browser_agent",
        description:
          "Delegate any browser task to a specialized browser-use sub-agent. " +
          "Describe the task in natural language — the sub-agent will autonomously navigate, click, " +
          "fill forms, scroll, and extract data to complete it. " +
          "Use for ALL web tasks: searching, reading pages, filling forms, multi-step workflows, " +
          "login flows, data extraction — anything that requires a browser.",
        parameters: {
          type: "object",
          properties: {
            task: {
              type: "string",
              description:
                "Natural language description of the browser task. Be specific. " +
                'Example: "Go to github.com/trending, find the top 5 repos today, return their names and star counts".',
            },
            max_steps: {
              type: "number",
              description: "Max browser steps allowed. Default 20, max 50.",
            },
          },
          required: ["task"],
        },
      },
    },
    // ── shell ─────────────────────────────────────────────────
    {
      type: "function",
      function: {
        name: "shell",
        description:
          "Execute a shell command on the user's machine. Returns stdout + stderr. " +
          "Use for: running scripts, git, npm, python, checking files, system info, anything CLI.",
        parameters: {
          type: "object",
          properties: {
            command:    { type: "string", description: "The shell command to run, e.g. 'ls -la' or 'git status'" },
            cwd:        { type: "string", description: `Working directory (absolute path). Defaults to the user's home directory: ${os.homedir()}.` },
            timeout_ms: { type: "number", description: "Timeout in milliseconds. Max 120000. Default 30000." },
          },
          required: ["command"],
        },
      },
    },
    // ── read_file ─────────────────────────────────────────────
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read the contents of a file from the filesystem.",
        parameters: {
          type: "object",
          properties: {
            path:      { type: "string", description: "Absolute or relative file path to read." },
            max_bytes: { type: "number", description: "Max bytes to read. Default 32768 (32KB). Max 131072." },
          },
          required: ["path"],
        },
      },
    },
    // ── write_file ────────────────────────────────────────────
    {
      type: "function",
      function: {
        name: "write_file",
        description: "Write content to a file. Creates parent directories if needed. Overwrites if exists.",
        parameters: {
          type: "object",
          properties: {
            path:    { type: "string", description: "Absolute or relative file path to write." },
            content: { type: "string", description: "Text content to write." },
          },
          required: ["path", "content"],
        },
      },
    },
    // ── list_dir ─────────────────────────────────────────────
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "List files and subdirectories in a directory.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path. Defaults to current directory." },
          },
          required: [],
        },
      },
    },
    // ── memory_read ───────────────────────────────────────────
    {
      type: "function",
      function: {
        name: "memory_read",
        description:
          "Read a value from your long-term key-value memory. " +
          "Use to recall facts that persist across sessions (user prefs, project context, etc.).",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: 'The memory key, e.g. "user.name" or "project.current".' },
          },
          required: ["key"],
        },
      },
    },
    // ── memory_write ──────────────────────────────────────────
    {
      type: "function",
      function: {
        name: "memory_write",
        description:
          "Write a value to your long-term key-value memory. " +
          "Use to save facts, preferences, or context you want to remember in future sessions.",
        parameters: {
          type: "object",
          properties: {
            key:   { type: "string", description: 'The memory key, e.g. "user.name".' },
            value: { type: "string", description: "The value to store." },
          },
          required: ["key", "value"],
        },
      },
    },
    // ── run_skill ─────────────────────────────────────────────
    {
      type: "function",
      function: {
        name: "run_skill",
        description: "Execute a named skill from the skills library.",
        parameters: {
          type: "object",
          properties: {
            skill_name: { type: "string", description: "Exact skill name, e.g. 'web-search'" },
            inputs:     { type: "string", description: 'JSON object of inputs, e.g. {"query":"..."}' },
          },
          required: ["skill_name", "inputs"],
        },
      },
    },
    // ── schedule_cron ─────────────────────────────────────────
    {
      type: "function",
      function: {
        name: "schedule_cron",
        description: "Schedule a skill to run automatically on a recurring cron schedule.",
        parameters: {
          type: "object",
          properties: {
            name:       { type: "string", description: "Short unique job name" },
            expression: { type: "string", description: "Cron expression e.g. '0 8 * * *'" },
            skill_name: { type: "string", description: "Skill to run on schedule" },
            inputs:     { type: "string", description: "JSON inputs for the skill" },
          },
          required: ["name", "expression", "skill_name", "inputs"],
        },
      },
    },
  ];
}
