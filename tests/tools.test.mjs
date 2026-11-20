/**
 * 不开窗口的插件层测试。
 *
 *   node --test tests/
 *
 * 覆盖：工具注册数量与取值、schema 完整性、render 对成功/失败结果的容错、
 * 以及「找不到可用 Python」时是否给出能照做的错误。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

const MODULE = new URL('../index.js', import.meta.url).href;

function harness(spawnImpl) {
  const tools = new Map();
  const ctx = {
    subprocess: { spawn: spawnImpl },
    tools: {
      register(def) {
        tools.set(def.name, def);
        return () => tools.delete(def.name);
      },
    },
    effect() {},
  };
  return { tools, ctx };
}

/** 永远失败的 spawn：模拟「这台机器没有装好依赖的 Python」。 */
function failingSpawn() {
  return () => ({
    done: Promise.resolve({ exitCode: 1, signal: null }),
    collected: {
      stdout: { readFrom: () => ({ text: '', lossy: false, truncated: false }) },
      stderr: {
        readFrom: () => ({
          text: 'ModuleNotFoundError: No module named win32gui',
          lossy: false,
          truncated: false,
        }),
      },
    },
  });
}

/** 真跑子进程的 spawn，用来验证成功路径。 */
function realSpawn(spec) {
  const [cmd, ...args] = spec.argv;
  const child = spawn(cmd, args, { cwd: spec.cwd, windowsHide: true });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ exitCode: code, signal: null })));
  return {
    done,
    collected: {
      stdout: { readFrom: () => ({ text: out, lossy: false, truncated: false }) },
      stderr: { readFrom: () => ({ text: err, lossy: false, truncated: false }) },
    },
  };
}

// 用一个中性的临时目录，别把作者机器上的路径写进公开仓库。
const EXEC = { agent: { session: { header: { cwd: process.cwd() } } } };
const EXPECTED = ['quiet_act', 'quiet_close', 'quiet_launch', 'quiet_shot', 'quiet_tree', 'quiet_windows'];

test('注册六个工具', async () => {
  const { tools, ctx } = harness(failingSpawn());
  const { apply } = await import(MODULE);
  apply(ctx, {});
  assert.deepEqual([...tools.keys()].sort(), EXPECTED);
});

test('每个工具的 schema 与 render 都完整', async () => {
  const { tools, ctx } = harness(failingSpawn());
  const { apply } = await import(MODULE);
  apply(ctx, {});
  for (const name of EXPECTED) {
    const def = tools.get(name);
    assert.equal(typeof def.description, 'string');
    assert.ok(def.description.length > 10, name + ' 缺少描述');
    assert.equal(def.parameters.type, 'object');
    assert.equal(typeof def.output.render, 'function');
    const blocks = def.output.render({}, { ok: false, error: '测试用错误' });
    assert.ok(Array.isArray(blocks) && blocks.length > 0, name + ' render 没有返回内容');
    assert.equal(blocks[0].type, 'text');
    assert.match(blocks[0].text, /测试用错误/, name + ' 没有把错误带出来');
  }
});

test('必需参数被写进 required', async () => {
  const { tools, ctx } = harness(failingSpawn());
  const { apply } = await import(MODULE);
  apply(ctx, {});
  assert.deepEqual(tools.get('quiet_launch').parameters.required, ['exe']);
  assert.deepEqual(tools.get('quiet_act').parameters.required, ['hwnd', 'op']);
  assert.deepEqual(tools.get('quiet_shot').parameters.required, ['hwnd']);
  assert.equal(tools.get('quiet_windows').parameters.required, undefined);
});

test('Python 依赖缺失时给出可照做的错误', async () => {
  const { tools, ctx } = harness(failingSpawn());
  const { apply } = await import(MODULE);
  apply(ctx, {});
  const tool = tools.get('quiet_windows');
  await assert.rejects(
    () => tool.execute({}, EXEC),
    (error) => {
      assert.match(error.message, /pywin32/, '错误里要写明缺哪个依赖');
      assert.match(error.message, /pythonPath/, '错误里要给出配置入口');
      assert.match(error.message, /已尝试/, '错误里要列出试过哪些解释器');
      return true;
    },
  );
});

/** 复刻宿主行为：cwd 不是字符串就在 spawn 内部抛错（0.2.0 的真实故障点）。 */
function strictSpawn(spec) {
  if (typeof spec.cwd !== 'string' || spec.cwd === '') {
    throw new TypeError("Cannot read properties of undefined (reading 'includes')");
  }
  return realSpawn(spec);
}

test('探测解释器时 cwd 必须是字符串（宿主契约）', async () => {
  const { tools, ctx } = harness(strictSpawn);
  const { apply } = await import(MODULE);
  apply(ctx, {});
  // 解析成功就说明探测调用带上了合法 cwd；否则 strictSpawn 会抛错并让工具失败。
  const value = await tools.get('quiet_windows').execute({}, EXEC);
  assert.equal(value.ok, true);
});

test('真实环境下能找到 Python 并列出屏幕外窗口', async () => {
  const { tools, ctx } = harness(realSpawn);
  const { apply } = await import(MODULE);
  apply(ctx, {});
  const value = await tools.get('quiet_windows').execute({}, EXEC);
  assert.equal(value.ok, true);
  assert.ok(Array.isArray(value.monitors) && value.monitors.length >= 1);
  assert.ok(Array.isArray(value.offscreen));
});

test('launch → close 全链路可用（离屏，全程不碰桌面）', async () => {
  const { tools, ctx } = harness(realSpawn);
  const { apply } = await import(MODULE);
  apply(ctx, { launchTimeoutMs: 60000 });
  const tool = tools.get('quiet_launch');
  assert.equal(tool.timeoutMs, 60000);
  const value = await tool.execute({ exe: 'charmap.exe', width: 640, height: 560 }, EXEC);
  assert.equal(value.ok, true);
  assert.equal(value.offscreen, true);
  assert.equal(value.process_mismatch, false, '窗口应属于本次启动的进程');
  assert.ok(Number.isInteger(value.pid));
  const closed = await tools.get('quiet_close').execute({ hwnd: value.hwnd }, EXEC);
  assert.equal(closed.closed, true);
});
