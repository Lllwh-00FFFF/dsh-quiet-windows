/**
 * dsh-quiet-windows —— 让 agent 在屏幕外「安静地」操作 GUI。
 *
 * 全部动作走 helper/quietwin.py（Python + pywin32 + uiautomation）：
 * 窗口先隐藏启动、摆到所有显示器之外、再用 SW_SHOWNOACTIVATE 显示，
 * 之后用 UI Automation 读写控件、用 PrintWindow 截图（不吃遮挡、不怕离屏）。
 *
 * 为什么不用坐标点击：离屏窗口的坐标落在虚拟屏幕之外，光标会被夹回来；
 * 而且 175% 缩放下坐标换算一旦不感知 DPI 就整体偏 1.75 倍。控件模式绕开这两件事。
 *
 * @module dsh-quiet-windows
 */
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';

export const name = 'quiet-windows';
export const inject = ['subprocess', 'tools'];

const HELPER = fileURLToPath(new URL('./helper/quietwin.py', import.meta.url));
const STDOUT_LIMIT = 4 * 1024 * 1024;

const DEFAULTS = {
  pythonPath: 'python',
  graceMs: 3000,
  timeoutMs: 120000,
  launchTimeoutMs: 180000,
};

/** 会话工作目录：截图等产物写在这里，便于后续读取。 */
function sessionCwd(exec) {
  try {
    const cwd = exec?.agent?.session?.header?.cwd;
    if (typeof cwd === 'string' && cwd !== '') return cwd;
  } catch {
    /* ignore */
  }
  return process.cwd();
}

function asRecord(value) {
  return value !== null && typeof value === 'object' ? value : {};
}

