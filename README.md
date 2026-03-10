# Process Governor

**Free & open-source CPU and memory limiter per-app for Windows.**

Built as a companion to [Bandwidth Governor](https://github.com/Nimba-Solutions/Bandwidth-Governor). When Claude Code, builds, or background apps peg your CPU and eat all your RAM, Process Governor caps them so your machine stays usable.

## Features

- **Per-app CPU limits** — Restrict which cores a process can use (processor affinity)
- **Per-app memory limits** — Cap working set size per process
- **One-click presets** — Claude Code Light/Strict, Build Tools, Background Apps
- **Live system stats** — Real-time CPU%, memory, and core count
- **Process explorer** — See top processes by CPU time, create rules directly
- **Auto-reapply** — Rules re-apply every 5 seconds to catch new process instances
- **System tray** — Runs in background with quick toggle
- **Kill process** — Stop any process from the dashboard
- **Persistent rules** — Rules survive app restarts

## Presets

| Preset | What it does |
|---|---|
| Claude Code — Light | node.exe capped at 75% CPU |
| Claude Code — Strict | node.exe at 50% CPU + 2GB RAM, git at 50% CPU |
| Build Tools | node, msbuild, cl.exe at 60% CPU |
| Background Apps | OneDrive 25%, Teams 50%, Slack 50% |

## Download

Grab the latest portable `.exe` from [Releases](https://github.com/Nimba-Solutions/Process-Governor/releases).

No installation required — run as Administrator for best results.

## Requirements

- Windows 10/11
- Administrator recommended (some processes require elevation to modify)

## Build from source

```bash
npm install
npm run build
```

The portable `.exe` appears in `dist/`.

## Development

```bash
npm start
```

## How it works

Process Governor uses Windows processor affinity (`ProcessorAffinity`) to restrict which CPU cores a process can use, effectively capping its CPU consumption. It also sets process priority to `BelowNormal` and can limit working set memory via `MaxWorkingSet`. Rules re-apply every 5 seconds to catch newly spawned instances.

## License

[BSL 1.1](LICENSE.md) — Converts to Apache 2.0 after four years per release.

**Author:** [Cloud Nimbus LLC](https://cloudnimbusllc.com)
