import { marked, Renderer } from "marked";
import DOMPurify from "dompurify";
import mermaid from "mermaid";

// ── Type augmentation ──────────────────────────────────────────
declare global {
  interface Window { clawAPI: import("../../main/src/preload.js").ClawAPI; }
}

// ── File icons map (shared) ────────────────────────────────────
const FILE_ICONS: Record<string, string> = {
  py: "🐍", js: "📜", ts: "📘", html: "🌐", htm: "🌐",
  css: "🎨", md: "📝", txt: "📄", json: "📋", yaml: "📋",
  yml: "📋", toml: "📋", png: "🖼️", jpg: "🖼️", jpeg: "🖼️",
  gif: "🖼️", webp: "🖼️", svg: "🎨", csv: "📊", pdf: "📕",
  sh: "💻", bash: "💻", zsh: "💻", go: "🔵", rs: "🦀",
  zip: "📦", tar: "📦", gz: "📦", exe: "⚙️", bin: "⚙️",
};

// ── Mermaid init ───────────────────────────────────────────────
mermaid.initialize({
  startOnLoad: false,
  theme: "dark",
  darkMode: true,
  themeVariables: {
    primaryColor:    "#f97316",
    primaryTextColor:"#f0e8d8",
    primaryBorderColor: "#3d2e16",
    lineColor:       "#9e8a6a",
    secondaryColor:  "#251c0e",
    tertiaryColor:   "#1c150a",
    background:      "#141008",
    mainBkg:         "#1c150a",
    nodeBorder:      "#3d2e16",
    clusterBkg:      "#251c0e",
    titleColor:      "#f0e8d8",
    edgeLabelBackground: "#141008",
    fontFamily:      "ui-monospace, SFMono-Regular, monospace",
  },
  securityLevel: "loose",
});

// ══ Artifact System ════════════════════════════════════════════
// Artifacts (mermaid/html/svg) are NOT rendered inline.
// They appear as cards in chat → clicking opens the Artifact Panel (right side).
// Files from write_file also use the same card + panel pattern.

type ArtifactKind = "mermaid" | "html" | "svg" | "file";

interface ArtifactData {
  kind:      ArtifactKind;
  title:     string;
  icon:      string;
  content:   string;       // source code / text content
  lang?:     string;
  filePath?: string;       // for "file" kind
}

let artifactCounter = 0;
const artifactStore = new Map<string, ArtifactData>();

// During streaming: true = show compact plain-code placeholders (no cards yet)
// Cards are generated in the final appendMsg render after streaming ends.
let artifactStreamingMode = false;

// ── Custom marked renderer ─────────────────────────────────────
const SYNTAX_LANGS = new Set([
  "js","javascript","ts","typescript","python","py","bash","sh","zsh",
  "css","json","yaml","yml","toml","go","rust","rs","sql","xml",
  "c","cpp","java","kotlin","swift","ruby","php",
]);

function buildCustomRenderer(): Renderer {
  const renderer = new Renderer();

  renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
    const l = (lang ?? "").toLowerCase().trim();

    // ── Artifact types: show streaming placeholder during stream ──
    const isArtifactLang = l === "mermaid" || l === "svg" || l === "html" || l === "htm";
    if (artifactStreamingMode && isArtifactLang) {
      const label = l === "mermaid" ? "🧜 mermaid" : l === "svg" ? "🎨 svg" : "🌐 html";
      return `<div class="artifact-streaming-placeholder">
        <span class="artifact-stream-label">${label}</span>
        <pre class="artifact-stream-pre"><code>${esc(text)}</code></pre>
      </div>`;
    }

    // ── Artifact card (final render only) ────────────────────
    if (isArtifactLang) {
      const id    = `art-${++artifactCounter}`;
      const kind: ArtifactKind = l === "mermaid" ? "mermaid" : l === "svg" ? "svg" : "html";
      const meta  = {
        mermaid: { icon: "🧜", title: "Diagram"     },
        svg:     { icon: "🎨", title: "SVG Graphic" },
        html:    { icon: "🌐", title: "HTML"        },
      }[kind];
      const preview = text.trim().split("\n")[0].slice(0, 60);
      artifactStore.set(id, { kind, title: meta.title, icon: meta.icon, content: text, lang: l });
      return `<div class="artifact-card" data-artifact-id="${id}">
        <div class="artifact-card-icon">${meta.icon}</div>
        <div class="artifact-card-info">
          <span class="artifact-card-title">${esc(meta.title)}</span>
          <span class="artifact-card-preview">${esc(preview)}</span>
        </div>
        <button class="artifact-card-open" data-artifact-id="${id}">Open →</button>
      </div>`;
    }

    // ── Regular code block (stays inline) ────────────────────
    const langLabel = l && SYNTAX_LANGS.has(l) ? l : (l || "text");
    return `<div class="inline-code-block">
      <div class="icb-header">
        <span class="icb-lang">${esc(langLabel)}</span>
        <button class="btn-copy-code" data-copy="${esc(text)}" title="Copy">⎘ Copy</button>
      </div>
      <pre class="icb-pre"><code>${esc(text)}</code></pre>
    </div>`;
  };

  renderer.image = ({ href, text, title }: { href: string; text: string; title?: string | null }) => {
    if (!href) return `<span class="img-error">⚠ Missing image src</span>`;
    let src = href;
    if (/^\//.test(href) || /^[A-Za-z]:[/\\]/.test(href)) {
      src = "file://" + href.replace(/\\/g, "/");
    }
    return `<figure class="chat-figure">
      <img
        src="${esc(src)}"
        alt="${esc(text ?? "")}"
        ${title ? `title="${esc(title)}"` : ""}
        class="chat-img"
        loading="lazy"
        onerror="this.closest('figure').innerHTML='<span class=\\'img-error\\'>⚠ Image not found</span>'"
      />
      ${title ? `<figcaption>${esc(title)}</figcaption>` : ""}
    </figure>`;
  };

  return renderer;
}

marked.use({ renderer: buildCustomRenderer() });

// ── Markdown renderer ──────────────────────────────────────────
function renderMd(text: string): string {
  return DOMPurify.sanitize(marked.parse(text) as string, {
    ADD_TAGS: ["figure", "figcaption"],
    ADD_ATTR: ["loading", "onerror", "data-artifact-id", "data-copy", "data-path"],
  });
}

// ── File utilities ─────────────────────────────────────────────
function fileExt(p: string): string { return (p.split(".").at(-1) ?? "").toLowerCase(); }

function shortFilePath(p: string): string {
  return p.replace(/^\/home\/[^/]+/, "~").replace(/^\/Users\/[^/]+/, "~")
          .replace(/^C:\\Users\\[^\\]+/, "~");
}

