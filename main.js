/**
 * @name         Process Governor
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Electron main process — CPU/memory limiter per-app via Windows Job Objects.
 * @author       Cloud Nimbus LLC
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { exec, execFile } = require('child_process');
const Store = require('electron-store');

const store = new Store({
  defaults: {
    rules: [],      // { id, name, processName, cpuPercent, memoryMb, enabled, createdAt }
    settings: {
      refreshInterval: 3,
      startMinimized: false,
      autoApplyOnLaunch: true,
    },
  },
});

let mainWindow = null;
let tray = null;

// Track active CPU limiters (child processes)
const activeLimiters = new Map(); // ruleId -> { interval, pids }

// --- Icon ---

function createTrayIcon(active) {
  const size = 16;
  const canvas = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const isBorder = x === 0 || x === size - 1 || y === 0 || y === size - 1;
      if (active) {
        canvas[i]     = isBorder ? 200 : 230;  // R - orange
        canvas[i + 1] = isBorder ? 120 : 150;  // G
        canvas[i + 2] = isBorder ? 20  : 30;   // B
      } else {
        canvas[i]     = isBorder ? 100 : 80;
        canvas[i + 1] = isBorder ? 100 : 80;
        canvas[i + 2] = isBorder ? 100 : 80;
      }
      canvas[i + 3] = 255;
    }
  }
  return nativeImage.createFromBuffer(canvas, { width: size, height: size });
}

// --- Window ---

function createWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 880,
    height: 700,
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: createTrayIcon(true),
    title: 'Process Governor',
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);

  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// --- Tray ---

function updateTray() {
  if (!tray) return;
  const hasActive = activeLimiters.size > 0;
  tray.setImage(createTrayIcon(hasActive));
  tray.setToolTip(`Process Governor — ${hasActive ? activeLimiters.size + ' rule(s) active' : 'idle'}`);

  const contextMenu = Menu.buildFromTemplate([
    { label: hasActive ? `${activeLimiters.size} rule(s) active` : 'No active rules', enabled: false },
    { type: 'separator' },
    { label: 'Open Dashboard', click: () => createWindow() },
    { label: 'Stop All Rules', click: () => stopAllRules() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(contextMenu);
}

function createTray() {
  tray = new Tray(createTrayIcon(false));
  updateTray();
  tray.on('double-click', () => createWindow());
}

// --- PowerShell ---

function runPowerShell(command) {
  return new Promise((resolve, reject) => {
    const psCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${command.replace(/"/g, '\\"')}"`;
    exec(psCmd, { windowsHide: true, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout.trim());
    });
  });
}

// --- Process monitoring ---

async function getTopProcesses() {
  const cmd = `Get-Process | Where-Object { $_.CPU -gt 0 } | Sort-Object CPU -Descending | Select-Object -First 50 Id, ProcessName, CPU, @{N='MemoryMB';E={[math]::Round($_.WorkingSet64/1MB,1)}}, Path | ConvertTo-Json -Compress`;
  try {
    const raw = await runPowerShell(cmd);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed : [parsed]).map(p => ({
      pid: p.Id,
      name: p.ProcessName,
      cpuTime: Math.round((p.CPU || 0) * 100) / 100,
      memoryMb: p.MemoryMB || 0,
      path: p.Path || '',
    }));
  } catch (e) {
    return [];
  }
}

async function getSystemStats() {
  const cmd = `$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; $mem = Get-CimInstance Win32_OperatingSystem; @{CPU=[math]::Round($cpu,1);TotalMemGB=[math]::Round($mem.TotalVisibleMemorySize/1MB,1);FreeMemGB=[math]::Round($mem.FreePhysicalMemory/1MB,1);Cores=(Get-CimInstance Win32_Processor).NumberOfLogicalProcessors} | ConvertTo-Json -Compress`;
  try {
    const raw = await runPowerShell(cmd);
    return JSON.parse(raw);
  } catch (e) {
    return { CPU: 0, TotalMemGB: 0, FreeMemGB: 0, Cores: 1 };
  }
}

// --- CPU Limiting via Process Affinity + Priority ---
// Windows doesn't have cgroups, so we use two mechanisms:
// 1. CPU affinity — restrict which cores a process can use
// 2. Process priority — lower priority so OS schedules it less
// 3. Periodic suspend/resume for hard caps (aggressive mode)

async function applyCpuLimit(processName, cpuPercent) {
  const cores = require('os').cpus().length;
  // Calculate how many cores to allow based on percentage
  const allowedCores = Math.max(1, Math.round(cores * (cpuPercent / 100)));

  // Build affinity mask (enable first N cores)
  let mask = 0;
  for (let i = 0; i < allowedCores; i++) {
    mask |= (1 << i);
  }

  // Set affinity + lower priority for all matching processes
  const cmd = `Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessorAffinity = ${mask}; $_.PriorityClass = 'BelowNormal' }`;
  try {
    await runPowerShell(cmd);
    return { status: 'ok', allowedCores, totalCores: cores, mask };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

async function applyMemoryLimit(processName, memoryMb) {
  // Windows Job Objects for memory limits via PowerShell
  // We use a simpler approach: set max working set size
  const bytes = memoryMb * 1024 * 1024;
  const cmd = `Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | ForEach-Object { $_.MaxWorkingSet = ${bytes} }`;
  try {
    await runPowerShell(cmd);
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

async function resetProcessLimits(processName) {
  const cores = require('os').cpus().length;
  let fullMask = 0;
  for (let i = 0; i < cores; i++) fullMask |= (1 << i);

  const cmd = `Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessorAffinity = ${fullMask}; $_.PriorityClass = 'Normal' }`;
  try {
    await runPowerShell(cmd);
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

// --- Rule management ---

function startRule(rule) {
  if (activeLimiters.has(rule.id)) return;

  // Apply immediately, then re-apply periodically (catches new instances)
  const apply = async () => {
    if (rule.cpuPercent && rule.cpuPercent < 100) {
      await applyCpuLimit(rule.processName, rule.cpuPercent);
    }
    if (rule.memoryMb && rule.memoryMb > 0) {
      await applyMemoryLimit(rule.processName, rule.memoryMb);
    }
  };

  apply();
  const interval = setInterval(apply, 5000); // re-apply every 5s for new process instances
  activeLimiters.set(rule.id, { interval, rule });
  updateTray();
  notifyRenderer();
}

function stopRule(ruleId) {
  const limiter = activeLimiters.get(ruleId);
  if (!limiter) return;

  clearInterval(limiter.interval);
  // Reset the process back to normal
  resetProcessLimits(limiter.rule.processName);
  activeLimiters.delete(ruleId);
  updateTray();
  notifyRenderer();
}

function stopAllRules() {
  for (const [id] of activeLimiters) {
    stopRule(id);
  }
}

function notifyRenderer() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rules-changed', getActiveRuleIds());
  }
}

function getActiveRuleIds() {
  return [...activeLimiters.keys()];
}

// --- Presets ---

const PRESETS = {
  'claude-light': {
    name: 'Claude Code — Light',
    rules: [
      { processName: 'node', cpuPercent: 75, memoryMb: 0 },
    ],
  },
  'claude-strict': {
    name: 'Claude Code — Strict',
    rules: [
      { processName: 'node', cpuPercent: 50, memoryMb: 2048 },
      { processName: 'git', cpuPercent: 50, memoryMb: 0 },
    ],
  },
  'build-tools': {
    name: 'Build Tools',
    rules: [
      { processName: 'node', cpuPercent: 60, memoryMb: 0 },
      { processName: 'msbuild', cpuPercent: 60, memoryMb: 0 },
      { processName: 'cl', cpuPercent: 60, memoryMb: 0 },
    ],
  },
  'background-apps': {
    name: 'Background Apps',
    rules: [
      { processName: 'OneDrive', cpuPercent: 25, memoryMb: 512 },
      { processName: 'Teams', cpuPercent: 50, memoryMb: 1024 },
      { processName: 'Slack', cpuPercent: 50, memoryMb: 1024 },
    ],
  },
};

// --- IPC Handlers ---

ipcMain.handle('get-top-processes', () => getTopProcesses());
ipcMain.handle('get-system-stats', () => getSystemStats());

ipcMain.handle('get-rules', () => store.get('rules', []));
ipcMain.handle('get-active-rules', () => getActiveRuleIds());

ipcMain.handle('save-rule', (_, rule) => {
  const rules = store.get('rules', []);
  if (!rule.id) {
    rule.id = `rule_${Date.now()}`;
    rule.createdAt = new Date().toISOString();
    rules.push(rule);
  } else {
    const idx = rules.findIndex(r => r.id === rule.id);
    if (idx >= 0) {
      // If rule was active, stop and restart with new settings
      if (activeLimiters.has(rule.id)) {
        stopRule(rule.id);
      }
      rules[idx] = { ...rules[idx], ...rule };
    }
  }
  store.set('rules', rules);
  return rule;
});

ipcMain.handle('remove-rule', (_, id) => {
  stopRule(id);
  const rules = store.get('rules', []).filter(r => r.id !== id);
  store.set('rules', rules);
  return { status: 'ok' };
});

ipcMain.handle('start-rule', (_, id) => {
  const rules = store.get('rules', []);
  const rule = rules.find(r => r.id === id);
  if (!rule) return { status: 'error', message: 'Rule not found' };
  startRule(rule);
  return { status: 'ok' };
});

ipcMain.handle('stop-rule', (_, id) => {
  stopRule(id);
  return { status: 'ok' };
});

ipcMain.handle('stop-all-rules', () => {
  stopAllRules();
  return { status: 'ok' };
});

ipcMain.handle('apply-preset', (_, presetKey) => {
  const preset = PRESETS[presetKey];
  if (!preset) return { status: 'error', message: 'Unknown preset' };

  const rules = store.get('rules', []);
  const newRules = [];

  for (const pr of preset.rules) {
    const existing = rules.find(r => r.processName === pr.processName);
    if (existing) {
      // Update existing
      existing.cpuPercent = pr.cpuPercent;
      existing.memoryMb = pr.memoryMb;
      if (activeLimiters.has(existing.id)) stopRule(existing.id);
      startRule(existing);
      newRules.push(existing);
    } else {
      const rule = {
        id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: `${preset.name} — ${pr.processName}`,
        processName: pr.processName,
        cpuPercent: pr.cpuPercent,
        memoryMb: pr.memoryMb,
        createdAt: new Date().toISOString(),
      };
      rules.push(rule);
      startRule(rule);
      newRules.push(rule);
    }
  }

  store.set('rules', rules);
  return { status: 'ok', rules: newRules };
});

ipcMain.handle('get-presets', () => PRESETS);

ipcMain.handle('get-settings', () => store.get('settings'));
ipcMain.handle('save-settings', (_, settings) => {
  store.set('settings', settings);
  return { status: 'ok' };
});

ipcMain.handle('kill-process', async (_, pid) => {
  try {
    await runPowerShell(`Stop-Process -Id ${pid} -Force -ErrorAction Stop`);
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
});

ipcMain.handle('check-admin', async () => {
  try {
    const result = await runPowerShell(
      `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`
    );
    return result === 'True';
  } catch (e) {
    return false;
  }
});

ipcMain.handle('self-elevate', async () => {
  const exePath = process.execPath;
  const appPath = app.getAppPath();
  try {
    await runPowerShell(
      `Start-Process '${exePath}' -ArgumentList '"${appPath}"' -Verb RunAs`
    );
    app.isQuitting = true;
    app.quit();
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
});

// --- App lifecycle ---

app.whenReady().then(async () => {
  createTray();

  const settings = store.get('settings');

  // Auto-apply saved rules on launch
  if (settings.autoApplyOnLaunch) {
    const rules = store.get('rules', []);
    for (const rule of rules) {
      if (rule.enabled !== false) {
        startRule(rule);
      }
    }
  }

  if (!settings.startMinimized) {
    createWindow();
  }
});

app.on('window-all-closed', () => { /* keep running in tray */ });
app.on('activate', () => createWindow());
app.on('before-quit', () => {
  app.isQuitting = true;
  stopAllRules();
});
