/**
 * @name         Process Governor
 * @license      BSL 1.1 — See LICENSE.md
 * @description  Electron main process — cross-platform CPU/memory limiter per-app.
 *               Windows: ProcessorAffinity + MaxWorkingSet via PowerShell
 *               Linux:   taskset / cpulimit + prlimit / cgroups v2
 *               macOS:   cpulimit (brew) + renice; memory limiting is restricted by the OS
 * @author       Cloud Nimbus LLC
 */
const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { exec, execFile } = require('child_process');
const guard = require('./process-guard');
const os = require('os');
const fs = require('fs');
const Store = require('electron-store');

const platform = process.platform; // 'win32', 'darwin', 'linux'

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

// --- Shell helpers ---

/**
 * Run a PowerShell command (Windows only).
 */
function runPowerShell(command) {
  const psCmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "${command.replace(/"/g, '\\"')}"`;
  return guard.execPromise(psCmd).then(s => (s || '').trim());
}

/**
 * Run a shell command (macOS / Linux).
 */
function runShell(command) {
  return guard.execPromise(command).then(s => (s || '').trim());
}

// --- Process monitoring ---

async function getTopProcesses() {
  if (platform === 'win32') {
    return getTopProcessesWindows();
  }
  // macOS and Linux both use `ps aux`
  return getTopProcessesUnix();
}