// ── File card (from write_file tool) ──────────────────────────
function buildFileCardHtml(filePath: string): string {
  const fileName = filePath.split(/[/\\]/).at(-1) ?? filePath;
  const ext      = fileExt(filePath);
  const icon     = FILE_ICONS[ext] ?? "📄";
  return `<div class="artifact-card file-card" data-file-path="${esc(filePath)}">
    <div class="artifact-card-icon">${icon}</div>
    <div class="artifact-card-info">
      <span class="artifact-card-title">${esc(fileName)}</span>
      <span class="artifact-card-preview">${esc(shortFilePath(filePath))}</span>
    </div>
    <div class="artifact-card-actions">
      <button class="artifact-card-open" data-file-path="${esc(filePath)}">Open →</button>
      <button class="btn-file-sys" data-file-path="${esc(filePath)}" title="Open in system">📂</button>
    </div>
  </div>`;
}

function injectFileCard(filePath: string): void {
  const c = document.getElementById("chat-messages");
  if (!c) return;
  const wrapper = document.createElement("div");
  wrapper.className = "msg msg-artifact-card";
  wrapper.innerHTML = buildFileCardHtml(filePath);
  c.appendChild(wrapper);
  c.scrollTop = c.scrollHeight;
}

// ── App state ──────────────────────────────────────────────────
type Panel = "dashboard" | "sessions" | "memory" | "agent"
           | "skills" | "cron" | "terminal" | "logs" | "config";

let currentPanel: Panel = "dashboard";
let currentSessionId = "";
let isRunning = false;
let streamingContent = "";
let stopOnProgress: (() => void) | null = null;
let stopOnToken:    (() => void) | null = null;
let logFilter = "";   // "" = all

// ── DOM helpers ────────────────────────────────────────────────
const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel);
const $$ = <T extends HTMLElement>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T>(sel));

// ── Panel switching ────────────────────────────────────────────
const PANEL_TITLES: Record<Panel, string> = {
  dashboard: "Dashboard",
  sessions:  "Sessions",
  memory:    "Memory",
  agent:     "Main Agent",
  skills:    "Skills",
  cron:      "Cron Jobs",
  terminal:  "Terminal",
  logs:      "Logs",
  config:    "Config",
};

function switchPanel(id: Panel): void {
  currentPanel = id;

  // Update nav active state
  $$<HTMLElement>(".nav-item[data-panel]").forEach(el =>
    el.classList.toggle("active", el.dataset["panel"] === id)
  );

  // Show/hide panels
  $$<HTMLElement>(".panel").forEach(el => { el.style.display = "none"; });
  const target = $<HTMLElement>(`#panel-${id}`);
  if (target) target.style.display = "flex";

  // Update topbar title
  const titleEl = $<HTMLElement>("#topbar-title");
  if (titleEl) titleEl.textContent = PANEL_TITLES[id] ?? id;

  // Load data for the panel
  switch (id) {
    case "dashboard":  void loadDashboard();    break;
    case "sessions":   void loadSessionsList(); break;
    case "memory":     void loadMemoryPanel();  break;
    case "agent":      void loadAgentPanel();   break;
    case "skills":     void loadSkillsPanel();  break;
    case "cron":       void loadCronPanel();    break;
    case "terminal":   void loadTerminalPanel(); break;
    case "logs":       void loadLogsPanel();     break;
    case "config":     void loadConfigPanel();   break;
  }
}

// ══ Dashboard ══════════════════════════════════════════════════
async function loadDashboard(): Promise<void> {
  const [statsR, memR] = await Promise.all([
    window.clawAPI.getStats(),
    window.clawAPI.listMemories(),
  ]);

  if (statsR.ok && statsR.data) {
    const s = statsR.data as {
      totalSessions: number; totalMessages: number;
      totalToolCalls: number; topTools: Array<{ name: string; count: number }>;
    };
    setText("stat-sessions-val", s.totalSessions.toLocaleString());
    setText("stat-messages-val",  s.totalMessages.toLocaleString());
    setText("stat-tools-val",     s.totalToolCalls.toLocaleString());

    const bars = $<HTMLElement>("#tool-bars");
    if (bars && s.topTools.length) {
      const max = s.topTools[0]?.count ?? 1;
      bars.innerHTML = s.topTools.slice(0, 6).map(t => `
        <div class="tool-bar-row">
          <span class="tool-bar-name">${esc(t.name)}</span>
          <div class="tool-bar-track">
            <div class="tool-bar-fill" style="width:${Math.round(t.count / max * 100)}%"></div>
          </div>
          <span class="tool-bar-count">${t.count}</span>
        </div>`).join("");
    }
  }

  if (memR.ok && memR.data) {
    const mems = memR.data as unknown[];
    setText("stat-mem-val", mems.length.toLocaleString());
  }
}

// ══ Sessions / Chat ════════════════════════════════════════════
async function loadSessionsList(): Promise<void> {
  const r = await window.clawAPI.listSessions();
  const list = $<HTMLElement>("#session-list");
  if (!list) return;

  if (!r.ok || !(r.data as unknown[])?.length) {
    list.innerHTML = `<div class="list-empty">No sessions yet</div>`;
    // Show empty chat state
    showChatEmpty(true);
    return;
  }

  const sessions = r.data as Array<{ id: string; createdAt: number; updatedAt: number }>;

  list.innerHTML = sessions.map((s, i) => `
    <div class="session-row${i === 0 ? " active" : ""}" data-session-id="${esc(s.id)}">
      <div class="session-row-top">
        <span class="session-row-id">${esc(s.id.slice(0, 16))}</span>
        <button class="session-row-del" data-del-id="${esc(s.id)}">✕</button>
      </div>
      <div class="session-row-preview" data-preview="${esc(s.id)}">…</div>
      <div class="session-row-time">${timeAgo(s.updatedAt)}</div>
    </div>`).join("");

  // Load first session
  if (sessions[0]) void loadChat(sessions[0].id);

  // Lazy-load preview snippets
  for (const s of sessions.slice(0, 15)) {
    window.clawAPI.listMessages(s.id).then(mr => {
      if (!mr.ok || !mr.data) return;
      const msgs = mr.data as Array<{ role: string; content: string }>;
      const last = msgs.filter(m => m.role === "user").at(-1);
      const el = $<HTMLElement>(`[data-preview="${s.id}"]`);
      if (el) el.textContent = last ? last.content.slice(0, 60) : "(empty)";
    }).catch(() => undefined);
  }

  // Session click
  $$<HTMLElement>(".session-row").forEach(row => {
    row.addEventListener("click", e => {
      if ((e.target as HTMLElement).classList.contains("session-row-del")) return;
      $$(".session-row").forEach(r2 => r2.classList.remove("active"));
      row.classList.add("active");
      const sid = row.dataset["sessionId"] ?? "";
      if (sid) void loadChat(sid);
    });
  });

  // Delete buttons
  $$<HTMLButtonElement>(".session-row-del").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      const id = btn.dataset["delId"] ?? "";
      await window.clawAPI.deleteSession(id);
      void loadSessionsList();
    });
  });
}

