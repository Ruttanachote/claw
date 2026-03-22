/**
 * Claw — End-to-End Integration Test (Step 10)
 *
 * Covers:
 *   [A] Memory — DB init, sessions, messages, cron CRUD
 *   [B] Skill-runner — load skills, match triggers, validate inputs, resolve, catalogue
 *   [C] Gateway — full stack init: config → logger → DB → LLM client
 *   [D] Cron manager — upsert, schedule, list, remove
 *   [E] Browser — navigate + screenshot (auto-skip if Chrome not available)
 *
 * Run:  node test/e2e.cjs
 */

"use strict";

const path = require("path");
const fs   = require("fs");
const os   = require("os");

// ── Colours ───────────────────────────────────────────────────────────────
const C = {
  green:  (s) => `\x1b[32m${s}\x1b[0m`,
  red:    (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s) => `\x1b[2m${s}\x1b[0m`,
};

// ── Test harness ──────────────────────────────────────────────────────────
let passed  = 0;
let failed  = 0;
let skipped = 0;
const failures = [];

function assert(condition, message) {
  if (!condition) throw new Error(message || "assertion failed");
}

async function test(label, fn) {
  process.stdout.write(`  ${C.dim("·")} ${label} … `);
  try {
    await fn();
    passed++;
    console.log(C.green("✓"));
  } catch (e) {
    failed++;
    failures.push({ label, error: e.message });
    console.log(C.red("✗  " + e.message));
  }
}

function skip(label, reason) {
  skipped++;
  console.log(`  ${C.yellow("○")} ${C.dim(label)} ${C.yellow("(skip: " + reason + ")")}`);
}

function section(name) {
  console.log("\n" + C.bold(C.cyan("[" + name + "]")));
}

// ── Paths ─────────────────────────────────────────────────────────────────
const ROOT        = path.resolve(__dirname, "..");
const FIXTURES    = path.resolve(__dirname, "fixtures");
const CONFIG_FILE = path.join(FIXTURES, "test.config.toml");
const SKILLS_DIR  = path.join(ROOT, "skills", "built-in");
const TMP_DIR     = fs.mkdtempSync(path.join(os.tmpdir(), "claw-test-"));
const DB_FILE     = path.join(TMP_DIR, "test.db");
const LOG_DIR     = path.join(TMP_DIR, "logs");

// ── Require built packages ────────────────────────────────────────────────
const memory      = require(path.join(ROOT, "packages/memory/dist/index.js"));
const skillRunner = require(path.join(ROOT, "packages/skill-runner/dist/index.js"));
const gateway     = require(path.join(ROOT, "packages/gateway/dist/index.js"));
const cronPkg     = require(path.join(ROOT, "packages/cron/dist/index.js"));
const browserPkg  = require(path.join(ROOT, "packages/browser/dist/index.js"));

