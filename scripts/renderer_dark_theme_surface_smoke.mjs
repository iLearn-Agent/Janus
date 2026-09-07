import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { app, BrowserWindow } = globalThis.__janusElectron;
const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'janus-dark-theme-surfaces-'));
const htmlPath = path.join(tempRoot, 'index.html');
const styleUrl = pathToFileURL(path.join(process.cwd(), 'src', 'renderer', 'style.css')).href;

writeFileSync(htmlPath, `<!doctype html>
<html><head><meta charset="utf-8"><link rel="stylesheet" href="${styleUrl}"></head>
<body><div class="app-frame theme-dark"><main class="shell theme-dark" style="display:block;min-height:100vh;padding:24px">
  <section id="dark-surface-audit" style="display:grid;gap:12px;width:680px">
    <div data-dark-surface="task-menu" class="task-reference-menu" style="position:static"><button class="task-reference-new"><span><strong data-dark-text>创建新任务</strong></span><small>不关联现有任务</small></button></div>
    <div data-dark-surface="project-menu" class="project-mention-menu"><button class="project-reference-disabled" data-dark-text>选择文件夹后可以 @ 引用项目文件</button></div>
    <div data-dark-surface="new-task" class="composer-reference-card is-task"><span></span><span><strong data-dark-text>@新任务</strong><small>将创建独立 task_run_id</small></span><button>×</button></div>
    <div class="message-task-reference"><span data-dark-surface="sent-task-reference"><b data-dark-text>@新任务</b><small>独立新任务</small></span></div>
    <article data-dark-surface="natural-task" class="natural-multi-task-card"><header><strong data-dark-text>新任务</strong><small>执行中</small></header><p>任务详情</p></article>
    <article data-dark-surface="published-task" class="ubuddy-published-task-card"><div class="ubuddy-published-task-card-head"><span>U</span><span><small>uBuddy</small><strong data-dark-text>已发布任务</strong></span><b>进行中</b></div><p>任务说明</p></article>
    <section data-dark-surface="selection" class="ubuddy-selection-card"><header><strong data-dark-text>参与人选择</strong></header><p>已选择 Agent</p></section>
    <section data-dark-surface="plan" class="ubuddy-collaboration-plan-card"><header><strong data-dark-text>多人分工方案</strong></header><div class="ubuddy-collaboration-assignments"><article><b>1</b><div><strong>节点</strong><p>任务</p></div></article></div></section>
    <div data-dark-surface="warning" class="context-usage-warning"><span data-dark-text>上下文提示</span><button>压缩</button></div>
    <section data-dark-surface="allocation" class="ubuddy-allocation-card is-waiting_for_agents"><header><span class="ubuddy-coordination-mark">U</span><div><strong data-dark-text>任务分配情况</strong><small>等待员工</small></div></header></section>
    <article data-dark-surface="task-chip" class="collaboration-task-chip"><strong data-dark-text>协作任务</strong><small>处理中</small></article>
    <article data-dark-surface="avatar-viewer" class="avatar-viewer-modal"><strong data-dark-text>头像预览</strong></article>
    <article data-dark-surface="avatar-cropper" class="avatar-cropper-modal"><header><strong data-dark-text>裁剪头像</strong><button>×</button></header></article>
    <details data-dark-surface="memory-detail" class="employee-memory-context-detail" open><summary><span><strong data-dark-text>Memory</strong><small>历史上下文</small></span></summary><div class="employee-memory-context-detail-body"></div></details>
    <div class="message-attachments compact-attachment-strip"><article data-dark-surface="attachment" class="message-attachment-card"><span class="message-attachment-icon">DOC</span><span><strong data-dark-text>文档</strong><small>附件</small></span></article></div>
    <div data-dark-surface="model-menu" class="model-menu" style="position:static"><button class="model-menu-option"><span data-dark-text>模型选项</span></button></div>
    <article data-dark-surface="dialog" class="dialog-card"><header><h2 data-dark-text>对话框</h2></header></article>
    <aside data-dark-surface="employee-detail" class="employee-memory-drawer employee-overview-drawer" style="position:static;width:100%;height:auto"><header><div><span class="employee-drawer-kicker">Agent</span><h2>员工详情</h2><p data-dark-text>查看 Agent 的职责、状态与当前工作。</p></div></header>
    <nav class="employee-detail-tabs"><button data-dark-surface="employee-detail-tab" data-dark-text class="is-active">员工概览</button><button>成长记录</button></nav>
    <section class="employee-overview-grid"><article data-dark-surface="employee-detail-overview"><small>当前工作</small><strong>空闲</strong><span data-dark-text>可接受新的任务分配。</span></article></section>
    <section data-dark-surface="employee-detail-growth" class="employee-growth-section"><header><div><span>Performance</span><h3>P3</h3></div><em>评估中</em></header><p data-dark-text>根据有效任务样本持续评估专业表现。</p></section>
    <section data-dark-surface="employee-profile" class="employee-profile-editor"><strong data-dark-text>员工资料</strong><div data-dark-surface="employee-profile-form" class="employee-profile-form"><label>名称<input value="研究员"></label></div></section>
    <article data-dark-surface="employee-skill-choice" class="employee-skill-choice is-current"><strong data-dark-text>当前技能组合</strong></article>
    <details data-dark-surface="employee-market-version" class="employee-market-version" open><summary><strong data-dark-text>市场版本</strong><em>当前</em></summary><div class="employee-market-version-body"><div class="employee-skill-change-list"><article data-dark-surface="employee-skill-change"><strong data-dark-text>变更内容</strong></article></div></div></details>
    <section data-dark-surface="employee-candidate" class="talent-candidate-hero"><span></span><div><strong>写作 Agent</strong><small data-dark-text>研究部</small></div></section>
    <div data-dark-surface="employee-detail-note" class="employee-permission-note"><p data-dark-text>状态说明与辅助信息需要保持清晰可读。</p></div>
    </aside>
    <section data-dark-surface="plugins-page" class="plugins-view"><div class="plugins-collapsible-section"><button class="plugins-section-toggle"><span class="plugins-section-toggle-copy"><strong data-dark-text>技能与插件</strong><small>管理已安装项目</small></span></button><div class="plugins-collapsible-body">
      <div class="plugins-grid"><article data-dark-surface="plugin-card" class="plugin-card"><div class="plugin-card-head"><span class="plugin-card-icon">P</span><span class="plugin-card-title"><strong data-dark-text>示例插件</strong><small>已安装</small></span></div></article></div>
      <label class="codex-marketplace-add"><span>市场源</span><input data-dark-surface="plugin-market-input" value="example/source" data-dark-text></label>
      <article data-dark-surface="plugin-row" class="codex-plugin-row"><span class="codex-plugin-mark">C</span><div><strong data-dark-text>Codex 插件</strong><p>插件说明</p></div></article>
      <div data-dark-surface="plugin-conflict" class="codex-plugin-conflict"><strong data-dark-text>检测到配置冲突</strong></div>
      <div data-dark-surface="plugin-menu" class="plugin-menu" style="position:static"><button data-dark-text>插件操作</button></div>
    </div></div></section>
    <section data-dark-surface="janus-app" class="janus-app-view"><header class="janus-app-header"><span data-dark-surface="janus-app-mark" class="janus-app-mark"><b data-dark-text>J</b></span></header><div class="janus-app-stage"><div class="janus-app-platforms"><span data-dark-surface="janus-platform"><strong data-dark-text>iOS</strong><em>即将推出</em></span></div><div class="janus-app-device"><div data-dark-surface="janus-phone-screen" class="janus-app-device-screen"><div class="janus-app-device-splash"><strong data-dark-text>Janus</strong><small>随时连接</small></div><i class="janus-app-home-indicator"></i></div></div></div></section>
    <section data-dark-surface="mobile-settings" class="panel settings-panel feishu-settings-panel"><div class="feishu-status-row"><span><strong data-dark-text>手机连接</strong><small>局域网测试版</small></span><span class="feishu-status-badge is-connected">已连接</span></div><div data-dark-surface="mobile-success" class="settings-inline-success"><span data-dark-text>连接成功</span></div><div data-dark-surface="mobile-error" class="settings-inline-error"><span data-dark-text>连接错误</span></div></section>
  </section>
</main></div></body></html>`, 'utf8');