async function loadChat(sessionId: string): Promise<void> {
  currentSessionId = sessionId;
  showChatEmpty(false);

  const r = await window.clawAPI.listMessages(sessionId);
  if (!r.ok || !r.data) return;
  const msgs = r.data as Array<{ role: string; content: string }>;
  const container = $<HTMLElement>("#chat-messages");
  if (!container) return;
  container.innerHTML = msgs
    .filter(m => m.role !== "tool")
    .map(m => buildMsgHtml(m.role, m.content)).join("");
  container.scrollTop = container.scrollHeight;
}

function showChatEmpty(empty: boolean): void {
  const emptyEl = $<HTMLElement>("#chat-empty");
  const bodyEl  = $<HTMLElement>("#chat-body");
  if (emptyEl) emptyEl.style.display = empty ? "flex" : "none";
  if (bodyEl)  bodyEl.style.display  = empty ? "none" : "flex";
}

function buildMsgHtml(role: string, content: string): string {
  const isUser = role === "user";
  const html   = isUser ? `<p>${esc(content)}</p>` : renderMd(content);
  return `
    <div class="msg msg-${esc(role)}">
      <div class="msg-header">
        <span class="msg-role">${isUser ? "You" : "IKAI"}</span>
        <button class="btn-copy" title="Copy" onclick="navigator.clipboard.writeText(this.closest('.msg')?.querySelector('.msg-content')?.textContent??'')">⎘</button>
      </div>
      <div class="msg-content markdown-body">${html}</div>
    </div>`;
}

function appendMsg(role: string, content: string): void {
  const c = $<HTMLElement>("#chat-messages");
  if (!c) return;
  c.insertAdjacentHTML("beforeend", buildMsgHtml(role, content));
  c.scrollTop = c.scrollHeight;
}

// ══ Send message ═══════════════════════════════════════════════
async function sendMessage(): Promise<void> {
  const input = $<HTMLTextAreaElement>("#chat-input");
  if (!input) return;
  const text = input.value.trim();
  if (!text || isRunning) return;

  input.value = "";
  input.style.height = "auto";

  // Ensure we have a session
  if (!currentSessionId) {
    const sr = await window.clawAPI.newSession();
    if (!sr.ok || !sr.data) return;
    currentSessionId = (sr.data as { id: string }).id;
    showChatEmpty(false);
  }

  appendMsg("user", text);
  setRunning(true);
  streamingContent = "";
  artifactStreamingMode = true;  // show streaming placeholders instead of cards

  // Streaming placeholder bubble
  const container = $<HTMLElement>("#chat-messages");
  const ph = document.createElement("div");
  ph.id = "stream-ph";
  ph.className = "msg msg-assistant";
  ph.innerHTML = `
    <div class="msg-header"><span class="msg-role">IKAI</span></div>
    <div class="msg-content markdown-body">
      <span id="stream-text"></span><span class="cursor"></span>
    </div>`;
  container?.appendChild(ph);
  if (container) container.scrollTop = container.scrollHeight;

  stopOnToken = window.clawAPI.onToken(token => {
    streamingContent += token;
    const st = $<HTMLElement>("#stream-text");
    if (st) st.innerHTML = renderMd(streamingContent);  // uses streaming placeholders
    if (container) container.scrollTop = container.scrollHeight;
    // ↑ No flushMermaid() here — prevents flicker during streaming
  });

  stopOnProgress = window.clawAPI.onProgress(({ step, message }) => {
    // ── Progress bar label ─────────────────────────────────────
    const stepEl = $<HTMLElement>("#progress-step");
    const msgEl  = $<HTMLElement>("#progress-msg");
    if (stepEl) stepEl.textContent =
      step === "tool_start" ? "TOOL" :
      step === "tool_end"   ? "TOOL" :
      step === "tool_chunk" ? "RUN"  :
      step.toUpperCase();
    if (msgEl && step !== "tool_start" && step !== "tool_end" && step !== "tool_chunk") {
      msgEl.textContent = message;
    }

    // ── tool_chunk: append stdout/stderr chunk in real-time ────
    if (step === "tool_chunk") {
      try {
        const d = JSON.parse(message) as { id: string; chunk: string };
        termChunk(`a${d.id}`, d.chunk);
      } catch { /* ignore */ }
      return;
    }

    // ── tool_start: create collapsible block + feed terminal ──
    if (step === "tool_start") {
      try {
        const d = JSON.parse(message) as { id: string; name: string; preview: string };
        if (msgEl) msgEl.textContent = `${d.name}…`;

        // ── Auto-open terminal mini pane on first tool call ────
        const miniPane = $<HTMLElement>("#term-mini-pane");
        if (miniPane && miniPane.style.display === "none") {
          miniPane.style.display = "flex";
          $<HTMLButtonElement>("#btn-toggle-term")?.classList.add("active");
        }

        // ── Feed ALL tools to terminal (not just shell) ────────
        termFeedAgentStart(d.id, d.name, d.preview);

        // ── Collapsible block in chat ──────────────────────────
        const block = document.createElement("div");
        block.className = "tool-block";
        block.dataset["toolId"] = d.id;
        block.innerHTML = `
          <div class="tool-block-header">
            <span class="tool-block-status spinning"></span>
            <span class="tool-block-name">${esc(d.name)}</span>
            <span class="tool-block-preview">${esc(d.preview)}</span>
            <span class="tool-block-chevron">▸</span>
          </div>
          <div class="tool-block-body">
            <div class="tool-block-loading">Running…</div>
          </div>`;
        block.querySelector(".tool-block-header")
          ?.addEventListener("click", () => block.classList.toggle("expanded"));
        ph.before(block);
        if (container) container.scrollTop = container.scrollHeight;
      } catch { /* ignore bad JSON */ }
      return;
    }

    // ── tool_end: update collapsible block + terminal ──────────
    if (step === "tool_end") {
      try {
        const d = JSON.parse(message) as { id: string; name: string; ok: boolean; output: string };

        // Feed result to terminal (all tools)
        termFeedAgentEnd(d.id, d.ok, d.output);

        // Update collapsible block in chat
        const block = $<HTMLElement>(`.tool-block[data-tool-id="${d.id}"]`);
        if (block) {
          const statusEl = block.querySelector<HTMLElement>(".tool-block-status");
          if (statusEl) {
            statusEl.classList.remove("spinning");
            statusEl.classList.add(d.ok ? "ok" : "error");
          }
          const bodyEl = block.querySelector<HTMLElement>(".tool-block-body");
          if (bodyEl) {
            bodyEl.innerHTML = `<pre class="tool-block-output">${esc(d.output || "(no output)")}</pre>`;
          }
        }

        // ── File card: inject when write_file succeeds ──────────
        if (d.name === "write_file" && d.ok) {
          // output from tools.ts: "Wrote N bytes to /path/to/file"
          const match = d.output.match(/Wrote \d+ bytes to (.+)/);
          const filePath = match?.[1]?.trim();
          if (filePath) injectFileCard(filePath);
        }
      } catch { /* ignore bad JSON */ }
      return;
    }
  });

  try {
    const result = await window.clawAPI.runAgent(text, currentSessionId);
    ph.remove();

    // Restore full artifact rendering: cards now appear in final message
    artifactStreamingMode = false;

    if (result.ok && result.data) {
      appendMsg("assistant", (result.data as { answer: string }).answer);
    } else {
      appendMsg("assistant", `⚠️ ${result.error ?? "Unknown error"}`);
    }
  } finally {
    stopOnToken?.();   stopOnToken    = null;
    stopOnProgress?.(); stopOnProgress = null;
    setRunning(false);
  }
}