async function getTopProcessesWindows() {
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

async function getTopProcessesUnix() {
  // ps aux columns: USER PID %CPU %MEM VSZ RSS TT STAT STARTED TIME COMMAND
  // Sort by CPU descending, take top 50
  try {
    const raw = await runShell('ps aux --sort=-%cpu 2>/dev/null || ps aux -r');
    if (!raw) return [];
    const lines = raw.split('\n');
    // Skip header line
    const processes = [];
    for (let i = 1; i < lines.length && processes.length < 50; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      // Split on whitespace, but COMMAND can contain spaces so limit the split
      const parts = line.split(/\s+/);
      if (parts.length < 11) continue;
      const pid = parseInt(parts[1], 10);
      const cpuPercent = parseFloat(parts[2]) || 0;
      const rssMb = Math.round((parseInt(parts[5], 10) || 0) / 1024 * 10) / 10; // RSS is in KB
      const command = parts.slice(10).join(' ');
      // Extract the process name from the command path
      const name = path.basename(command.split(' ')[0]);
      if (cpuPercent <= 0) continue;
      processes.push({
        pid,
        name,
        cpuTime: cpuPercent, // on Unix we report current CPU% rather than cumulative time
        memoryMb: rssMb,
        path: command.split(' ')[0],
      });
    }
    return processes;
  } catch (e) {
    return [];
  }
}

async function getSystemStats() {
  if (platform === 'win32') {
    return getSystemStatsWindows();
  }
  return getSystemStatsUnix();
}

async function getSystemStatsWindows() {
  const cmd = `$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average; $mem = Get-CimInstance Win32_OperatingSystem; @{CPU=[math]::Round($cpu,1);TotalMemGB=[math]::Round($mem.TotalVisibleMemorySize/1MB,1);FreeMemGB=[math]::Round($mem.FreePhysicalMemory/1MB,1);Cores=(Get-CimInstance Win32_Processor).NumberOfLogicalProcessors} | ConvertTo-Json -Compress`;
  try {
    const raw = await runPowerShell(cmd);
    return JSON.parse(raw);
  } catch (e) {
    return { CPU: 0, TotalMemGB: 0, FreeMemGB: 0, Cores: 1 };
  }
}

async function getSystemStatsUnix() {
  // Use Node.js os module for cross-platform system info
  const cores = os.cpus().length;
  const totalMemGB = Math.round(os.totalmem() / (1024 * 1024 * 1024) * 10) / 10;
  const freeMemGB = Math.round(os.freemem() / (1024 * 1024 * 1024) * 10) / 10;

  // Get CPU load percentage from os.loadavg (1-minute average, normalized to core count)
  const loadAvg1m = os.loadavg()[0];
  const cpuPercent = Math.round((loadAvg1m / cores) * 100 * 10) / 10;

  return {
    CPU: Math.min(cpuPercent, 100),
    TotalMemGB: totalMemGB,
    FreeMemGB: freeMemGB,
    Cores: cores,
  };
}

// --- CPU Limiting ---
// Windows: ProcessorAffinity + PriorityClass via PowerShell
// Linux:   taskset for CPU affinity (direct equivalent of ProcessorAffinity)
//          Also supports cpulimit for percentage-based throttling
// macOS:   CPU affinity is NOT supported by the OS.
//          Uses cpulimit (brew install cpulimit) for percentage-based throttling.
//          Falls back to renice for priority-based soft limiting.

async function applyCpuLimit(processName, cpuPercent) {
  if (platform === 'win32') {
    return applyCpuLimitWindows(processName, cpuPercent);
  }
  if (platform === 'linux') {
    return applyCpuLimitLinux(processName, cpuPercent);
  }
  // darwin
  return applyCpuLimitMac(processName, cpuPercent);
}

async function applyCpuLimitWindows(processName, cpuPercent) {
  const cores = os.cpus().length;
  const allowedCores = Math.max(1, Math.round(cores * (cpuPercent / 100)));

  let mask = 0;
  for (let i = 0; i < allowedCores; i++) {
    mask |= (1 << i);
  }

  const cmd = `Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | ForEach-Object { $_.ProcessorAffinity = ${mask}; $_.PriorityClass = 'BelowNormal' }`;
  try {
    await runPowerShell(cmd);
    return { status: 'ok', allowedCores, totalCores: cores, mask };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

async function applyCpuLimitLinux(processName, cpuPercent) {
  const cores = os.cpus().length;
  const allowedCores = Math.max(1, Math.round(cores * (cpuPercent / 100)));

  // Build affinity mask (enable first N cores) — same concept as Windows ProcessorAffinity
  let mask = 0;
  for (let i = 0; i < allowedCores; i++) {
    mask |= (1 << i);
  }
  const hexMask = '0x' + mask.toString(16);

  try {
    // Find all PIDs matching the process name
    const pidOutput = await runShell(`pgrep -x '${processName}' 2>/dev/null || true`);
    const pids = pidOutput.split('\n').filter(p => p.trim());
    if (pids.length === 0) {
      return { status: 'ok', allowedCores, totalCores: cores, mask, note: 'No matching processes found' };
    }

    const errors = [];
    for (const pid of pids) {
      try {
        // taskset is the direct Linux equivalent of Windows ProcessorAffinity
        await runShell(`taskset -p ${hexMask} ${pid.trim()}`);
        // Also lower the priority (renice)
        await runShell(`renice +10 -p ${pid.trim()} 2>/dev/null || true`);
      } catch (e) {
        errors.push(`PID ${pid}: ${e.message}`);
      }
    }

    if (errors.length > 0 && errors.length === pids.length) {
      return { status: 'error', message: errors.join('; ') };
    }
    return { status: 'ok', allowedCores, totalCores: cores, mask };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

async function applyCpuLimitMac(processName, cpuPercent) {
  // macOS does NOT support CPU affinity (the OS does not expose per-process core pinning).
  // Strategy:
  //   1. Try cpulimit (brew install cpulimit) for percentage-based throttling
  //   2. Fall back to renice for soft priority-based limiting
  const cores = os.cpus().length;
  // cpulimit -l expects percentage of a single core, so 50% of 8 cores = 400%
  // But we want cpuPercent to mean "percentage of total system CPU", so scale accordingly
  const cpulimitPercent = Math.max(1, Math.round(cpuPercent * cores));

  try {
    const pidOutput = await runShell(`pgrep -x '${processName}' 2>/dev/null || true`);
    const pids = pidOutput.split('\n').filter(p => p.trim());
    if (pids.length === 0) {
      return { status: 'ok', totalCores: cores, note: 'No matching processes found' };
    }

    // Check if cpulimit is available
    let hasCpulimit = false;
    try {
      await runShell('which cpulimit');
      hasCpulimit = true;
    } catch (_) { /* not installed */ }

    const results = [];
    for (const pid of pids) {
      const trimmedPid = pid.trim();
      if (hasCpulimit) {
        try {
          // Kill any existing cpulimit for this PID first
          await runShell(`pkill -f 'cpulimit.*-p ${trimmedPid}' 2>/dev/null || true`);
          // Launch cpulimit in background — it will throttle the process continuously
          // Using per-core percentage: cpulimit -l <percent> -p <pid> -b (background)
          const perProcessLimit = Math.max(1, Math.round(cpuPercent));
          await runShell(`cpulimit -p ${trimmedPid} -l ${perProcessLimit} -b 2>/dev/null`);
          results.push({ pid: trimmedPid, method: 'cpulimit' });
        } catch (e) {
          // Fall back to renice
          await runShell(`renice +10 -p ${trimmedPid} 2>/dev/null || true`);
          results.push({ pid: trimmedPid, method: 'renice', note: 'cpulimit failed, used renice' });
        }
      } else {
        // No cpulimit available, use renice as a soft alternative
        await runShell(`renice +10 -p ${trimmedPid} 2>/dev/null || true`);
        results.push({ pid: trimmedPid, method: 'renice' });
      }
    }

    return {
      status: 'ok',
      totalCores: cores,
      method: hasCpulimit ? 'cpulimit' : 'renice',
      note: hasCpulimit
        ? undefined
        : 'CPU affinity not supported on macOS. Using renice for priority-based limiting. Install cpulimit (brew install cpulimit) for percentage-based throttling.',
      results,
    };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

// --- Memory Limiting ---
// Windows: MaxWorkingSet via PowerShell
// Linux:   prlimit --as=<bytes> for existing processes (simpler than cgroups)
//          Alternatively cgroups v2: /sys/fs/cgroup/pg/<name>/memory.max
// macOS:   Very limited. ulimit -v only works for new processes, cannot limit existing ones.
//          This is an OS-level limitation. The return data includes a note for the UI.

async function applyMemoryLimit(processName, memoryMb) {
  if (platform === 'win32') {
    return applyMemoryLimitWindows(processName, memoryMb);
  }
  if (platform === 'linux') {
    return applyMemoryLimitLinux(processName, memoryMb);
  }
  // darwin
  return applyMemoryLimitMac(processName, memoryMb);
}

async function applyMemoryLimitWindows(processName, memoryMb) {
  const bytes = memoryMb * 1024 * 1024;
  const cmd = `Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | ForEach-Object { $_.MaxWorkingSet = ${bytes} }`;
  try {
    await runPowerShell(cmd);
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

async function applyMemoryLimitLinux(processName, memoryMb) {
  // Use prlimit to set address space limit on existing processes.
  // prlimit --pid <pid> --as=<bytes> is simpler than cgroups and doesn't require cgroup setup.
  const bytes = memoryMb * 1024 * 1024;

  try {
    const pidOutput = await runShell(`pgrep -x '${processName}' 2>/dev/null || true`);
    const pids = pidOutput.split('\n').filter(p => p.trim());
    if (pids.length === 0) {
      return { status: 'ok', note: 'No matching processes found' };
    }

    const errors = [];
    for (const pid of pids) {
      try {
        await runShell(`prlimit --pid ${pid.trim()} --as=${bytes}`);
      } catch (e) {
        errors.push(`PID ${pid}: ${e.message}`);
      }
    }

    if (errors.length > 0 && errors.length === pids.length) {
      return { status: 'error', message: errors.join('; ') };
    }
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

async function applyMemoryLimitMac(processName, memoryMb) {
  // macOS limitation: there is no reliable way to limit memory of an already-running process.
  // - ulimit -v only applies to new child processes, not existing ones.
  // - There are no cgroups on macOS.
  // - There is no prlimit equivalent.
  // We return a warning so the UI can display the limitation to the user.
  return {
    status: 'unsupported',
    message: 'Memory limiting for existing processes is not supported on macOS. '
      + 'The OS does not provide an API to cap memory of running processes. '
      + 'ulimit -v only applies to newly spawned child processes.',
    note: 'macOS does not support memory limits on running processes.',
  };
}

// --- Reset / remove limits ---

async function resetProcessLimits(processName) {
  if (platform === 'win32') {
    return resetProcessLimitsWindows(processName);
  }
  if (platform === 'linux') {
    return resetProcessLimitsLinux(processName);
  }
  return resetProcessLimitsMac(processName);
}

async function resetProcessLimitsWindows(processName) {
  const cores = os.cpus().length;
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

async function resetProcessLimitsLinux(processName) {
  const cores = os.cpus().length;
  let fullMask = 0;
  for (let i = 0; i < cores; i++) fullMask |= (1 << i);
  const hexMask = '0x' + fullMask.toString(16);

  try {
    const pidOutput = await runShell(`pgrep -x '${processName}' 2>/dev/null || true`);
    const pids = pidOutput.split('\n').filter(p => p.trim());
    for (const pid of pids) {
      const trimmedPid = pid.trim();
      // Restore full CPU affinity
      await runShell(`taskset -p ${hexMask} ${trimmedPid} 2>/dev/null || true`);
      // Restore normal priority
      await runShell(`renice 0 -p ${trimmedPid} 2>/dev/null || true`);
      // Remove prlimit memory restriction (set to unlimited)
      await runShell(`prlimit --pid ${trimmedPid} --as=unlimited 2>/dev/null || true`);
    }
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

async function resetProcessLimitsMac(processName) {
  try {
    const pidOutput = await runShell(`pgrep -x '${processName}' 2>/dev/null || true`);
    const pids = pidOutput.split('\n').filter(p => p.trim());
    for (const pid of pids) {
      const trimmedPid = pid.trim();
      // Kill any cpulimit processes targeting this PID
      await runShell(`pkill -f 'cpulimit.*-p ${trimmedPid}' 2>/dev/null || true`);
      // Restore normal priority
      await runShell(`renice 0 -p ${trimmedPid} 2>/dev/null || true`);
    }
    // Also kill any cpulimit targeting by name (belt and suspenders)
    await runShell(`pkill -f 'cpulimit.*${processName}' 2>/dev/null || true`);
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
ipcMain.handle('get-platform-info', () => ({
  platform,
  arch: process.arch,
  cpuAffinitySupported: platform !== 'darwin',
  memoryLimitSupported: platform !== 'darwin',
  cores: os.cpus().length,
  totalMemGB: Math.round(os.totalmem() / (1024 * 1024 * 1024) * 10) / 10,
}));

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
    if (platform === 'win32') {
      await runPowerShell(`Stop-Process -Id ${pid} -Force -ErrorAction Stop`);
    } else {
      await runShell(`kill -9 ${pid}`);
    }
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
});

ipcMain.handle('check-admin', async () => {
  try {
    if (platform === 'win32') {
      const result = await runPowerShell(
        `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`
      );
      return result === 'True';
    }
    if (platform === 'darwin') {
      // Check if user is in the admin group
      const result = await runShell('id -Gn');
      return result.split(/\s+/).includes('admin');
    }
    // Linux: check if running as root
    const result = await runShell('id -u');
    return result.trim() === '0';
  } catch (e) {
    return false;
  }
});

ipcMain.handle('self-elevate', async () => {
  const exePath = process.execPath;
  const appPath = app.getAppPath();
  try {
    if (platform === 'win32') {
      await runPowerShell(
        `Start-Process '${exePath}' -ArgumentList '"${appPath}"' -Verb RunAs`
      );
    } else if (platform === 'darwin') {
      // Use osascript to prompt for admin privileges on macOS
      await runShell(
        `osascript -e 'do shell script "\\\"${exePath}\\\" \\\"${appPath}\\\" &" with administrator privileges'`
      );
    } else {
      // Linux: use pkexec for graphical privilege escalation
      await runShell(`pkexec "${exePath}" "${appPath}" &`);
    }
    app.isQuitting = true;
    app.quit();
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
});

ipcMain.handle('set-auto-start', async (_, enabled) => {
  try {
    if (platform === 'win32') {
      return await setAutoStartWindows(enabled);
    }
    if (platform === 'darwin') {
      return await setAutoStartMac(enabled);
    }
    return await setAutoStartLinux(enabled);
  } catch (e) {
    return { status: 'error', message: e.message };
  }
});

// --- Auto-start helpers ---

async function setAutoStartWindows(enabled) {
  const exePath = process.execPath;
  if (enabled) {
    await runPowerShell(
      `Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'ProcessGovernor' -Value '"${exePath}"'`
    );
  } else {
    await runPowerShell(
      `Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'ProcessGovernor' -ErrorAction SilentlyContinue`
    );
  }
  return { status: 'ok' };
}

async function setAutoStartMac(enabled) {
  const plistName = 'com.cloudnimbus.process-governor';
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${plistName}.plist`);
  const exePath = process.execPath;

  if (enabled) {
    const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${plistName}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${exePath}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`;
    // Ensure LaunchAgents directory exists
    const dir = path.dirname(plistPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(plistPath, plistContent, 'utf-8');
  } else {
    if (fs.existsSync(plistPath)) {
      fs.unlinkSync(plistPath);
    }
  }
  return { status: 'ok' };
}

async function setAutoStartLinux(enabled) {
  const desktopName = 'process-governor';
  const autostartDir = path.join(os.homedir(), '.config', 'autostart');
  const desktopPath = path.join(autostartDir, `${desktopName}.desktop`);
  const exePath = process.execPath;

  if (enabled) {
    const desktopContent = `[Desktop Entry]
Type=Application
Name=Process Governor
Exec="${exePath}"
X-GNOME-Autostart-enabled=true
Hidden=false
NoDisplay=false
Comment=CPU and memory limiter
`;
    if (!fs.existsSync(autostartDir)) {
      fs.mkdirSync(autostartDir, { recursive: true });
    }
    fs.writeFileSync(desktopPath, desktopContent, 'utf-8');
  } else {
    if (fs.existsSync(desktopPath)) {
      fs.unlinkSync(desktopPath);
    }
  }
  return { status: 'ok' };
}

// --- Single instance lock ---

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

// --- App lifecycle ---

if (gotLock) {
app.whenReady().then(async () => {
  guard.init(app);
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
}

app.on('window-all-closed', () => { /* keep running in tray */ });
app.on('activate', () => { if (gotLock) createWindow(); });
app.on('before-quit', () => {
  app.isQuitting = true;
  stopAllRules();
});