let browserWindow;
try {
  await app.whenReady();
  browserWindow = new BrowserWindow({
    show: false,
    width: 900,
    height: 760,
    webPreferences: { contextIsolation: false, nodeIntegration: false, sandbox: false },
  });
  await browserWindow.loadFile(htmlPath);
  const result = await browserWindow.webContents.executeJavaScript(`(() => {
    const surfaces = [...document.querySelectorAll('[data-dark-surface]')].map((surface) => {
      const style = getComputedStyle(surface);
      const text = surface.querySelector('[data-dark-text]') || surface;
      const background = resolvedBackground(surface);
      return {
        name: surface.dataset.darkSurface,
        rawBackground: style.backgroundColor,
        backgroundImage: style.backgroundImage,
        background,
        contrast: contrastRatio(getComputedStyle(text).color, background),
        hasSurface: parseColor(style.backgroundColor).a > .05 || style.backgroundImage !== 'none',
      };
    });
    return { dark: Boolean(document.querySelector('.shell.theme-dark')), surfaces };

    function parseColor(value) {
      const parts = (value.match(/[\\d.]+/g) || []).map(Number);
      return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0, a: parts.length > 3 ? parts[3] : 1 };
    }
    function composite(foreground, background) {
      const a = foreground.a + background.a * (1 - foreground.a);
      if (!a) return { r: 0, g: 0, b: 0, a: 0 };
      return {
        r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / a,
        g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / a,
        b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / a,
        a,
      };
    }
    function resolvedBackground(element) {
      let color = { r: 0, g: 0, b: 0, a: 0 };
      for (let node = element; node; node = node.parentElement) {
        color = composite(color, parseColor(getComputedStyle(node).backgroundColor));
        if (color.a >= .999) break;
      }
      return 'rgb(' + [color.r, color.g, color.b].map((value) => Math.round(value)).join(', ') + ')';
    }
    function contrastRatio(foreground, background) {
      const parse = (value) => (value.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
      const luminance = (rgb) => {
        const values = rgb.map((value) => {
          const channel = value / 255;
          return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2];
      };
      const first = luminance(parse(foreground));
      const second = luminance(parse(background));
      return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
    }
  })()`);
  assert.equal(result.dark, true);
  const failures = result.surfaces.filter((surface) => (
    !surface.hasSurface || isLightSurface(surface.background) || surface.contrast < 4.5
  ));
  assert.deepEqual(failures, [], `Dark surfaces remained light or unreadable: ${JSON.stringify(result.surfaces)}`);
  console.log(`renderer dark theme surface smoke passed (${result.surfaces.length} surfaces)`);
} finally {
  if (browserWindow && !browserWindow.isDestroyed()) browserWindow.destroy();
  rmSync(tempRoot, { recursive: true, force: true });
}

function isLightSurface(value = '') {
  const rgb = (String(value).match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  if (rgb.length < 3) return true;
  const channels = rgb.map((amount) => {
    const channel = amount / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) > 0.42;
}