function setRunning(v: boolean): void {
  isRunning = v;
  const send  = $<HTMLButtonElement>("#btn-send");
  const stop  = $<HTMLButtonElement>("#btn-stop");
  const prog  = $<HTMLElement>("#chat-progress");
  const input = $<HTMLTextAreaElement>("#chat-input");
  if (send)  send.classList.toggle("hidden", v);
  if (stop)  stop.classList.toggle("hidden", !v);
  if (prog)  prog.classList.toggle("visible", v);
  if (input) input.disabled = v;
}

// ══ Memory panel ═══════════════════════════════════════════════
async function loadMemoryPanel(): Promise<void> {
  const r = await window.clawAPI.listMemories();
  const grid = $<HTMLElement>("#memory-grid");
  if (!grid) return;

  if (!r.ok || !(r.data as unknown[])?.length) {
    grid.innerHTML = `<div class="list-empty" style="width:100%">No memories stored yet.<br><small style="color:var(--text-dim)">IKAI will remember facts as you chat.</small></div>`;
    return;
  }

  const mems = r.data as Array<{ key: string; value: string; updatedAt: number }>;
  grid.innerHTML = mems.map(m => `
    <div class="memory-card">
      <div class="memory-key">${esc(m.key)}</div>
      <div class="memory-value">${esc(m.value)}</div>
      <div class="memory-footer">
        <span class="memory-time">${timeAgo(m.updatedAt)}</span>
        <button class="btn-danger" data-key="${esc(m.key)}">✕ Delete</button>
      </div>
    </div>`).join("");

  $$<HTMLButtonElement>(".memory-card .btn-danger").forEach(btn => {
    btn.addEventListener("click", async () => {
      await window.clawAPI.deleteMemory(btn.dataset["key"] ?? "");
      void loadMemoryPanel();
    });
  });
}

// ══ Skills panel ═══════════════════════════════════════════════
async function loadSkillsPanel(): Promise<void> {
  const r = await window.clawAPI.listSkills();
  const grid = $<HTMLElement>("#skills-grid");
  if (!grid) return;

  if (!r.ok || !(r.data as unknown[])?.length) {
    grid.innerHTML = `<div class="list-empty" style="width:100%">No skills loaded. Add skill paths in <code>claw.config.toml</code>.</div>`;
    return;
  }

  const skills = r.data as Array<{ name: string; description: string; trigger: string[]; version: string }>;
  grid.innerHTML = skills.map(sk => `
    <div class="skill-card">
      <div class="skill-card-header">
        <span class="skill-card-icon">⚡</span>
        <span class="skill-card-name">${esc(sk.name)}</span>
      </div>
      <div class="skill-card-desc">${esc(sk.description ?? "")}</div>
      ${sk.version ? `<span class="skill-card-tag">v${esc(sk.version)}</span>` : ""}
    </div>`).join("");
}

// ══ Cron panel ════════════════════════════════════════════════
async function loadCronPanel(): Promise<void> {
  const r = await window.clawAPI.listCronJobs();
  const container = $<HTMLElement>("#cron-list-wrap");
  if (!container) return;

  if (!r.ok || !(r.data as unknown[])?.length) {
    container.innerHTML = `<div class="list-empty">No cron jobs scheduled. Ask IKAI to schedule a recurring task.</div>`;
    return;
  }

  const jobs = r.data as Array<{
    id: string; name: string; expression: string;
    skillName: string; enabled: boolean; lastRun: number | null;
  }>;

  container.innerHTML = jobs.map(j => `
    <div class="cron-item">
      <div class="cron-row1">
        <span class="cron-name">${esc(j.name)}</span>
        <label class="toggle">
          <input type="checkbox" ${j.enabled ? "checked" : ""} data-job-id="${esc(j.id)}">
          <div class="toggle-track"></div>
        </label>
      </div>
      <div class="cron-row2">
        <span class="cron-expr">${esc(j.expression)}</span>
        <span class="cron-skill">${esc(j.skillName)}</span>
        <span class="cron-last">${j.lastRun ? timeAgo(j.lastRun) : "Never run"}</span>
        <button class="btn-danger" data-job-id="${esc(j.id)}">✕</button>
      </div>
    </div>`).join("");

  $$<HTMLInputElement>(".cron-item input[type=checkbox]").forEach(toggle => {
    toggle.addEventListener("change", () =>
      window.clawAPI.toggleCronJob(toggle.dataset["jobId"] ?? "", toggle.checked)
    );
  });

  $$<HTMLButtonElement>(".cron-item .btn-danger").forEach(btn => {
    btn.addEventListener("click", async () => {
      await window.clawAPI.deleteCronJob(btn.dataset["jobId"] ?? "");
      void loadCronPanel();
    });
  });
}

// ══ Terminal panel ════════════════════════════════════════════
let termCwd = "";   // tracks current working directory in terminal
let termSeq = 0;    // unique ID for each terminal entry

async function loadTerminalPanel(): Promise<void> {
  const r = await window.clawAPI.getShellInfo();
  if (r.ok && r.data) {
    const d = r.data as { shell: string; cwd: string };
    termCwd = d.cwd;
    const label = $<HTMLElement>("#term-shell-label");
    const prompt = $<HTMLElement>("#term-prompt");
    if (label)  label.textContent = d.shell;
    if (prompt) prompt.textContent = shortPath(d.cwd) + " $";
  }
}

/** Shorten a path for the prompt — show last 2 segments */
function shortPath(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length <= 2 ? p : "…/" + parts.slice(-2).join("/");
}

