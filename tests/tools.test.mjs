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

/** 记录 argv、按预设返回 JSON 的 spawn：用来验证安全策略，不真的开窗口。 */
function scriptedSpawn(respond) {
  const seen = [];
  return (spec) => {
    seen.push(spec.argv);
    const text = JSON.stringify(respond(spec.argv));
    return {
      done: Promise.resolve({ exitCode: 0, signal: null }),
      collected: {
        stdout: { readFrom: () => ({ text, lossy: false, truncated: false }) },
        stderr: { readFrom: () => ({ text: '', lossy: false, truncated: false }) },
      },
    };
  };
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

// 用一个中性的临时目录，别把作者机器上的路径写进公开仓库。
const EXEC = { agent: { session: { header: { cwd: process.cwd() } } } };
const EXPECTED = ['quiet_act', 'quiet_close', 'quiet_launch', 'quiet_park', 'quiet_shot', 'quiet_tree', 'quiet_windows'];

test('注册七个工具', async () => {
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
  assert.deepEqual(tools.get('quiet_launch').parameters.required, []);
  assert.deepEqual(tools.get('quiet_act').parameters.required, ['hwnd', 'op']);
  assert.deepEqual(tools.get('quiet_shot').parameters.required, ['hwnd']);
  assert.deepEqual(tools.get('quiet_park').parameters.required, ['hwnd']);
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
  // 新增：所有可见顶层窗口都要列出来，用户自己开的程序才能被 park / shot 接管。
  assert.ok(Array.isArray(value.windows), 'windows 字段必须存在');
  assert.ok(value.windows.length >= value.offscreen.length, 'windows 是 offscreen 的超集');
});

test('quiet_windows 的渲染里能看到屏幕上的窗口', async () => {
  const { tools, ctx } = harness(failingSpawn());
  const { apply } = await import(MODULE);
  apply(ctx, {});
  const render = tools.get('quiet_windows').output.render;
  const blocks = render({}, {
    ok: true,
    monitors: [[0, 0, 1920, 1080]],
    dpi: 96,
    count: 2,
    foreground: { hwnd: 2, pid: 22, title: '前台示例' },
    offscreen: [{ hwnd: 1, pid: 11, title: '离屏示例', rect: [0, 0, 100, 80], offscreen: true }],
    windows: [
      { hwnd: 1, pid: 11, title: '离屏示例', rect: [0, 0, 100, 80], offscreen: true },
      { hwnd: 3, pid: 33, title: '屏幕上的示例', rect: [10, 10, 300, 200], offscreen: false },
    ],
  });
  const body = blocks.map((b) => b.text ?? '').join('\n');
  assert.match(body, /屏幕上的示例/, '屏幕上的窗口也要渲染出来');
  assert.match(body, /quiet_park/, '要提示怎么接管屏幕上的窗口');
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

test('quiet_park 能把一个已有窗口留在屏幕外（不抢焦点）', async () => {
  const { tools, ctx } = harness(realSpawn);
  const { apply } = await import(MODULE);
  apply(ctx, { launchTimeoutMs: 60000 });
  const launched = await tools.get('quiet_launch').execute({ exe: 'charmap.exe', width: 700, height: 600 }, EXEC);
  assert.equal(launched.ok, true);
  try {
    const parked = await tools.get('quiet_park').execute({ hwnd: launched.hwnd }, EXEC);
    assert.equal(parked.ok, true, JSON.stringify(parked));
    assert.equal(parked.offscreen, true, 'park 之后必须在所有显示器之外');
    assert.ok(Array.isArray(parked.after) && parked.after.length === 4);
  } finally {
    await tools.get('quiet_close').execute({ hwnd: launched.hwnd, kill: true }, EXEC);
  }
});

test('exe 和 url 都不给时给出能看懂的报错', async () => {
  const { tools, ctx } = harness(failingSpawn());
  const { apply } = await import(MODULE);
  apply(ctx, {});
  await assert.rejects(
    () => tools.get('quiet_launch').execute({}, EXEC),
    /exe 和 url 至少要给一个/,
  );
});

test('预览网页：只给 url 就能离屏打开并截图', async () => {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const dir = mkdtempSync(join(tmpdir(), 'quiet-page-'));
  const page = join(dir, 'page.html');
  writeFileSync(page, '<!doctype html><meta charset="utf-8"><title>quiet preview</title>'
    + '<body style="margin:0;background:#123456;color:#fff;font:40px sans-serif">'
    + '<h1>quiet-windows preview</h1></body>', 'utf8');

  const { tools, ctx } = harness(realSpawn);
  const { apply } = await import(MODULE);
  apply(ctx, { launchTimeoutMs: 90000 });
  const url = 'file:///' + page.replace(/\\/g, '/');

  const launched = await tools.get('quiet_launch').execute({ url, width: 1000, height: 700 }, EXEC);
  assert.equal(launched.ok, true, JSON.stringify(launched));
  assert.equal(launched.offscreen, true, '浏览器窗口必须在屏幕外');
  try {
    const shot = await tools.get('quiet_shot').execute({ hwnd: launched.hwnd }, EXEC);
    assert.equal(shot.ok, true, JSON.stringify(shot));
    assert.notEqual(shot.looks_blank, true, '页面应该真的渲染出来了');
  } finally {
    await tools.get('quiet_close').execute({ hwnd: launched.hwnd, kill: true }, EXEC);
  }
});

test('用户自己的窗口：kill=true 也不会去结束进程', async () => {
  const seen = [];
  const spawn = scriptedSpawn((argv) => {
    seen.push(argv);
    if (argv.includes('list')) {
      return {
        ok: true, monitors: [[0, 0, 1920, 1080]], dpi: 96, count: 1,
        foreground: { hwnd: 2, pid: 22, title: 'x' },
        windows: [{ hwnd: 1234, pid: 4321, title: '用户自己的记事本', rect: [0, 0, 10, 10], offscreen: false }],
        offscreen: [],
      };
    }
    return { ok: true, closed: false, window: { hwnd: 1234, pid: 4321 } };
  });
  const { tools, ctx } = harness(spawn);
  const { apply } = await import(MODULE);
  apply(ctx, {});

  await tools.get('quiet_windows').execute({}, EXEC);
  const closed = await tools.get('quiet_close').execute({ hwnd: 1234, kill: true }, EXEC);

  const closeArgv = seen.filter((argv) => argv.includes('close')).at(-1);
  assert.ok(closeArgv, '应该调用了 close');
  assert.equal(hasFlag(closeArgv, '--kill'), false, '用户窗口不允许 --kill');
  assert.match(closeArgv.join(' '), /--expect-pid 4321/, '仍要带上 pid 做句柄复用校验');
  assert.match(String(closed.kill_skipped), /不是本插件启动/, '要说明为什么没强杀');
});

test('本插件启动的窗口：kill=true 才会真的带 --kill', async () => {
  const seen = [];
  const spawn = scriptedSpawn((argv) => {
    seen.push(argv);
    if (argv.includes('launch')) {
      return {
        ok: true, hwnd: 777, pid: 888, proc_pid: 888, offscreen: true,
        owned: true, shared_process: false, isolated_profile: null,
      };
    }
    return { ok: true, closed: true, killed: true, kill_verified: true };
  });
  const { tools, ctx } = harness(spawn);
  const { apply } = await import(MODULE);
  apply(ctx, { launchTimeoutMs: 60000 });

  await tools.get('quiet_launch').execute({ exe: 'charmap.exe' }, EXEC);
  await tools.get('quiet_close').execute({ hwnd: 777, kill: true }, EXEC);

  const closeArgv = seen.filter((argv) => argv.includes('close')).at(-1);
  assert.ok(closeArgv, '应该调用了 close');
  assert.equal(hasFlag(closeArgv, '--kill'), true, '自己启动的进程允许强杀');
});

test('park 不认识的句柄会被拒绝（防句柄复用动错窗口）', async () => {
  const spawn = scriptedSpawn(() => ({ ok: true }));
  const { tools, ctx } = harness(spawn);
  const { apply } = await import(MODULE);
  apply(ctx, {});
  await assert.rejects(
    () => tools.get('quiet_park').execute({ hwnd: 55555 }, EXEC),
    /没有记录进程 id/,
  );
});

test('启动记录：launch 会带上 --journal，失败时补一次 reap', async () => {
  const seen = [];
  let failed = false;
  const spawn = scriptedSpawn((argv) => {
    seen.push(argv);
    if (argv.includes('launch')) {
      failed = true;
      return { ok: false, error: '等待窗口超时' };
    }
    return { ok: true, reaped: true };
  });
  const { tools, ctx } = harness(spawn);
  const { apply } = await import(MODULE);
  apply(ctx, { launchTimeoutMs: 60000 });

  const result = await tools.get('quiet_launch').execute({ exe: 'charmap.exe' }, EXEC);
  assert.equal(result.ok, false);

  const launchArgv = seen.find((argv) => argv.includes('launch'));
  assert.ok(launchArgv.includes('--journal'), 'launch 必须带 --journal');
  const reapArgv = seen.find((argv) => argv.includes('reap'));
  assert.ok(reapArgv, '启动失败后要补一刀 reap');
  assert.equal(failed, true);
  const journalArg = launchArgv[launchArgv.indexOf('--journal') + 1];
  assert.equal(reapArgv[reapArgv.indexOf('--journal') + 1], journalArg, 'reap 要用同一份启动记录');
});