// ─────────────────────────────────────────────────────────────────────────
async function main() {
// ─────────────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════
// [A] Memory
// ═══════════════════════════════════════════════════════════════
section("A · Memory");

await test("initLogger doesn't throw", async () => {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  memory.initLogger(LOG_DIR, "warn");
});

await test("loadConfig reads test.config.toml", async () => {
  const r = memory.loadConfig(CONFIG_FILE);
  assert(r.ok, r.error);
  const cfg = memory.getConfig();
  assert(cfg.llm.api_key.startsWith("sk-or-test"), "api_key prefix mismatch");
  assert(cfg.llm.model === "openai/gpt-4o-mini", "model mismatch");
});

await test("initDb creates WAL SQLite database", async () => {
  const r = memory.initDb(DB_FILE);
  assert(r.ok, r.error);
  assert(fs.existsSync(DB_FILE), "db file not on disk");
  // getDb() returns Result<Database>
  const dbR = memory.getDb();
  assert(dbR.ok, dbR.error);
  const db  = dbR.data;
  const row = db.prepare("PRAGMA journal_mode").get();
  assert(row.journal_mode === "wal", "expected WAL, got: " + row.journal_mode);
});

await test("createSession returns session with valid id + timestamps", async () => {
  const r = memory.createSession();
  assert(r.ok, r.error);
  assert(typeof r.data.id === "string" && r.data.id.length > 0, "session id empty");
  assert(typeof r.data.createdAt === "number", "createdAt not a number");
  assert(typeof r.data.updatedAt === "number", "updatedAt not a number");
});

await test("listSessions includes newly created session", async () => {
  const r = memory.listSessions(10);
  assert(r.ok, r.error);
  assert(Array.isArray(r.data) && r.data.length >= 1, "expected >=1 sessions");
});

let testSessionId;
await test("ensureSession(null) creates a new session", async () => {
  const r = memory.ensureSession(null);
  assert(r.ok, r.error);
  testSessionId = r.data.id;
  assert(typeof testSessionId === "string", "session id not a string");
});

await test("writeMessage({ sessionId, role, content }) stores messages", async () => {
  // writeMessage takes a single input object
  const r1 = memory.writeMessage({ sessionId: testSessionId, role: "user",      content: "hello claw" });
  const r2 = memory.writeMessage({ sessionId: testSessionId, role: "assistant", content: "hi there!" });
  assert(r1.ok, r1.error);
  assert(r2.ok, r2.error);
});

await test("readContext returns messages in insertion order", async () => {
  const r = memory.readContext(testSessionId, 20);
  assert(r.ok, r.error);
  assert(r.data.length >= 2, "expected >=2 messages");
  assert(r.data[0].role === "user",      "first message should be user");
  assert(r.data[1].role === "assistant", "second message should be assistant");
  assert(r.data[0].content === "hello claw", "user content mismatch");
});

await test("writeExchange atomically writes user + assistant pair", async () => {
  const r = memory.writeExchange(testSessionId, "what time is it?", "I don't have a clock.");
  assert(r.ok, r.error);
  const ctx = memory.readContext(testSessionId, 20);
  assert(ctx.data.length >= 4, "expected >=4 messages after exchange");
});

await test("listMessages(sessionId) returns all messages for session", async () => {
  const r = memory.listMessages(testSessionId);
  assert(r.ok, r.error);
  assert(Array.isArray(r.data) && r.data.length >= 4, "expected >=4 messages");
});

await test("upsertCronJob with ON CONFLICT(name) upserts cleanly", async () => {
  const r1 = memory.upsertCronJob({
    name: "test-job", expression: "* * * * *",
    skillName: "web-search", inputs: { query: "news" }, enabled: false,
  });
  assert(r1.ok, r1.error);
  const id = r1.data.id;
  // Upsert same name — should update expression, keep original id
  const r2 = memory.upsertCronJob({
    name: "test-job", expression: "0 * * * *",
    skillName: "web-search", inputs: { query: "news" }, enabled: false,
  });
  assert(r2.ok, r2.error);
  assert(r2.data.id === id,           "id changed on upsert (should stay same)");
  assert(r2.data.expression === "0 * * * *", "expression not updated on upsert");
});

await test("listCronJobs includes upserted job", async () => {
  const r   = memory.listCronJobs();
  assert(r.ok, r.error);
  const job = r.data.find((j) => j.name === "test-job");
  assert(job !== undefined, "test-job not found");
  assert(job.enabled === false, "should be disabled");
});

await test("setCronJobEnabled toggles enabled flag", async () => {
  const job = memory.listCronJobs().data.find((j) => j.name === "test-job");
  memory.setCronJobEnabled(job.id, true);
  const updated = memory.listCronJobs().data.find((j) => j.name === "test-job");
  assert(updated.enabled === true, "not enabled after toggle");
  memory.setCronJobEnabled(job.id, false); // restore
});

await test("stampCronJobRun sets lastRun ≥ now", async () => {
  const job    = memory.listCronJobs().data.find((j) => j.name === "test-job");
  const before = Date.now();
  const r      = memory.stampCronJobRun(job.id);
  assert(r.ok, r.error);
  // CronJob.lastRun is the mapped field (column: last_run)
  const after = memory.listCronJobs().data.find((j) => j.id === job.id);
  assert(after.lastRun >= before, "lastRun not updated (got: " + after.lastRun + ")");
});

await test("deleteSession cascades messages", async () => {
  const sess = memory.createSession();
  const sid  = sess.data.id;
  memory.writeMessage({ sessionId: sid, role: "user", content: "temp msg" });
  memory.deleteSession(sid);
  const ctx = memory.readContext(sid, 10);
  assert(ctx.data.length === 0, "messages not cascade-deleted");
});

// ═══════════════════════════════════════════════════════════════
// [B] Skill-runner
// ═══════════════════════════════════════════════════════════════
section("B · Skill-runner");

let skills = [];

await test("loadSkills reads 2 built-in skills", async () => {
  const r = skillRunner.loadSkills([SKILLS_DIR]);
  assert(r.ok, r.error);
  skills = r.data;
  assert(skills.length === 2, "expected 2 skills, got " + skills.length);
  const names = skills.map((s) => s.name).sort();
  assert(names[0] === "browser-screenshot", "browser-screenshot missing");
  assert(names[1] === "web-search",         "web-search missing");
});

await test("loadSkills deduplicates — same dir twice = still 2 skills", async () => {
  const r = skillRunner.loadSkills([SKILLS_DIR, SKILLS_DIR]);
  assert(r.ok, r.error);
  assert(r.data.length === 2, "dedup failed, got " + r.data.length);
});

await test("matchSkill('screenshot') → ok(browser-screenshot)", async () => {
  const r = skillRunner.matchSkill("screenshot", skills);
  assert(r.ok, r.error);
  assert(r.data !== null && r.data.name === "browser-screenshot",
    "wrong skill: " + r.data?.name);
});

await test("matchSkill('take a screenshot of the page') → ok(browser-screenshot)", async () => {
  const r = skillRunner.matchSkill("take a screenshot of the page", skills);
  assert(r.ok, r.error);
  assert(r.data !== null && r.data.name === "browser-screenshot",
    "wrong skill: " + r.data?.name);
});

await test("matchSkill('search the web for cats') → ok(web-search)", async () => {
  const r = skillRunner.matchSkill("search the web for cats", skills);
  assert(r.ok, r.error);
  assert(r.data !== null && r.data.name === "web-search",
    "wrong skill: " + r.data?.name);
});

await test("matchSkill('deploy to kubernetes') → ok(null) — no match", async () => {
  // matchSkill returns ok(null) when no trigger matches — not err()
  const r = skillRunner.matchSkill("deploy to kubernetes", skills);
  assert(r.ok, "unexpected err: " + r.error);
  assert(r.data === null, "expected null match, got: " + r.data?.name);
});

await test("getSkillByName — found returns ok(skill)", async () => {
  const r = skillRunner.getSkillByName("browser-screenshot", skills);
  assert(r.ok, r.error);
  assert(r.data !== null && r.data.name === "browser-screenshot", "wrong skill");
});

await test("getSkillByName — not found returns ok(null)", async () => {
  // getSkillByName returns ok(null) for misses — not err()
  const r = skillRunner.getSkillByName("nonexistent", skills);
  assert(r.ok, "expected ok, got err: " + r.error);
  assert(r.data === null, "expected null for nonexistent skill");
});

await test("validateInputs — valid url passes", async () => {
  const skill = skillRunner.getSkillByName("browser-screenshot", skills).data;
  const r     = skillRunner.validateInputs(skill, { url: "https://example.com" });
  assert(r.ok, r.error);
});

await test("validateInputs — missing required field → err mentioning field name", async () => {
  const skill = skillRunner.getSkillByName("browser-screenshot", skills).data;
  const r     = skillRunner.validateInputs(skill, {});
  assert(!r.ok, "expected err for missing url");
  assert(r.error.toLowerCase().includes("url"), "error should mention 'url'");
});

await test("resolveSkillCall returns { skill, inputs, resolvedSteps }", async () => {
  const skill = skillRunner.getSkillByName("browser-screenshot", skills).data;
  const r     = skillRunner.resolveSkillCall(skill, { url: "https://example.com", full_page: "true" });
  assert(r.ok, r.error);
  // resolveSkillCall returns { skill, inputs, resolvedSteps } — not { content }
  assert(typeof r.data.resolvedSteps === "string", "resolvedSteps should be a string");
  assert(r.data.resolvedSteps.includes("https://example.com"), "{url} not substituted");
  assert(r.data.resolvedSteps.includes("full_page=true"),       "{full_page} not substituted");
  assert(r.data.inputs["url"] === "https://example.com", "inputs.url mismatch");
});

await test("buildSkillsCatalogue returns a non-empty catalogue string", async () => {
  const cat = skillRunner.buildSkillsCatalogue(skills);
  assert(typeof cat === "string" && cat.length > 50, "catalogue too short");
  assert(cat.includes("browser-screenshot"), "missing browser-screenshot");
  assert(cat.includes("web-search"),         "missing web-search");
});

// ═══════════════════════════════════════════════════════════════
// [C] Gateway
// ═══════════════════════════════════════════════════════════════
section("C · Gateway");

await test("initGateway bootstraps config → logger → DB → LLM", async () => {
  memory.closeDb(); // release handle opened in section A
  // Clean up any leftover test DB from previous runs
  try { fs.unlinkSync("/tmp/claw-e2e-test.db"); } catch (_) { /* ok */ }
  const r = await gateway.initGateway(CONFIG_FILE);
  assert(r.ok, JSON.stringify(r));
  // getGatewayStatus() returns { status, error? } — not a string
  assert(gateway.getGatewayStatus().status === "ready",
    "status not 'ready': " + gateway.getGatewayStatus().status);
});

await test("initGateway is idempotent (second call returns ok)", async () => {
  const r = await gateway.initGateway(CONFIG_FILE);
  assert(r.ok, r.error);
  assert(gateway.getGatewayStatus().status === "ready", "status changed on re-init");
});

await test("newSession creates a session via gateway", async () => {
  const r = await gateway.newSession();
  assert(r.ok, r.error);
  assert(typeof r.data.id === "string" && r.data.id.length > 0, "session id missing");
});

await test("listRecentSessions returns array of sessions", async () => {
  const r = await gateway.listRecentSessions(5);
  assert(r.ok, r.error);
  assert(Array.isArray(r.data) && r.data.length >= 1, "expected >=1 sessions");
});

await test("removeSession deletes session from DB", async () => {
  const created = await gateway.newSession();
  assert(created.ok, created.error);
  const id  = created.data.id;
  const r   = await gateway.removeSession(id);
  assert(r.ok, r.error);
  const all = await gateway.listRecentSessions(100);
  assert(!all.data.find((s) => s.id === id), "session still in list after remove");
});

await test("shutdownGateway sets status to 'stopped'", async () => {
  await gateway.shutdownGateway();
  assert(gateway.getGatewayStatus().status === "stopped",
    "not stopped: " + gateway.getGatewayStatus().status);
});

// ═══════════════════════════════════════════════════════════════
// [D] Cron manager
// ═══════════════════════════════════════════════════════════════
section("D · Cron manager");

await test("re-init DB for cron tests", async () => {
  const r = memory.initDb(DB_FILE);
  assert(r.ok, r.error);
});

await test("createCronManager returns a manager object", async () => {
  const mgr = cronPkg.createCronManager();
  for (const fn of ["start", "stop", "upsertJob", "removeJob", "listRunning"]) {
    assert(typeof mgr[fn] === "function", fn + " not a function");
  }
});

await test("start() with no enabled jobs → listRunning is empty", async () => {
  const mgr  = cronPkg.createCronManager();
  const jobs = memory.listCronJobs().data;
  for (const j of jobs) memory.setCronJobEnabled(j.id, false);
  const r = await mgr.start(skills);
  assert(r.ok, r.error);
  assert(mgr.listRunning().length === 0, "expected no running jobs");
  await mgr.stop();
});

await test("upsertJob(disabled=false) does not schedule", async () => {
  const mgr = cronPkg.createCronManager();
  await mgr.start(skills);
  const r = await mgr.upsertJob(
    { name: "test-disabled", expression: "* * * * *",
      skillName: "web-search", inputs: { query: "test" }, enabled: false },
    skills
  );
  assert(r.ok, r.error);
  assert(mgr.listRunning().length === 0, "disabled job should not be running");
  await mgr.stop();
});

await test("upsertJob(enabled=true) schedules the job", async () => {
  const mgr = cronPkg.createCronManager();
  await mgr.start(skills);
  const r = await mgr.upsertJob(
    { name: "test-enabled", expression: "* * * * *",
      skillName: "web-search", inputs: { query: "test" }, enabled: true },
    skills
  );
  assert(r.ok, r.error);
  const running = mgr.listRunning();
  assert(running.length === 1, "expected 1 running job, got " + running.length);
  assert(running[0].name === "test-enabled", "wrong job name: " + running[0].name);
  await mgr.stop();
  assert(mgr.listRunning().length === 0, "stop() didn't clear running jobs");
});

await test("removeJob stops + disables job in DB", async () => {
  const mgr  = cronPkg.createCronManager();
  await mgr.start(skills);
  const job  = memory.listCronJobs().data.find((j) => j.name === "test-enabled");
  assert(job !== undefined, "test-enabled not found in DB");
  const r = await mgr.removeJob(job.id);
  assert(r.ok, r.error);
  assert(mgr.listRunning().length === 0, "still running after remove");
  const check = memory.listCronJobs().data.find((j) => j.id === job.id);
  assert(!check || check.enabled === false, "not disabled in DB after remove");
  await mgr.stop();
});

// ═══════════════════════════════════════════════════════════════
// [E] Browser — Puppeteer navigate + screenshot
// ═══════════════════════════════════════════════════════════════
section("E · Browser (Puppeteer)");

const CHROME_PATHS = [
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  process.env["PUPPETEER_EXECUTABLE_PATH"],
].filter(Boolean);

const chromePath = CHROME_PATHS.find((p) => {
  try { return fs.existsSync(p); } catch { return false; }
});

if (!chromePath) {
  skip("launchBrowser",                   "Chrome/Chromium not found in standard paths");
  skip("navigate to https://example.com", "Chrome not available");
  skip("snapshot returns elements",       "Chrome not available");
  skip("screenshot returns base64 PNG",   "Chrome not available");
  skip("closeBrowser",                    "Chrome not available");
} else {
  await test("launchBrowser with detected Chrome", async () => {
    const r = await browserPkg.launchBrowser({ headless: true, executablePath: chromePath });
    assert(r.ok, r.error);
  });

  await test("navigate to https://example.com", async () => {
    const r = await browserPkg.navigate("https://example.com");
    assert(r.ok, r.error);
    assert(r.data.url.includes("example.com"), "url mismatch: " + r.data.url);
  });

  await test("snapshot returns SnapshotElements", async () => {
    const r = await browserPkg.snapshot();
    assert(r.ok, r.error);
    assert(typeof r.data.title === "string",  "title not a string");
    assert(Array.isArray(r.data.elements),     "elements not an array");
    assert(r.data.elements.length > 0,         "elements array is empty");
  });

  await test("screenshot returns valid base64 PNG", async () => {
    const r = await browserPkg.screenshot({ fullPage: false });
    assert(r.ok, r.error);
    assert(r.data.mimeType === "image/png", "mimeType: " + r.data.mimeType);
    assert(typeof r.data.base64 === "string" && r.data.base64.length > 100,
      "base64 too short");
    // Verify PNG magic bytes: 89 50 4E 47
    const buf = Buffer.from(r.data.base64, "base64");
    assert(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47,
      "not a valid PNG (magic bytes mismatch)");
  });

  await test("closeBrowser cleans up singleton", async () => {
    const r = await browserPkg.closeBrowser();
    assert(r.ok, r.error);
  });
}

// ─────────────────────────────────────────────────────────────────────────
} // end main()
// ─────────────────────────────────────────────────────────────────────────

main()
  .catch((err) => {
    console.error(C.red("\nUnhandled error in test runner:"), err.message);
    process.exit(1);
  })
  .finally(() => {
    // Cleanup
    try { memory.closeDb(); } catch (_) {}
    try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch (_) {}
    try { fs.unlinkSync("/tmp/claw-e2e-test.db"); } catch (_) {}

    // Summary
    console.log("\n" + "─".repeat(52));
    console.log(
      C.bold("Results: ") +
      C.green(passed + " passed") + "  " +
      (failed  > 0 ? C.red(failed   + " failed")  : C.dim("0 failed"))  + "  " +
      (skipped > 0 ? C.yellow(skipped + " skipped") : C.dim("0 skipped"))
    );

    if (failures.length > 0) {
      console.log("\n" + C.red(C.bold("Failures:")));
      for (const f of failures) {
        console.log("  " + C.red("✗") + " " + f.label);
        console.log("    " + C.dim(f.error));
      }
    }
    console.log("");

    process.exit(failed > 0 ? 1 : 0);
  });