/** Build terminal entry HTML */
// ── Tool icon map ──────────────────────────────────────────────
const TOOL_ICONS: Record<string, string> = {
  shell:        "⚡",
  read_file:    "📄",
  write_file:   "✏️",
  list_dir:     "📁",
  memory_read:  "🔍",
  memory_write: "💾",
  browser:      "🌐",
  run_skill:    "⚡",
  schedule_cron:"⏰",
};

function buildTermEntryHtml(
  source: "agent" | "user",
  toolName: string,
  command: string,
  id: string,
): string {
  const isUser   = source === "user";
  const icon     = isUser ? "💻" : (TOOL_ICONS[toolName] ?? "🔧");
  const badge    = isUser ? "USER" : "AGENT";
  const badgeCls = isUser ? "term-badge user" : "term-badge agent";
  const toolTag  = isUser ? "shell" : toolName;
  const cmdText  = command || "(no args)";
  return `
    <div class="term-entry" data-term-id="${esc(id)}">
      <div class="term-cmd-line">
        <span class="${badgeCls}">${badge}</span>
        <span class="term-tool-tag">${esc(toolTag)}</span>
        <span class="term-cmd-icon">${icon}</span>
        <span class="term-cmd-text">${esc(cmdText)}</span>
        <span class="term-dot-status spinning"></span>
      </div>
      <div class="term-output running">
        <span class="term-spinner"></span>
        <span class="term-running-text">running…</span>
      </div>
    </div>`;
}

/** Append a terminal entry to a history element */
function termAppendTo(
  histId: string,
  source: "agent" | "user",
  toolName: string,
  command: string,
  id: string,
): void {
  const hist = $<HTMLElement>(histId);
  if (!hist) return;
  hist.insertAdjacentHTML("beforeend", buildTermEntryHtml(source, toolName, command, id));
  hist.scrollTop = hist.scrollHeight;
}

/** Update status dot on the cmd-line */
function termSetDot(entry: HTMLElement, isOk: boolean): void {
  const dot = entry.querySelector<HTMLElement>(".term-dot-status");
  if (dot) {
    dot.classList.remove("spinning");
    dot.classList.add(isOk ? "ok" : "error");
  }
}

/** Update an existing terminal entry inside a given history element */
function termUpdateIn(histId: string, id: string, ok: boolean, output: string): void {
  const hist = $<HTMLElement>(histId);
  if (!hist) return;
  const entry = hist.querySelector<HTMLElement>(`.term-entry[data-term-id="${id}"]`);
  if (!entry) return;
  termSetDot(entry, ok);
  const outEl = entry.querySelector<HTMLElement>(".term-output");
  if (outEl) {
    outEl.classList.remove("running");
    outEl.classList.add(ok ? "ok" : "error");
    outEl.innerHTML = `<pre class="term-out-pre">${esc(output || "(no output)")}</pre>`;
  }
  hist.scrollTop = hist.scrollHeight;
}

/** Append a terminal entry to ALL history panels */
function termAppend(source: "agent" | "user", toolName: string, command: string, id: string): void {
  termAppendTo("#term-history",      source, toolName, command, id);
  termAppendTo("#term-mini-history", source, toolName, command, id);
}

/** Update ALL history panels with result */
function termUpdate(id: string, ok: boolean, output: string): void {
  termUpdateIn("#term-history",      id, ok, output);
  termUpdateIn("#term-mini-history", id, ok, output);
}

/** Append a streaming stdout/stderr chunk to a terminal entry */
function termChunkIn(histId: string, id: string, chunk: string): void {
  const hist = $<HTMLElement>(histId);
  if (!hist) return;
  const entry = hist.querySelector<HTMLElement>(`.term-entry[data-term-id="${id}"]`);
  if (!entry) return;
  const outEl = entry.querySelector<HTMLElement>(".term-output");
  if (!outEl) return;

  // First chunk: swap spinner for a live <pre>
  if (outEl.classList.contains("running")) {
    outEl.classList.remove("running");
    outEl.classList.add("streaming");
    outEl.innerHTML = `<pre class="term-out-pre" data-full=""></pre>`;
  }

  const pre = outEl.querySelector<HTMLPreElement>(".term-out-pre");
  if (pre) {
    const full = (pre.dataset["full"] ?? "") + chunk;
    pre.dataset["full"] = full;
    pre.textContent = full.split("\n").slice(-120).join("\n"); // keep last 120 lines
  }
  hist.scrollTop = hist.scrollHeight;
}

function termChunk(id: string, chunk: string): void {
  termChunkIn("#term-history",      id, chunk);
  termChunkIn("#term-mini-history", id, chunk);
}

/** Finalize a terminal entry: update status dot, keep streamed content if present */
function termFinalizeIn(histId: string, id: string, isOk: boolean, fallbackOutput: string): void {
  const hist  = $<HTMLElement>(histId);
  if (!hist) return;
  const entry = hist.querySelector<HTMLElement>(`.term-entry[data-term-id="${id}"]`);
  if (!entry) return;
  const outEl = entry.querySelector<HTMLElement>(".term-output");
  if (!outEl) return;

  termSetDot(entry, isOk);
  if (outEl.classList.contains("streaming")) {
    outEl.classList.remove("streaming");
    outEl.classList.add(isOk ? "ok" : "error");
  } else {
    outEl.classList.remove("running");
    outEl.classList.add(isOk ? "ok" : "error");
    outEl.innerHTML = `<pre class="term-out-pre">${esc(fallbackOutput || "(no output)")}</pre>`;
  }
  hist.scrollTop = hist.scrollHeight;
}

function termFinalize(id: string, isOk: boolean, output: string): void {
  termFinalizeIn("#term-history",      id, isOk, output);
  termFinalizeIn("#term-mini-history", id, isOk, output);
}

/** Run a command from the user input bar */
async function runTermCommand(): Promise<void> {
  const input = $<HTMLInputElement>("#term-input");
  if (!input) return;
  const cmd = input.value.trim();
  if (!cmd) return;
  input.value = "";
  input.disabled = true;

  const id = `u${++termSeq}`;
  termAppend("user", "shell", cmd, id);

  // Subscribe to streaming chunks for this specific execId
  const stopChunks = window.clawAPI.onShellChunk(({ id: chunkId, chunk }) => {
    if (chunkId === id) termChunk(id, chunk);
  });

  const r = await window.clawAPI.execShell(cmd, termCwd || undefined, id);
  stopChunks();

  // Finalize: update status dot, use streamed content if available
  const fallback = r.ok ? String((r.data as string | undefined) ?? "(no output)")
                        : `ERROR: ${r.error ?? "unknown"}`;
  termFinalize(id, r.ok ?? false, fallback);

  input.disabled = false;
  input.focus();
}