function optionalString(args, key) {
  const value = args[key];
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function requiredNumber(args, key, label) {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  throw new Error(label + '（参数 ' + key + '）必须是窗口句柄数字。先用 quiet_windows 或 quiet_launch 拿到 hwnd。');
}

function optionalNumber(args, key) {
  const value = args[key];
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  return undefined;
}

const OBJECT_SCHEMA = { type: 'object', additionalProperties: true };

function text(lines) {
  return [{ type: 'text', text: lines.join('\n') }];
}

// ---------------------------------------------------------------- python 解析
// 插件跑的 Python 必须同时具备 pywin32 / uiautomation / comtypes / Pillow。
// DSH 自带的运行时 Python 只有 Pillow，没有 pywin32 —— 所以不能盲信一个 "python"。
const PY_PROBE = 'import sys, win32gui, uiautomation, comtypes, PIL; print("OK", sys.version.split()[0])';

/** 按优先级列出候选解释器；prefix 是放在脚本前面的固定参数（py 需要 -3）。重复项去掉。 */
function pythonCandidates(cfg) {
  const raw = [];
  const configured = typeof cfg.pythonPath === 'string' ? cfg.pythonPath.trim() : '';
  if (configured !== '') raw.push({ cmd: configured, prefix: [] });
  raw.push({ cmd: 'python', prefix: [] });
  raw.push({ cmd: 'py', prefix: ['-3'] });
  const local = process.env.LOCALAPPDATA;
  if (local) {
    for (const v of ['Python313', 'Python312', 'Python311', 'Python310']) {
      raw.push({ cmd: join(local, 'Programs', 'Python', v, 'python.exe'), prefix: [] });
    }
  }
  for (const v of ['Python313', 'Python312', 'Python311', 'Python310']) {
    raw.push({ cmd: 'C:\\' + v + '\\python.exe', prefix: [] });
  }
  const seen = new Set();
  return raw.filter((cand) => {
    const key = cand.cmd + '\u0000' + cand.prefix.join(',');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 收一个短命令的全部输出。用于探测解释器，不解析 JSON。
 * 失败（ENOENT、超时）一律返回 ok:false，交给调用方换下一个候选。
 *
 * 注意 cwd 必须是字符串：宿主的 subprocess.spawn 会拿它做校验，传 undefined 会在
 * spawn 内部直接抛 "Cannot read properties of undefined (reading 'includes')"。
 */
async function collect(ctx, cfg, argv, timeoutMs, cwd) {
  const workdir = typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const handle = ctx.subprocess.spawn({
      argv,
      cwd: workdir,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 64 * 1024 },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 1500,
      signal: controller.signal,
    });
    const outcome = await handle.done;
    return {
      code: outcome.exitCode,
      stdout: handle.collected.stdout?.readFrom(0)?.text ?? '',
      stderr: handle.collected.stderr?.readFrom(0)?.text ?? '',
    };
  } catch (error) {
    return { code: null, stdout: '', stderr: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

let pythonCache = null;

/**
 * 找一个能跑本 helper 的 Python，并缓存。
 * 全部候选都失败时抛一条能直接照做的错误，而不是让工具在第一次调用时才莫名其妙失败。
 */
async function resolvePython(ctx, cfg, cwd) {
  if (pythonCache !== null) return pythonCache;
  const tried = [];
  for (const cand of pythonCandidates(cfg)) {
    const probe = await collect(ctx, cfg, [cand.cmd, ...cand.prefix, '-X', 'utf8', '-c', PY_PROBE], 20000, cwd);
    const line = probe.stdout.trim().split(/\r?\n/).filter((l) => l.startsWith('OK')).pop();
    if (line !== undefined) {
      pythonCache = { ...cand, version: line.slice(3).trim() };
      return pythonCache;
    }
    const reason = (probe.stderr.trim().split(/\r?\n/).pop() || '').slice(0, 160)
      || (probe.code === null ? '启动失败或超时' : '退出码 ' + String(probe.code));
    tried.push('  - ' + cand.cmd + (cand.prefix.length > 0 ? ' ' + cand.prefix.join(' ') : '') + ' → ' + reason);
  }
  throw new Error([
    '找不到可用的 Python：需要一个同时装有 pywin32、uiautomation、comtypes、Pillow 的解释器。',
    '已尝试：',
    ...tried,
    '修复方式（任选其一）：',
    '  1. 用 pip 装依赖：<那个 python> -m pip install pywin32 uiautomation comtypes pillow',
    '  2. 在 profile 的 cordis.patch.yml 里给 quiet-windows 配 pythonPath 指向一个装好依赖的解释器（注意：DSH 自带的运行时 Python 没有 pywin32，不能用）。',
  ].join('\n'));
}

/** hwnd → 我们启动时记录的进程信息，用来防句柄复用和误杀。 */
const knownWindows = new Map();

/**
 * 跑一次 helper，返回解析后的 JSON。
 * 输出统一走 stdout 的 JSON；退出码非零时把 stdout 里的 error 也带出来，不吞信息。
 */
async function runHelper(ctx, cfg, argv, options) {
  const py = await resolvePython(ctx, cfg, options.cwd);
  const timeoutMs = options.timeoutMs ?? cfg.timeoutMs;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('quietwin 超时（' + timeoutMs + 'ms）')), timeoutMs);
  const signal = options.signal === undefined
    ? controller.signal
    : AbortSignal.any([options.signal, controller.signal]);
  let handle;
  try {
    handle = ctx.subprocess.spawn({
      argv: [py.cmd, ...py.prefix, '-X', 'utf8', HELPER, ...argv, '--json'],
      cwd: typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: STDOUT_LIMIT },
        stderr: { maxBytes: STDOUT_LIMIT },
      },
      graceMs: cfg.graceMs,
      signal,
    });
    const outcome = await handle.done;
    if (signal.aborted === true) throw signal.reason;
    const out = handle.collected.stdout?.readFrom(0)?.text ?? '';
    const err = handle.collected.stderr?.readFrom(0)?.text ?? '';
    const trimmed = out.trim();
    if (trimmed === '') {
      throw new Error('quietwin 没有输出（退出码 ' + String(outcome.exitCode ?? 'null') + '）：' + (err.trim().split(/\r?\n/).slice(-4).join(' | ') || '无 stderr'));
    }
    let parsed;
    try {
      parsed = JSON.parse(trimmed.slice(trimmed.indexOf('{')));
    } catch {
      throw new Error('quietwin 输出不是 JSON：' + trimmed.slice(0, 300));
    }
    parsed._python = py.cmd + ' ' + py.version;
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/** 给操作类命令补上 expect-pid：句柄被复用时 helper 会直接拒绝，而不是操作到别的窗口。 */
function withExpectedPid(argv, hwnd) {
  const known = knownWindows.get(hwnd);
  if (known === undefined || !Number.isInteger(known.pid)) return argv;
  return [...argv, '--expect-pid', String(known.pid)];
}

function failText(value, fallback) {
  const rec = asRecord(value);
  const message = typeof rec.error === 'string' && rec.error !== '' ? rec.error : fallback;
  return '失败：' + message;
}

/** 一个窗口一行。 */
function windowLine(w) {
  const rec = asRecord(w);
  const rect = Array.isArray(rec.rect) ? rec.rect : [];
  const size = rect.length === 4 ? (rect[2] - rect[0]) + 'x' + (rect[3] - rect[1]) : '?';
  const tags = [];
  if (rec.offscreen === true) tags.push('屏幕外');
  if (rec.minimized === true) tags.push('已最小化');
  if (rec.visible === false) tags.push('不可见');
  const flag = tags.length > 0 ? ' [' + tags.join('，') + ']' : '';
  return '- hwnd ' + rec.hwnd + ' · pid ' + rec.pid + ' · ' + size + flag + '\n  ' + (rec.title || '(无标题)');
}

/** 把 UIA 控件树渲染成缩进文本，省略超量节点。 */
function renderTree(items, limit = 200) {
  const list = Array.isArray(items) ? items : [];
  const lines = [];
  for (const raw of list.slice(0, limit)) {
    const item = asRecord(raw);
    const depth = typeof item.path === 'string' ? item.path.split('.').length - 1 : 0;
    const pats = Array.isArray(item.patterns) && item.patterns.length > 0
      ? ' {' + item.patterns.join(',') + '}'
      : '';
    const ident = item.auto_id ? ' id=' + item.auto_id : '';
    const klass = item.class ? ' class=' + item.class : '';
    lines.push(
      '  '.repeat(Math.min(depth, 8))
      + (item.path ?? '') + ' ' + (item.type ?? '?')
      + ' "' + (item.name ?? '') + '"' + klass + ident + pats,
    );
  }
  if (list.length > limit) lines.push('… 还有 ' + (list.length - limit) + ' 个节点未显示，缩小查询范围或降低 depth');
  return lines;
}

function buildTools(ctx, cfg) {
  const tools = [];

  tools.push({
    name: 'quiet_launch',
    isConcurrencySafe: () => false,
    description: '在屏幕外启动一个 GUI 程序：窗口从创建起就停在你所有显示器之外，全程不上屏，并尽量避免抢键盘焦点（被发现抢走会还回去），返回它的 hwnd。之后就配合 quiet_shot / quiet_tree / quiet_act 操作它。浏览器默认使用独立 profile，避免寄生到你已开的浏览器进程。要打开任何界面程序都用这个，不要用 Start-Process、cmd、手写 CreateProcess 或 ShowWindow。',
    parameters: {
      type: 'object',
      properties: {
        exe: { type: 'string', description: '可执行文件的绝对路径，或 PATH 里的名字（如 charmap.exe、msedge.exe）。' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: '传给程序的命令行参数，逐项给出。网址、文件路径这类参数放这里。',
        },
        width: { type: 'number', description: '窗口宽度（像素，默认 1280）。' },
        height: { type: 'number', description: '窗口高度（像素，默认 860）。' },
        title: { type: 'string', description: '只接受窗口标题匹配这个正则的窗口（可选，用于程序会先弹出别的窗口时）。' },
        isolateProfile: {
          type: 'boolean',
          description: '浏览器是否使用独立 profile，默认 true。关掉后如果浏览器已在运行，新窗口会寄生到旧进程里，此时不会对该进程执行强制结束。',
        },
        keepOnFailure: {
          type: 'boolean',
          description: '启动失败时保留已拉起的进程（默认 false：失败即结束它并清理临时 profile，避免留下看不见的窗口）。',
        },
      },
      required: ['exe'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => {
      const rec = asRecord(value);
      if (rec.ok !== true) {
        const lines = [failText(rec, '启动失败')];
        if (rec.cleaned === true) lines.push('已结束本次拉起的进程，没有留下隐藏窗口。');
        if (rec.launched !== undefined) lines.push('命令行：' + JSON.stringify(rec.launched));
        return text(lines);
      }
      const lines = [
        '已在屏幕外启动：hwnd ' + rec.hwnd + ' · 窗口进程 pid ' + rec.pid,
        '标题：' + (rec.title || '(无标题)'),
        '矩形：' + JSON.stringify(rec.rect) + (rec.offscreen === true ? '（完全在所有显示器之外）' : '（警告：不在屏幕外）'),
        '上屏过：' + (rec.flashed === true ? '是（已被立刻挪走）' : '否'),
        '焦点：' + (rec.focus_stolen === true ? '曾被抢走，已尽量还回去' : '没有被动过'),
      ];
      if (rec.isolated_profile !== null && rec.isolated_profile !== undefined) {
        lines.push('独立 profile：' + rec.isolated_profile);
      }
      if (rec.shared_process === true) {
        lines.push('警告：窗口属于一个已有进程（不是本次启动的进程），不会对它执行强制结束。');
      }
      lines.push('下一步：quiet_shot 看画面，或 quiet_tree 读控件树。');
      return text(lines);
    } },
    timeoutMs: cfg.launchTimeoutMs,
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const exe = optionalString(args, 'exe');
      if (exe === undefined) throw new Error('exe 为必填：给出可执行文件路径或名字。');
      const argv = ['launch', '--exe', exe];
      const extra = Array.isArray(args.args) ? args.args.filter((a) => typeof a === 'string' && a !== '') : [];
      // 逐个 --arg 会被 argparse 当成选项（Chromium 的开关都以 '-' 开头），走 JSON 数组。
      if (extra.length > 0) argv.push('--argv-json', JSON.stringify(extra));
      const width = optionalNumber(args, 'width');
      const height = optionalNumber(args, 'height');
      if (width !== undefined) argv.push('--width', String(width));
      if (height !== undefined) argv.push('--height', String(height));
      const title = optionalString(args, 'title');
      if (title !== undefined) argv.push('--title', title);
      // 留给 helper 的等待上限必须比工具自身超时短，否则会先被掐断、拿不到干净的 JSON 错误。
      argv.push('--timeout', String(Math.max(5, Math.floor(cfg.launchTimeoutMs / 1000) - 8)));
      if (args.isolateProfile === false) argv.push('--no-isolate');
      if (args.keepOnFailure === true) argv.push('--keep-on-failure');
      const value = await runHelper(ctx, cfg, argv, {
        cwd: sessionCwd(exec), signal: exec?.signal, timeoutMs: cfg.launchTimeoutMs,
      });
      if (value.ok === true && Number.isInteger(value.hwnd)) {
        knownWindows.set(value.hwnd, {
          pid: value.pid,
          shared: value.shared_process === true,
        });
      }
      return value;
    },
  });

  tools.push({
    name: 'quiet_windows',
    isConcurrencySafe: () => true,
    description: '列出当前所有可见顶层窗口（包括用户自己开在屏幕上的、以及安静启动的那些），外加显示器布局、DPI 和前台窗口。用它拿 hwnd：屏幕外窗口可以直接 quiet_shot / quiet_tree / quiet_act；屏幕上已经开着的窗口先 quiet_park 挪到屏幕外再操作。任何窗口句柄都可以直接传给 quiet_shot，不要求是 quiet_launch 启动的。别用 FindWindow / GetWindowRect 手搓窗口枚举。',
    parameters: { type: 'object', properties: {} },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => {
      const rec = asRecord(value);
      if (rec.ok !== true) return text([failText(rec, '读取失败')]);
      const offscreen = Array.isArray(rec.offscreen) ? rec.offscreen : [];
      const windows = Array.isArray(rec.windows) ? rec.windows : offscreen;
      const lines = ['显示器：' + JSON.stringify(rec.monitors) + '，系统 DPI：' + rec.dpi];
      const fg = asRecord(rec.foreground);
      if (typeof fg.title === 'string' && fg.title !== '') {
        lines.push('前台窗口：hwnd ' + fg.hwnd + ' · pid ' + fg.pid + ' · ' + fg.title);
      }
      lines.push('屏幕外窗口：' + offscreen.length + ' 个（共 ' + (rec.count ?? windows.length) + ' 个可见窗口）');
      for (const w of offscreen) lines.push(windowLine(w));
      if (offscreen.length === 0) lines.push('- 没有。用 quiet_launch 启动一个，或 quiet_park 接管已有的。');

      const onScreen = windows.filter((w) => asRecord(w).offscreen !== true);
      if (onScreen.length > 0) {
        const shown = onScreen.slice(0, 20);
        lines.push('屏幕上还有 ' + onScreen.length + ' 个窗口（想操作就先 quiet_park）：');
        for (const w of shown) lines.push(windowLine(w));
        if (onScreen.length > shown.length) lines.push('- …还有 ' + (onScreen.length - shown.length) + ' 个未列出');
      }
      return text(lines);
    } },
    timeoutMs: 30000,
    async execute(rawArgs, exec) {
      const value = await runHelper(ctx, cfg, ['list'], { cwd: sessionCwd(exec), signal: exec?.signal });
      const seen = Array.isArray(value.windows) ? value.windows : (Array.isArray(value.offscreen) ? value.offscreen : []);
      for (const w of seen) {
        if (Number.isInteger(w?.hwnd) && !knownWindows.has(w.hwnd) && Number.isInteger(w.pid)) {
          knownWindows.set(w.hwnd, { pid: w.pid, shared: false });
        }
      }
      return value;
    },
  });

  tools.push({
    name: 'quiet_park',
    isConcurrencySafe: () => false,
    description: '把一个已经在运行的窗口挪到所有显示器之外（不激活、不改大小、不抢焦点）。用于「用户自己已经开着这个程序」的场景：先 quiet_park，再 quiet_shot / quiet_tree / quiet_act，全程不打断用户的桌面。窗口最小化时会先就地恢复但保持不激活。别用 SetWindowPos / MoveWindow 手搓。',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'number', description: '窗口句柄，从 quiet_windows 的列表里取。' },
        expectPid: { type: 'number', description: '可选。期望的进程 id；句柄被复用时报错而不是动错窗口。' },
      },
      required: ['hwnd'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => {
      const rec = asRecord(value);
      if (rec.ok !== true) return text([failText(rec, '挪动失败')]);
      const lines = ['窗口 hwnd ' + rec.hwnd + ' 已挪到屏幕外。'];
      if (Array.isArray(rec.before) && Array.isArray(rec.after)) {
        lines.push('位置：' + JSON.stringify(rec.before) + ' → ' + JSON.stringify(rec.after));
      }
      lines.push(rec.offscreen === true ? '已确认不在任何显示器上。' : '警告：窗口仍在显示器范围内。');
      if (rec.focus_stolen === true) lines.push('提示：期间前台窗口变过，可能是系统行为。');
      if (typeof rec.note === 'string') lines.push(rec.note);
      return text(lines);
    } },
    timeoutMs: 30000,
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const hwnd = requiredNumber(args, 'hwnd', '窗口句柄');
      const known = knownWindows.get(hwnd);
      const argv = ['park', '--hwnd', String(hwnd)];
      const expectPid = Number.isInteger(args.expectPid) ? args.expectPid : known?.pid;
      if (Number.isInteger(expectPid)) argv.push('--expect-pid', String(expectPid));
      const value = await runHelper(ctx, cfg, argv, { cwd: sessionCwd(exec), signal: exec?.signal });
      if (value.ok === true && Number.isInteger(value.hwnd) && Number.isInteger(known?.pid)) {
        knownWindows.set(value.hwnd, { pid: known.pid, shared: true });
      }
      return value;
    },
  });

  tools.push({
    name: 'quiet_shot',
    isConcurrencySafe: () => true,
    description: '截取指定窗口当前的画面并存成 PNG，返回路径。截图来自窗口自己的渲染表面，因此即使窗口在屏幕外、被别的窗口完全盖住也能拿到；窗口被最小化时可能变黑（looks_blank 会标出来）。要截任何窗口都用这个，不要用 CopyFromScreen、ImageGrab、BitBlt 或 PrintWindow 手写脚本——它们要么要求窗口在屏上、要么会带上遮挡、要么 DPI 不对。',
    parameters: {
      type: 'object',
      properties: { hwnd: { type: 'number', description: '窗口句柄，来自 quiet_launch 或 quiet_windows。' } },
      required: ['hwnd'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => {
      const rec = asRecord(value);
      if (rec.ok !== true) return text([failText(rec, '截图失败')]);
      const lines = [
        '截图：' + rec.path,
        '尺寸：' + rec.width + 'x' + rec.height + '，灰阶种类：' + rec.unique_gray,
      ];
      if (rec.looks_blank === true) {
        lines.push('警告：画面接近纯色，这个应用可能在屏幕外停止绘制。可改用虚拟显示器，或短暂把窗口搬到屏幕内。');
      } else {
        lines.push('下一步：用 read_image 读取这个路径查看画面。');
      }
      return text(lines);
    } },
    timeoutMs: 60000,
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const hwnd = requiredNumber(args, 'hwnd', '窗口句柄');
      const cwd = sessionCwd(exec);
      const dir = join(cwd, '.dsh-quiet');
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
        /* 目录已存在 */
      }
      const out = join(dir, 'win-' + hwnd + '-' + Date.now() + '.png');
      return runHelper(ctx, cfg, withExpectedPid(['shot', '--hwnd', String(hwnd), '--out', out], hwnd), {
        cwd, signal: exec?.signal,
      });
    },
  });

  tools.push({
    name: 'quiet_tree',
    isConcurrencySafe: () => true,
    description: '读取窗口的 UI Automation 控件树：每个控件的类型、文字、class、AutomationId、可用模式（invoke / value / selectionitem / toggle / expandcollapse）。先看树，再用 quiet_act 按控件操作，不要猜坐标。读控件树本身也用它，不要自己 pip install uiautomation 再写脚本。',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'number', description: '窗口句柄。' },
        depth: { type: 'number', description: '向下遍历的层数，默认 3；树太大时降低它。' },
      },
      required: ['hwnd'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => {
      const rec = asRecord(value);
      if (rec.ok !== true) return text([failText(rec, '读取控件树失败')]);
      const root = asRecord(rec.root);
      const lines = [
        '根：' + (root.type ?? '?') + ' "' + (root.name ?? '') + '" class=' + (root.class ?? ''),
        '节点数：' + rec.count + '（显示上限 200）',
      ];
      lines.push(...renderTree(rec.items));
      return text(lines);
    } },
    timeoutMs: 60000,
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const hwnd = requiredNumber(args, 'hwnd', '窗口句柄');
      const depth = optionalNumber(args, 'depth');
      const argv = ['tree', '--hwnd', String(hwnd)];
      if (depth !== undefined) argv.push('--depth', String(depth));
      return runHelper(ctx, cfg, withExpectedPid(argv, hwnd), { cwd: sessionCwd(exec), signal: exec?.signal });
    },
  });

  tools.push({
    name: 'quiet_act',
    isConcurrencySafe: () => false,
    description: '对控件执行一次操作，走控件自身的 UI Automation 模式（invoke / set / select / toggle / expand / collapse），不需要窗口在前台、不用坐标点击，通常不会把窗口搬到屏幕内。按 name / auto_id / class / type 定位控件，至少给一个；动作期间若键盘焦点被抢会试图还回去——是“尽量不打扰”，不是零干扰保证。点按钮、填输入框都用这个，不要用 SetCursorPos + mouse_event 点坐标，也不要 SendKeys。',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'number', description: '窗口句柄。' },
        op: {
          type: 'string',
          enum: ['invoke', 'set', 'select', 'toggle', 'expand', 'collapse', 'focus'],
          description: 'invoke=按按钮/链接；set=写输入框（配 value）；select=选中列表项或标签页；toggle=勾选；expand/collapse=展开折叠。',
        },
        value: { type: 'string', description: 'op 为 set 时写入的文本。' },
        name: { type: 'string', description: '控件名包含这段文字（模糊匹配）。' },
        exact_name: { type: 'string', description: '控件名完全等于这段文字。' },
        auto_id: { type: 'string', description: '控件的 AutomationId。' },
        class: { type: 'string', description: '控件的窗口类名片段。' },
        type: { type: 'string', description: '控件类型，如 ButtonControl、EditControl、TabItemControl。' },
      },
      required: ['hwnd', 'op'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => {
      const rec = asRecord(value);
      if (rec.ok !== true) {
        const lines = [failText(rec, '操作失败')];
        if (rec.selector !== undefined) lines.push('选择器：' + JSON.stringify(rec.selector));
        lines.push('下一步：先 quiet_tree 确认控件名与可用模式，再重试。');
        return text(lines);
      }
      const before = rec.foreground_before;
      const after = rec.foreground_after;
      const focusLine = before === after
        ? '焦点：没有变化'
        : (rec.foreground_restored === true ? '焦点：曾移走，已还原' : '焦点：被移走且未能还原');
      return text([
        '已执行 ' + rec.op + ' → ' + (rec.type ?? '') + ' "' + (rec.target ?? '') + '"',
        focusLine,
      ]);
    } },
    timeoutMs: 60000,
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const hwnd = requiredNumber(args, 'hwnd', '窗口句柄');
      const op = optionalString(args, 'op');
      if (op === undefined) throw new Error('op 为必填：invoke / set / select / toggle / expand / collapse / focus。');
      const argv = ['act', '--hwnd', String(hwnd), '--op', op];
      const value = optionalString(args, 'value');
      if (value !== undefined) argv.push('--value', value);
      const map = [['name', '--name'], ['exact_name', '--exact-name'], ['class', '--class'], ['auto_id', '--auto-id'], ['type', '--type']];
      for (const [key, flag] of map) {
        const v = optionalString(args, key);
        if (v !== undefined) argv.push(flag, v);
      }
      if (!map.some(([key]) => optionalString(args, key) !== undefined)) {
        throw new Error('至少给出一个定位条件：name / exact_name / class / auto_id / type。');
      }
      return runHelper(ctx, cfg, withExpectedPid(argv, hwnd), { cwd: sessionCwd(exec), signal: exec?.signal });
    },
  });

  tools.push({
    name: 'quiet_close',
    isConcurrencySafe: () => false,
    description: '关闭一个屏幕外窗口（先正常关闭，进程不退就强制结束）。收尾用，避免留下看不见的进程。',
    parameters: {
      type: 'object',
      properties: {
        hwnd: { type: 'number', description: '窗口句柄。' },
        kill: { type: 'boolean', description: '关闭失败时强制结束进程（默认 false）。' },
      },
      required: ['hwnd'],
    },
    output: { schema: OBJECT_SCHEMA, render: (_args, value) => {
      const rec = asRecord(value);
      if (rec.ok !== true) return text([failText(rec, '关闭失败')]);
      const lines = [rec.closed === true ? '窗口已关闭。' : '已发出关闭请求，窗口仍在。可加 kill=true 强制结束。'];
      if (rec.killed === true) lines.push('进程已强制结束。');
      if (typeof rec.kill_skipped === 'string') lines.push(rec.kill_skipped);
      return text(lines);
    } },
    timeoutMs: 30000,
    async execute(rawArgs, exec) {
      const args = asRecord(rawArgs);
      const hwnd = requiredNumber(args, 'hwnd', '窗口句柄');
      const known = knownWindows.get(hwnd);
      const argv = ['close', '--hwnd', String(hwnd)];
      // 共享进程（寄生到用户已开的浏览器里）绝不强制结束，只关这个窗口。
      const wantKill = args.kill === true && known?.shared !== true;
      if (wantKill) argv.push('--kill');
      if (Number.isInteger(known?.pid)) argv.push('--expect-pid', String(known.pid));
      const value = await runHelper(ctx, cfg, argv, { cwd: sessionCwd(exec), signal: exec?.signal });
      if (value.ok === true && value.closed === true) knownWindows.delete(hwnd);
      if (args.kill === true && !wantKill) {
        value.kill_skipped = '这个窗口属于一个已有进程（共享），已跳过强制结束，只关闭了窗口本身。';
      }
      return value;
    },
  });

  return tools;
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config === null || config === undefined ? {} : asRecord(config)) };
  const disposers = [];
  try {
    for (const definition of buildTools(ctx, cfg)) {
      disposers.push(ctx.tools.register(definition));
    }
  } catch (error) {
    for (const dispose of disposers) dispose();
    throw error;
  }
  const teardown = () => {
    for (const dispose of disposers) dispose();
  };
  if (typeof ctx.effect === 'function') ctx.effect(() => teardown, 'quiet-windows.tools()');
  else if (typeof ctx.on === 'function') ctx.on('dispose', teardown);
}

export { HELPER as helperPath, resolvePath };
