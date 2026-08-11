import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { exec, spawn } from 'child_process';
import util from 'util';

const execPromise = util.promisify(exec);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const configPath = path.join(__dirname, 'config.json');

// 读取配置
function loadConfig() {
  if (!fs.existsSync(configPath)) {
    console.error('❌ 未找到 config.json 配置文件！');
    process.exit(1);
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('❌ 读取 config.json 格式错误:', e.message);
    process.exit(1);
  }
}

// 支持的图片扩展名列表
const SUPPORTED_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];

// 获取图片文件夹下的所有合法图片路径
function getImagesFromFolder(folderPath) {
  if (!folderPath || !fs.existsSync(folderPath)) {
    return [];
  }
  try {
    const files = fs.readdirSync(folderPath);
    return files
      .filter(file => SUPPORTED_EXTS.includes(path.extname(file).toLowerCase()))
      .map(file => path.join(folderPath, file));
  } catch (e) {
    console.error(`⚠️ 读取图片文件夹失败 [${folderPath}]:`, e.message);
    return [];
  }
}

// 将图片转为 Base64（防止 Electron CSP 协议限制）
function getImageBase64(imagePath) {
  if (!imagePath || !fs.existsSync(imagePath)) {
    return null;
  }
  const ext = path.extname(imagePath).toLowerCase();
  let mimeType = 'image/jpeg';
  if (ext === '.png') mimeType = 'image/png';
  if (ext === '.webp') mimeType = 'image/webp';
  if (ext === '.gif') mimeType = 'image/gif';

  const fileData = fs.readFileSync(imagePath);
  return `data:${mimeType};base64,${fileData.toString('base64')}`;
}

// 获取 Windows 微软商店的 Codex/ChatGPT 路径
async function getCodexExePath() {
  try {
    const psCmd = `powershell -NoProfile -Command "$pkg = Get-AppxPackage | Where-Object {$_.Name -like '*OpenAI.Codex*' -or $_.Name -like '*ChatGPT*'}; if ($pkg) { Join-Path $pkg.InstallLocation 'app\\ChatGPT.exe' }"`;
    const { stdout } = await execPromise(psCmd);
    const exePath = stdout.trim();
    if (exePath && fs.existsSync(exePath)) {
      return exePath;
    }
  } catch (err) {}

  const windowsAppsDir = 'C:\\Program Files\\WindowsApps';
  if (fs.existsSync(windowsAppsDir)) {
    try {
      const entries = fs.readdirSync(windowsAppsDir);
      const codexFolder = entries.find(name => name.startsWith('OpenAI.Codex'));
      if (codexFolder) {
        const candidate = path.join(windowsAppsDir, codexFolder, 'app', 'ChatGPT.exe');
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch (e) {}
  }
  return null;
}

// 检查调试端口是否准备就绪
async function checkPortReady(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`);
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {
    return null;
  }
  return null;
}

// 动态生成高清无毛玻璃 CSS 样式
function generateCSS(imagePath, opacity) {
  const base64Image = getImageBase64(imagePath);
  const bgStyle = base64Image
    ? `background-image: url('${base64Image}') !important;`
    : `background: linear-gradient(135deg, #1e1e2f, #0f0f1a) !important;`;

  const alpha = Math.max(0, Math.min(1, parseFloat(opacity ?? 0.5)));
  const bgRgba = `rgba(18, 18, 24, ${alpha})`;

  return `
    /* === Codex 幻灯片透明换肤样式 === */
    html, body, #root, #root > div, [data-is-root] {
      ${bgStyle}
      background-size: cover !important;
      background-position: center !important;
      background-repeat: no-repeat !important;
      background-attachment: fixed !important;
      background-color: transparent !important;
      transition: background-image 0.5s ease-in-out !important;
    }

    /* 穿透面板背景 */
    [class*="MainContentSurface"],
    [class*="ApplicationMenuTopBar"],
    [class*="bg-token-"],
    [class*="sidebar"],
    [class*="Sidebar"],
    main,
    aside,
    section,
    nav {
      background-color: ${bgRgba} !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }

    /* 交互输入框略微提高透明度保证可视度 */
    [class*="ComposerLayoutBody"],
    [class*="chat-input"],
    textarea,
    input {
      background-color: rgba(28, 28, 36, ${Math.min(0.95, alpha + 0.2)}) !important;
      backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important;
    }

    .dark body, html.electron-dark {
      background-color: transparent !important;
    }
  `.replace(/\s+/g, ' ');
}

// 通过 WebSocket 执行 CDP 注入
async function injectCSS(port, targetId, cssContent) {
  const pages = await checkPortReady(port);
  if (!pages) return false;
  const target = pages.find(p => p.id === targetId);
  if (!target || !target.webSocketDebuggerUrl) return false;

  return new Promise((resolve) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      ws.close();
      resolve(false);
    }, 4000);

    ws.onopen = () => {
      const script = `
        (function() {
          let styleEl = document.getElementById('custom-codex-skin-style');
          if (!styleEl) {
            styleEl = document.createElement('style');
            styleEl.id = 'custom-codex-skin-style';
            document.head.appendChild(styleEl);
          }
          styleEl.textContent = ${JSON.stringify(cssContent)};
          return true;
        })();
      `;
      ws.send(JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression: script }
      }));
    };

    ws.onmessage = () => {
      clearTimeout(timer);
      ws.close();
      resolve(true);
    };

    ws.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });
}