/** Feed agent tool calls into the terminal panels (called from onProgress) */
function termFeedAgentStart(id: string, toolName: string, preview: string): void {
  termAppend("agent", toolName, preview, `a${id}`);
}
function termFeedAgentEnd(id: string, isOk: boolean, output: string): void {
  termFinalize(`a${id}`, isOk, output);
}

// ══ Logs panel ════════════════════════════════════════════════
async function loadLogsPanel(): Promise<void> {
  const r = await window.clawAPI.getLogHistory();
  if (!r.ok || !r.data) return;
  const entries = r.data as Array<{ ts: string; level: string; namespace: string; message: string }>;
  renderLogEntries(entries);
}

function renderLogEntries(entries: Array<{ ts: string; level: string; namespace: string; message: string }>): void {
  const stream = $<HTMLElement>("#log-stream");
  if (!stream) return;
  const filtered = logFilter ? entries.filter(e => e.level === logFilter) : entries;
  stream.innerHTML = [...filtered].reverse().slice(0, 300).map(e => buildLogHtml(e)).join("");
}

function buildLogHtml(e: { ts: string; level: string; namespace: string; message: string }): string {
  return `
    <div class="log-entry level-${esc(e.level)}">
      <span class="log-ts">${esc(e.ts.slice(11, 19))}</span>
      <span class="log-lvl">${esc(e.level.toUpperCase())}</span>
      <span class="log-ns">${esc(e.namespace)}</span>
      <span class="log-msg">${esc(e.message)}</span>
    </div>`;
}

function appendLog(entry: { ts: string; level: string; namespace: string; message: string }): void {
  if (currentPanel !== "logs") return;
  if (logFilter && entry.level !== logFilter) return;
  const stream = $<HTMLElement>("#log-stream");
  if (!stream) return;
  stream.insertAdjacentHTML("afterbegin", buildLogHtml(entry));
  while (stream.children.length > 300) stream.lastElementChild?.remove();
}

// ══ Config panel ══════════════════════════════════════════════
async function loadConfigPanel(): Promise<void> {
  const r = await window.clawAPI.getConfig();
  if (!r.ok || !r.data) return;
  const c = r.data as Record<string, unknown>;

  setText("cfg-provider",    String(c["provider"]    ?? "—"));
  setText("cfg-model",       String(c["model"]       ?? "—"));
  setText("cfg-base-url",    String(c["baseUrl"]     ?? "—"));
  setText("cfg-max-tokens",  String(c["maxTokens"]   ?? "—"));
  setText("cfg-max-iter",    String(c["maxIter"]     ?? "—"));
  setText("cfg-max-ctx",     String(c["maxContext"]  ?? "—"));
  setText("cfg-db-path",     String(c["dbPath"]      ?? "—"));
  setText("cfg-log-level",   String(c["logLevel"]    ?? "—"));
  setText("cfg-config-path", String(c["configPath"]  ?? "—"));
  const paths = c["skillsPaths"];
  setText("cfg-skills-paths", Array.isArray(paths) ? paths.join(", ") : String(paths ?? "—"));

  // Update sidebar model badge
  const badge = $<HTMLElement>("#model-badge");
  if (badge) badge.textContent = String(c["model"] ?? "—");

  // Show setup warning if config file doesn't exist
  const warn = $<HTMLElement>("#cfg-no-config-warn");
  if (warn) {
    warn.style.display = c["configExists"] ? "none" : "block";
    if (!c["configExists"]) {
      const cfgPath = String(c["configPath"] ?? "~/.claw/config.toml");
      warn.innerHTML = `⚠️ ยังไม่มี config file<br>
        กด <strong>Open Config File</strong> ด้านล่างเพื่อสร้างไฟล์ที่<br>
        <code>${esc(cfgPath)}</code><br>
        แล้วใส่ <strong>api_key</strong> ของคุณ`;
    }
  }
}

// ══ Artifact Panel (unified — Claude.ai style) ════════════════
// Single right-side panel that handles: mermaid, html, svg, and files.

const IMAGE_EXTS = new Set(["png","jpg","jpeg","gif","webp","bmp","ico"]);
const TEXT_EXTS  = new Set([
  "txt","md","py","js","ts","jsx","tsx","html","htm","css","json","yaml","yml",
  "toml","sh","bash","zsh","go","rs","sql","xml","csv","log","ini","cfg","conf","env","gitignore",
]);

function openArtifactPanelShell(panel: HTMLElement, body: HTMLElement,
                                 titleEl: HTMLElement | null, iconEl: HTMLElement | null,
                                 icon: string, title: string): void {
  if (iconEl)  iconEl.textContent  = icon;
  if (titleEl) titleEl.textContent = title;
  panel.style.display = "flex";
  body.innerHTML = `<div class="ap-loading">⟳ Loading…</div>`;
}

async function openArtifactPanel(artifactId: string): Promise<void> {
  const data = artifactStore.get(artifactId);
  if (!data) return;
  const panel   = document.getElementById("artifact-panel");
  const body    = document.getElementById("ap-body");
  const titleEl = document.getElementById("ap-title");
  const iconEl  = document.getElementById("ap-icon");
  const copyBtn = document.getElementById("btn-ap-copy") as HTMLButtonElement | null;
  if (!panel || !body) return;

  openArtifactPanelShell(panel, body, titleEl, iconEl, data.icon, data.title);
  if (copyBtn) { copyBtn.dataset["copy"] = data.content; delete copyBtn.dataset["filePath"]; }

  switch (data.kind) {
    case "mermaid": {
      const svgId = `apmmd-${Date.now()}`;
      body.innerHTML = `<div class="ap-mermaid-wrap" id="${svgId}">
        <span class="ap-loading">⟳ Rendering diagram…</span>
      </div>`;
      try {
        const { svg } = await mermaid.render(`svg-${svgId}`, data.content);
        const el = document.getElementById(svgId);
        if (el) el.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
      } catch (e) {
        body.innerHTML = `<div class="ap-error">⚠ ${esc(String(e))}</div>`;
      }
      break;
    }
    case "svg": {
      const clean = DOMPurify.sanitize(data.content, { USE_PROFILES: { svg: true } });
      body.innerHTML = `<div class="ap-svg-wrap">${clean}</div>`;
      break;
    }
    case "html": {
      body.innerHTML = `
        <div class="ap-tabs">
          <button class="ap-tab active" data-tab="preview">▶ Preview</button>
          <button class="ap-tab" data-tab="source">Source</button>
        </div>
        <div id="ap-tab-preview" class="ap-tab-pane">
          <iframe sandbox="allow-scripts allow-same-origin" class="ap-iframe"></iframe>
        </div>
        <div id="ap-tab-source" class="ap-tab-pane" style="display:none">
          <pre class="ap-code"><code>${esc(data.content)}</code></pre>
        </div>`;
      const iframe = body.querySelector<HTMLIFrameElement>("iframe");
      if (iframe) iframe.srcdoc = data.content;
      apWireTabs(body);
      break;
    }
  }
}

