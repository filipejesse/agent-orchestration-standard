// Anti-cheat / integrity fields in /api/goals(+/:id): read per docs/orch-state-contract.md; old goals without them stay clean/empty.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FIXTURES, tmpDir, startMonitor } from './harness.mjs';

const TMP = tmpDir('aos-moninteg-'); let M;
const put = (fx, id) => fs.cpSync(path.join(FIXTURES, fx, 'goals', id), path.join(TMP, 'orch', 'goals', id), { recursive: true });
before(async () => {
  fs.mkdirSync(path.join(TMP, 'orch', 'goals'), { recursive: true }); fs.mkdirSync(path.join(TMP, 'live'));
  put('integrity', 'g-integ'); put('escalation', 'g-esc');
  // junk shapes must never throw
  put('escalation', 'g-esc'); fs.cpSync(path.join(TMP, 'orch', 'goals', 'g-esc'), path.join(TMP, 'orch', 'goals', 'g-junk'), { recursive: true });
  const tf = path.join(TMP, 'orch', 'goals', 'g-junk', 'tasks.json'), t = JSON.parse(fs.readFileSync(tf, 'utf8'));
  t[0].orch.attempt_log[0].anticheat = 'x'; t[0].orch.attempt_log[1].anticheat = { status: 5, findings: 'no' }; t[0].orch.attempt_log[1].self_checks = 7; t[0].orch.attempt_log[1].stderr_tail = 42;
  fs.writeFileSync(tf, JSON.stringify(t));
  const gf = path.join(TMP, 'orch', 'goals', 'g-junk', 'goal.json'), g = JSON.parse(fs.readFileSync(gf, 'utf8')); g.orch.protected_result = 'bad'; g.orch.review = []; fs.writeFileSync(gf, JSON.stringify(g));
  M = await startMonitor({ orch: path.join(TMP, 'orch'), live: path.join(TMP, 'live') });
});
after(async () => { await M.stop(); fs.rmSync(TMP, { recursive: true, force: true }); });
const detail = async (id) => (await M.get('/api/goals/' + id)).json.goal;

test('attempt integrity: failed + warning reasons, self-checks, version mismatch', async () => {
  const d = await detail('g-integ'), t = d.tasks[0], [a1, a2] = t.attempt_log;
  assert.deepEqual(a1.integrity, { status: 'failed', reasons: ['tests_weakened', 'vacuous_pass'] });
  assert.deepEqual(a2.integrity, { status: 'warning', reasons: ['literal_copy'] });
  assert.equal(a1.self_checks, 2); assert.equal(a2.self_checks, 1); assert.equal(t.self_checks, 3);
  assert.equal(a1.version_mismatch, false); assert.equal(a2.version_mismatch, true); assert.equal(t.version_mismatch, true);
  assert.equal(d.claude_version_start, '2.1.100 (Claude Code)');
  assert.equal(t.integrity.status, 'failed');
});

test('goal roll-up, protected tests, reviewer notes, events', async () => {
  const d = await detail('g-integ');
  assert.equal(d.integrity.status, 'failed'); assert.equal(d.integrity.failed_attempts, 1); assert.equal(d.integrity.warning_attempts, 1);
  assert.equal(d.integrity.kinds.tests_weakened, 1); assert.equal(d.integrity.kinds.literal_copy, 1);
  assert.deepEqual(d.protected_tests, { ok: true, files: 2, not_executed: 0, kind: null, output: null });
  assert.equal(d.review.tier, 'haiku'); assert.ok(d.review.text.includes('scope looks fine'));
  const types = d.last_events.map((e) => e.type);
  assert.ok(types.filter((x) => x === 'orch.check.self_run').length === 2 && types.includes('orch.anticheat.failed'));
  assert.ok(d.last_events.some((e) => e.type === 'orch.anticheat.failed' && /tests_weakened/.test(e.text)));
  const l = (await M.get('/api/goals')).json.goals.find((g) => g.id === 'g-integ'); assert.equal(l.integrity.status, 'failed');
});

test('stderr tail is scrubbed of paths and kept as plain text', async () => {
  const s = (await detail('g-integ')).tasks[0].attempt_log[0].stderr_tail;
  assert.ok(s.includes('worker crashed') && !s.includes('/Users/') && s.includes('<img src=x'));
});

test('old goals and junk shapes: clean, empty, never throw', async () => {
  for (const id of ['g-esc', 'g-junk']) {
    const r = await M.get('/api/goals/' + id); assert.equal(r.status, 200, id); const d = r.json.goal;
    assert.equal(d.integrity.status, 'clean'); assert.equal(d.protected_tests, null); assert.equal(d.review, null);
    assert.equal(d.tasks[0].integrity, null); assert.equal(d.tasks[0].version_mismatch, false);
  }
  const e = await detail('g-esc'); assert.equal(e.integrity.checked, false); assert.equal(e.tasks[0].self_checks, 0); assert.equal(e.tasks[0].attempt_log[0].self_checks, null);
});

test('failed protected-test re-run and worktree mutation mark the goal failed', async () => {
  const gf = path.join(TMP, 'orch', 'goals', 'g-junk', 'goal.json'), g = JSON.parse(fs.readFileSync(gf, 'utf8'));
  g.orch.protected_result = { ok: false, files: 1, not_executed: [], kind: 'tests_reduced', output: 'anti-cheat tests_reduced: 3 < 5' }; fs.writeFileSync(gf, JSON.stringify(g));
  const tf = path.join(TMP, 'orch', 'goals', 'g-junk', 'tasks.json'), t = JSON.parse(fs.readFileSync(tf, 'utf8')); t[0].orch.attempt_log[0].outcome = 'worktree_mutated_during_checks'; fs.writeFileSync(tf, JSON.stringify(t));
  await new Promise((r) => setTimeout(r, 1200));
  const d = await detail('g-junk');
  assert.equal(d.integrity.status, 'failed'); assert.equal(d.protected_tests.ok, false); assert.ok(d.protected_tests.output.includes('tests_reduced'));
  assert.deepEqual(d.tasks[0].attempt_log[0].integrity, { status: 'failed', reasons: ['worktree_mutated_during_checks'] });
});