// 执行一次背景图注入
async function applyBackground(port, imagePath, opacity) {
  const pages = await checkPortReady(port);
  if (!pages) return false;

  const targetPages = pages.filter(p => p.type === 'page' && p.url.includes('index.html'));
  if (targetPages.length === 0) return false;

  const css = generateCSS(imagePath, opacity);
  let successCount = 0;
  for (const page of targetPages) {
    const ok = await injectCSS(port, page.id, css);
    if (ok) successCount++;
  }
  return successCount > 0;
}

// 随机挑选下一张不重复的图片
function pickRandomImage(images, currentImage) {
  if (images.length === 0) return null;
  if (images.length === 1) return images[0];

  const pool = images.filter(img => img !== currentImage);
  const randomIndex = Math.floor(Math.random() * pool.length);
  return pool[randomIndex];
}

async function main() {
  console.log('==================================================');
  console.log('🚀 Codex / ChatGPT 轮播自动换肤注入工具');
  console.log('==================================================');

  const config = loadConfig();
  const port = config.debugPort || 9341;
  const opacity = config.opacity ?? 0.5;
  const intervalSeconds = Math.max(5, parseInt(config.intervalSeconds || 60, 10));

  // 获取所有候选图片
  let imageList = [];
  if (config.imageFolder && fs.existsSync(config.imageFolder)) {
    imageList = getImagesFromFolder(config.imageFolder);
    console.log(`📂 已选择壁纸文件夹: ${config.imageFolder}`);
    console.log(`🖼️  共扫描到 ${imageList.length} 张可用图片`);
  }

  // 如果文件夹中没有找到或者未配置文件夹，降级使用单张图片配置
  if (imageList.length === 0 && config.imagePath) {
    if (fs.existsSync(config.imagePath)) {
      imageList = [config.imagePath];
    }
  }

  if (imageList.length === 0) {
    console.error('❌ 未找到任何有效的壁纸图片！请检查 config.json 中的 imageFolder 或 imagePath。');
    process.exit(1);
  }

  console.log(`💧 主体不透明度: ${opacity}`);
  if (imageList.length > 1) {
    console.log(`⏱️  自动随机切换间隔: ${intervalSeconds} 秒`);
  }

  // 检查/拉起应用
  let pages = await checkPortReady(port);

  if (!pages) {
    console.log('\n🔍 未检测到开启调试端口的 Codex 应用，正在自动启动...');
    const exePath = await getCodexExePath();

    if (!exePath) {
      console.error('❌ 未能找到微软商店安装的 Codex/ChatGPT 可执行文件！');
      process.exit(1);
    }

    console.log(`📂 找到应用程序路径:\n   ${exePath}`);
    console.log(`⚙️  正在启动应用 (--remote-debugging-port=${port})...`);

    const child = spawn(exePath, [`--remote-debugging-port=${port}`], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    let retries = 15;
    while (retries > 0) {
      await new Promise(r => setTimeout(r, 800));
      pages = await checkPortReady(port);
      if (pages && pages.length > 0) break;
      retries--;
    }

    if (!pages) {
      console.error('❌ 启动应用失败，未能检测到调试端口。');
      process.exit(1);
    }
  } else {
    console.log('\n⚡ 检测到已有应用运行中（已开启调试端口）！');
  }

  // 首次应用
  let currentImage = pickRandomImage(imageList, null);
  console.log(`\n🎨 正在应用壁纸: ${path.basename(currentImage)}`);
  await applyBackground(port, currentImage, opacity);
  console.log('✨ 换肤成功！');

  // 如果有多张图片且设置了轮播，启动定时任务
  if (imageList.length > 1) {
    console.log(`\n🔄 轮播切换已激活，保持此后台程序运行即可（Ctrl+C 可退出）...`);

    setInterval(async () => {
      // 重新扫描文件夹，支持用户中途往文件夹添加新图
      if (config.imageFolder && fs.existsSync(config.imageFolder)) {
        const freshList = getImagesFromFolder(config.imageFolder);
        if (freshList.length > 0) imageList = freshList;
      }

      const nextImage = pickRandomImage(imageList, currentImage);
      if (nextImage) {
        currentImage = nextImage;
        const timeStr = new Date().toLocaleTimeString();
        console.log(`[${timeStr}] 🎲 随机切换到下一张壁纸: ${path.basename(currentImage)}`);
        await applyBackground(port, currentImage, opacity);
      }
    }, intervalSeconds * 1000);
  }
}

main().catch(err => {
  console.error('❌ 发生异常:', err.message);
});