async function openFilePanel(filePath: string): Promise<void> {
  const panel   = document.getElementById("artifact-panel");
  const body    = document.getElementById("ap-body");
  const titleEl = document.getElementById("ap-title");
  const iconEl  = document.getElementById("ap-icon");
  const copyBtn = document.getElementById("btn-ap-copy") as HTMLButtonElement | null;
  if (!panel || !body) return;

  const fileName = filePath.split(/[/\\]/).at(-1) ?? filePath;
  const ext      = fileExt(filePath);
  const icon     = FILE_ICONS[ext] ?? "📄";

  openArtifactPanelShell(panel, body, titleEl, iconEl, icon, fileName);
  if (copyBtn) { copyBtn.dataset["filePath"] = filePath; delete copyBtn.dataset["copy"]; }

  // Image
  if (IMAGE_EXTS.has(ext)) {
    const src = "file://" + filePath.replace(/\\/g, "/");
    body.innerHTML = `<div class="ap-img-wrap">
      <img src="${esc(src)}" alt="${esc(fileName)}" class="ap-img"
           onerror="this.parentElement.innerHTML='<div class=\\'ap-error\\'>⚠ Cannot load image</div>'" />
    </div>`;
    return;
  }

  // Unsupported binary
  if (!TEXT_EXTS.has(ext)) {
    body.innerHTML = `<div class="ap-unsupported">
      <span class="ap-unsupported-icon">${icon}</span>
      <div>No preview for <strong>.${esc(ext || "?")}</strong></div>
      <button class="btn-sm-accent ap-sys-open" data-file-path="${esc(filePath)}">📂 Open in system</button>
    </div>`;
    body.querySelector<HTMLButtonElement>(".ap-sys-open")?.addEventListener("click", () =>
      void openInSystem(filePath));
    return;
  }

  const r = await window.clawAPI.execShell(`cat "${filePath}"`, undefined, undefined);
  if (!r.ok) {
    body.innerHTML = `<div class="ap-error">⚠ ${esc(r.error ?? "Cannot read file")}</div>`;
    return;
  }
  const content = String((r.data as string | undefined) ?? "");

  // HTML file
  if (ext === "html" || ext === "htm") {
    body.innerHTML = `
      <div class="ap-tabs">
        <button class="ap-tab active" data-tab="preview">▶ Preview</button>
        <button class="ap-tab" data-tab="source">Source</button>
      </div>
      <div id="ap-tab-preview" class="ap-tab-pane">
        <iframe sandbox="allow-scripts allow-same-origin" class="ap-iframe" srcdoc="${esc(content)}"></iframe>
      </div>
      <div id="ap-tab-source" class="ap-tab-pane" style="display:none">
        <pre class="ap-code"><code>${esc(content.slice(0, 100_000))}</code></pre>
      </div>`;
    apWireTabs(body);
    return;
  }

  // SVG file
  if (ext === "svg") {
    const clean = DOMPurify.sanitize(content, { USE_PROFILES: { svg: true } });
    body.innerHTML = `<div class="ap-svg-wrap">${clean}</div>`;
    return;
  }

  // Markdown
  if (ext === "md") {
    body.innerHTML = `<div class="ap-markdown markdown-body">${renderMd(content)}</div>`;
    return;
  }

  // Plain text / code
  const display = content.length > 100_000 ? content.slice(0, 100_000) + "\n… [truncated]" : content;
  body.innerHTML = `<pre class="ap-code"><code>${esc(display)}</code></pre>`;
}

function closeArtifactPanel(): void {
  const panel = document.getElementById("artifact-panel");
  if (panel) panel.style.display = "none";
}

function apWireTabs(body: HTMLElement): void {
  body.querySelectorAll<HTMLElement>(".ap-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      body.querySelectorAll(".ap-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const isPreview = tab.dataset["tab"] === "preview";
      body.querySelector<HTMLElement>("#ap-tab-preview")!.style.display = isPreview ? "" : "none";
      body.querySelector<HTMLElement>("#ap-tab-source")!.style.display  = isPreview ? "none" : "";
    });
  });
}

async function openInSystem(filePath: string): Promise<void> {
  const isWin = /^[A-Za-z]:\\/.test(filePath);
  const cmd   = isWin ? `explorer "${filePath}"`
    : (navigator.userAgent.includes("Mac") ? `open "${filePath}"` : `xdg-open "${filePath}"`);
  await window.clawAPI.execShell(cmd, undefined, undefined);
}

// ══ Agent panel ═══════════════════════════════════════════════
async function loadAgentPanel(): Promise<void> {
  const [sr, cr] = await Promise.all([window.clawAPI.getStats(), window.clawAPI.getConfig()]);
  const row = $<HTMLElement>("#agent-stats-row");
  if (!row) return;

  const stats: string[] = [];
  if (sr.ok && sr.data) {
    const s = sr.data as { totalSessions: number; totalMessages: number; totalToolCalls: number };
    stats.push(`<div class="agent-stat"><strong>${s.totalSessions}</strong> sessions</div>`);
    stats.push(`<div class="agent-stat"><strong>${s.totalMessages}</strong> messages</div>`);
    stats.push(`<div class="agent-stat"><strong>${s.totalToolCalls}</strong> tool calls</div>`);
  }
  if (cr.ok && cr.data) {
    const c = cr.data as Record<string, unknown>;
    stats.push(`<div class="agent-stat">Model: <strong>${esc(String(c["model"] ?? "—"))}</strong></div>`);
    stats.push(`<div class="agent-stat">Max iter: <strong>${esc(String(c["maxIter"] ?? "—"))}</strong></div>`);
    // Update badge too
    const badge = $<HTMLElement>("#model-badge");
    if (badge) badge.textContent = String(c["model"] ?? "—");
  }
  row.innerHTML = stats.join("");
}

// ══ Utils ═════════════════════════════════════════════════════
function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function timeAgo(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000)     return "just now";
  if (d < 3_600_000)  return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

function setText(id: string, text: string): void {
  const el = $(`#${id}`);
  if (el) el.textContent = text;
}

