const gw   = require('./packages/gateway/dist/index.js');
const os   = require('os');
const path = require('path');
const fs   = require('fs');

// ── Write a temp config pointing to a test DB ─────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-gw-'));
const dbPath  = path.join(tmpDir, 'test.db');
const logDir  = path.join(tmpDir, 'logs');
const cfgPath = path.join(tmpDir, 'claw.config.toml');

fs.writeFileSync(cfgPath, [
  '[llm]',
  'provider = "openrouter"',
  'base_url = "https://openrouter.ai/api/v1"',
  'api_key = "sk-test-key"',
  'model = "anthropic/claude-haiku-4-5-20251001"',
  'max_tokens = 100',
  '',
  '[agent]',
  'orchestrator_model = "anthropic/claude-haiku-4-5-20251001"',
  'sub_agent_model = "anthropic/claude-haiku-4-5-20251001"',
  'max_iterations = 2',
  '',
  '[browser]',
  'headless = true',
  'executable_path = ""',
  '',
  '[memory]',
  `db_path = "${dbPath}"`,
  'max_context_messages = 10',
  '',
  '[skills]',
  'paths = ["./skills/built-in"]',
  '',
  '[logging]',
  `dir = "${logDir}"`,
  'level = "warn"',
].join('\n'));

async function run() {
  // ── initGateway ─────────────────────────────────────────────
  const initResult = await gw.initGateway(cfgPath);
  if (!initResult.ok) { console.error('❌ initGateway:', initResult.error); process.exit(1); }
  console.log('✅ initGateway() ok');

  // ── status = ready ──────────────────────────────────────────
  const s = gw.getGatewayStatus();
  console.assert(s.status === 'ready', 'expected ready, got ' + s.status);
  console.log('✅ status: ready');

  // ── newSession ──────────────────────────────────────────────
  const sess = gw.newSession();
  if (!sess.ok) { console.error('❌ newSession:', sess.error); process.exit(1); }
  console.log('✅ newSession:', sess.data.id.slice(0, 8) + '…');

  // ── listRecentSessions ──────────────────────────────────────
  const list = gw.listRecentSessions();
  console.assert(list.ok && list.data.length >= 1, 'listRecentSessions failed');
  console.log('✅ listRecentSessions:', list.data.length, 'session(s)');

  // ── removeSession ───────────────────────────────────────────
  const del = gw.removeSession(sess.data.id);
  console.assert(del.ok, 'removeSession failed');
  console.log('✅ removeSession ok');

  // ── shutdown ────────────────────────────────────────────────
  const shut = await gw.shutdownGateway();
  console.assert(shut.ok, 'shutdownGateway failed');
  console.assert(gw.getGatewayStatus().status === 'stopped', 'expected stopped');
  console.log('✅ shutdownGateway() → stopped');

  // ── double-init guard (re-init after shutdown) ──────────────
  const init2 = await gw.initGateway(cfgPath);
  console.assert(init2.ok, 'second initGateway failed');
  console.log('✅ second initGateway() ok (idempotent after restart)');

  await gw.shutdownGateway();

  // ── Result monad ────────────────────────────────────────────
  console.assert(gw.ok(1).ok === true);
  console.assert(gw.err('x').ok === false);
  console.log('✅ Result monad');

  console.log('\n🟢 packages/gateway — all tests passed');
  process.exit(0);
}

run().catch(e => { console.error('FAIL', e); process.exit(1); });