// ══ Bootstrap ═════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {

  // ── Sidebar nav ───────────────────────────────────────────
  $$<HTMLElement>(".nav-item[data-panel]").forEach(el =>
    el.addEventListener("click", () => switchPanel(el.dataset["panel"] as Panel))
  );

  // ── Quick action buttons (dashboard) ──────────────────────
  $<HTMLButtonElement>("#qa-chat")?.addEventListener("click", () => {
    switchPanel("sessions");
    // auto-create new session
    window.clawAPI.newSession().then(r => {
      if (r.ok && r.data) {
        currentSessionId = (r.data as { id: string }).id;
        showChatEmpty(false);
        void loadSessionsList();
      }
    }).catch(() => undefined);
  });
  $<HTMLButtonElement>("#qa-memory")?.addEventListener("click", () => switchPanel("memory"));
  $<HTMLButtonElement>("#qa-logs")?.addEventListener("click",   () => switchPanel("logs"));
  $<HTMLButtonElement>("#qa-config")?.addEventListener("click", () => switchPanel("config"));

  // ── New session (topbar) ───────────────────────────────────
  $<HTMLButtonElement>("#btn-new-session")?.addEventListener("click", async () => {
    const r = await window.clawAPI.newSession();
    if (r.ok && r.data) {
      currentSessionId = (r.data as { id: string }).id;
      switchPanel("sessions");
      showChatEmpty(false);
      void loadSessionsList();
    }
  });

  // ── New session (session list) ─────────────────────────────
  $<HTMLButtonElement>("#btn-new-sess")?.addEventListener("click", async () => {
    const r = await window.clawAPI.newSession();
    if (r.ok && r.data) {
      currentSessionId = (r.data as { id: string }).id;
      showChatEmpty(false);
      const container = $<HTMLElement>("#chat-messages");
      if (container) container.innerHTML = "";
      void loadSessionsList();
    }
  });

  // ── Add memory ────────────────────────────────────────────
  $<HTMLButtonElement>("#btn-add-memory")?.addEventListener("click", () => {
    const key   = prompt("Memory key (e.g. user.name, project.stack):");
    const value = key?.trim() ? prompt(`Value for "${key}":`) : null;
    if (key?.trim() && value?.trim()) {
      window.clawAPI.setMemory(key.trim(), value.trim())
        .then(() => loadMemoryPanel())
        .catch(() => undefined);
    }
  });

  // ── Memory search ─────────────────────────────────────────
  $<HTMLInputElement>("#memory-search")?.addEventListener("input", e => {
    const q = (e.target as HTMLInputElement).value.toLowerCase();
    $$<HTMLElement>(".memory-card").forEach(c => {
      c.style.display = (c.textContent ?? "").toLowerCase().includes(q) ? "" : "none";
    });
  });

  // ── Chat send / stop ──────────────────────────────────────
  $<HTMLButtonElement>("#btn-send")?.addEventListener("click", () => void sendMessage());
  $<HTMLButtonElement>("#btn-stop")?.addEventListener("click", () => void window.clawAPI.abortRun());

  $<HTMLTextAreaElement>("#chat-input")?.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void sendMessage(); }
  });
  $<HTMLTextAreaElement>("#chat-input")?.addEventListener("input", e => {
    const ta = e.target as HTMLTextAreaElement;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 140) + "px";
  });

  // ── Terminal (full panel) ─────────────────────────────────
  $<HTMLButtonElement>("#btn-run-cmd")?.addEventListener("click", () => void runTermCommand());
  $<HTMLInputElement>("#term-input")?.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); void runTermCommand(); }
  });
  $<HTMLButtonElement>("#btn-clear-term")?.addEventListener("click", () => {
    const hist = $<HTMLElement>("#term-history");
    if (hist) hist.innerHTML = "";
  });

  // ── Artifact & file card event delegation ─────────────────
  document.getElementById("chat-messages")?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    // Copy artifact source code
    const copyBtn = target.closest<HTMLButtonElement>(".btn-copy-artifact");
    if (copyBtn) {
      const code = copyBtn.dataset["copy"] ?? "";
      void navigator.clipboard.writeText(code);
      const orig = copyBtn.textContent;
      copyBtn.textContent = "✓";
      setTimeout(() => { copyBtn.textContent = orig; }, 1200);
      return;
    }

    // Toggle HTML source panel
    const srcToggle = target.closest<HTMLButtonElement>(".btn-html-source-toggle");
    if (srcToggle) {
      const art     = srcToggle.closest<HTMLElement>(".artifact-html");
      const details = art?.querySelector<HTMLDetailsElement>(".artifact-source");
      if (details) {
        details.open = !details.open;
        srcToggle.textContent = details.open ? "⊟ Source" : "⊞ Source";
      }
      return;
    }

    // Open file in viewer pane
    const viewBtn = target.closest<HTMLButtonElement>(".btn-file-view");
    if (viewBtn) {
      const path = viewBtn.dataset["path"] ?? "";
      if (path) void openFileViewer(path);
      return;
    }

    // Open file in system explorer
    const openBtn = target.closest<HTMLButtonElement>(".btn-file-open");
    if (openBtn) {
      const path = openBtn.dataset["path"] ?? "";
      if (path) void openFileInSystem(path);
      return;
    }
  });

  // ── File Viewer Pane ──────────────────────────────────────
  document.getElementById("btn-close-file-viewer")
    ?.addEventListener("click", () => closeFileViewer());

  // ── Terminal mini pane (inside Sessions) ──────────────────
  function toggleTermMini(force?: boolean): void {
    const pane  = $<HTMLElement>("#term-mini-pane");
    const btn   = $<HTMLButtonElement>("#btn-toggle-term");
    if (!pane) return;
    const show = force !== undefined ? force : pane.style.display === "none";
    pane.style.display = show ? "flex" : "none";
    btn?.classList.toggle("active", show);
  }
  $<HTMLButtonElement>("#btn-toggle-term")
    ?.addEventListener("click", () => toggleTermMini());
  $<HTMLButtonElement>("#btn-close-term-mini")
    ?.addEventListener("click", () => toggleTermMini(false));

  // ── Log filters ───────────────────────────────────────────
  $$<HTMLElement>(".log-filter").forEach(btn => {
    btn.addEventListener("click", () => {
      $$(".log-filter").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      logFilter = btn.dataset["level"] ?? "";
      void loadLogsPanel();
    });
  });

  $<HTMLButtonElement>("#btn-clear-logs")?.addEventListener("click", () => {
    const stream = $<HTMLElement>("#log-stream");
    if (stream) stream.innerHTML = "";
  });

  // ── Live log stream ───────────────────────────────────────
  window.clawAPI.onLog(entry => appendLog(entry));

  // ── Config open button ────────────────────────────────────
  $<HTMLButtonElement>("#btn-open-config")?.addEventListener("click", () =>
    void window.clawAPI.openConfig()
  );

  // ── Initial load ──────────────────────────────────────────
  // Load config first to get model badge
  window.clawAPI.getConfig().then(r => {
    if (r.ok && r.data) {
      const c = r.data as Record<string, unknown>;
      const badge = $<HTMLElement>("#model-badge");
      if (badge) badge.textContent = String(c["model"] ?? "—");
    }
  }).catch(() => undefined);

  switchPanel("dashboard");
});
