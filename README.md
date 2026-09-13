# cproxy — run Claude Code against llama.cpp (Windows)

I don't use lmstudo/ollama etc at home, it's either llama-server or vll running on dedicated box. claude on another. on windoze claude in vscode wanter such a proxy (somehow on linux it works without ! :-P). + on linux i use my crouter... 

**cproxy** is a zero-dependency translation proxy that lets [Claude Code](https://docs.anthropic.com/en/docs/claude-code) talk to an OpenAI-compatible server such as llama.cpp's `llama-server`. No npm packages, no build step — just Node.js. It runs as a **real Windows service**: it starts at boot (no logon needed), survives logoff, and auto-restarts if it crashes.

```
┌──────────────┐   Anthropic /v1/messages    ┌─────────────┐   OpenAI /chat/completions   ┌──────────────────┐
│  Claude Code │ ──────────────────────────► │ cproxy      │ ───────────────────────────► │ llama-server     │
│ (VS Code,    │ ◄────────────────────────── │ :8787       │ ◄─────────────────────────── │ tr4:8080         │
│  Cygwin, CLI)│                             │ (this box,  │                              │ (your GPU host)  │
└──────────────┘                             │  a service) │                              └──────────────────┘
                                             └─────────────┘
```

## Why a proxy?

Claude Code speaks **only** the Anthropic Messages API (`POST /v1/messages`, `x-api-key`, streaming SSE events like `content_block_delta`). Recent Claude Code builds have no OpenAI-compatibility mode. `llama-server` speaks only the OpenAI Chat Completions API. cproxy sits in between and translates both directions, including:

- **Streaming** (SSE) — text deltas *and* tool-call argument fragments
- **Tool calls / MCP tools** (`tool_use` ↔ `function`, `tool_result` ↔ `role:"tool"`)
- System prompts, images, stop sequences, temperature/top_p/max_tokens
- Token usage accounting (handles llama.cpp's quirk of sending `usage` in a separate final chunk after `finish_reason`)

## Requirements

| Component | Notes |
|---|---|
| **Windows 10/11** | Any edition. The installer prompts UAC once to register the service; day-to-day use needs no admin. |
| **Node.js ≥ 18** | From <https://nodejs.org> (LTS is fine). Used to run `proxy.mjs`, Claude Code, and the one-time service registration. |
| **An OpenAI-compatible LLM server** | e.g. `llama-server` on a GPU box, Ollama, vLLM, LM Studio — anything serving `/v1/chat/completions`. |

The proxy itself has **zero npm dependencies**. The only package ever installed is `node-windows`, dropped into `vendor\` at install time purely to register the service (it's not needed once the service exists).

## Quick start (2 steps)

### 1. Install

Double-click **`install.cmd`** (or run it in a terminal). It will:

1. Check that Node.js is on PATH
2. `npm install -g @anthropic-ai/claude-code` (skipped if already installed)
3. Write `%USERPROFILE%\.claude\settings.json` pointing Claude Code at the proxy (existing file backed up to `settings.json.bak`)
4. Write `proxy.env` next to the script with your upstream URL
5. Install `node-windows` into `vendor\` (offline-capable service bridge)
6. **Register and start `cproxy.exe` as a Windows service** — prompts UAC if you didn't run from an elevated terminal
7. Remove any old Startup-folder autostart so the proxy doesn't double-launch

You can pass your own upstream, model, and port:

```bat
install.cmd http://tr4:8080/v1 qwen3.8-27b 8787
```

### 2. Run Claude Code

In any terminal — VS Code integrated terminal, PowerShell, cmd, Cygwin:

```bat
claude
```

Quick smoke test:

```bat
claude -p "Reply with exactly: OK"
```

You should see `OK`. A harmless diagnostic line `[claude-code:unrecognized_model] {"model":"qwen3.8-27b",...}` may appear — that's just Claude Code noting the model ID isn't a known Anthropic one; ignore it.

That's all — the proxy is already running as a service and will come back on its own after reboots or crashes.

## The Windows service

The service is registered under the SCM id **`cproxy.exe`** (display name `cproxy`) by [node-windows](https://github.com/felixge/node-windows), which generates a small WinSW-style host (`daemon\cproxy.exe` + `daemon\cproxy.xml`). Because it's a genuine service:

- It starts at **boot**, not logon — no one has to be signed in.
- It survives logoff and screen lock.
- If the process dies, SCM restarts it (WinSW default).
- Its stdout/stderr go to `logs\cproxy-out.log` / `logs\cproxy-err.log`.

Manage it with **`service.cjs`** (run from the install folder):

```bat
node service.cjs status                 state + current startup params (no admin)
node service.cjs start | stop           control the service (admin)
node service.cjs restart                robust stop→wait→start (admin)
node service.cjs set --port 8787        change startup params, then auto-restarts (admin)
node service.cjs set --upstream http://tr4:8080/v1
node service.cjs uninstall              stop + remove the service (admin)
```

### Changing port / host / upstream without touching code

The proxy's `--port`, `--host` and optional `--upstream` are **startup parameters** baked into two places at install time:

- `daemon\cproxy.xml` — what WinSW actually reads when it starts the service (authoritative)
- registry `HKLM\SYSTEM\CurrentControlSet\Services\cproxy.exe\Parameters` (REG_SZ) — visible in regedit / service tools

Change them any of these ways, then restart:

```bat
node service.cjs set --port 8790 --host 127.0.0.1        :: new port
node service.cjs set --upstream ""                        :: drop the flag → proxy.env decides
```

or edit `daemon\cproxy.xml` / the registry value by hand, then `node service.cjs restart`. If you change the **port**, also update `ANTHROPIC_BASE_URL` in `%USERPROFILE%\.claude\settings.json` to match.

> Note: on this machine the live install lives at `C:\Users\andrei\claude-llama-proxy` (system drive). The git repo is a separate dev copy; keep them in sync if you edit code by hand.

## Configuration

### Where things live

| File | Purpose |
|---|---|
| `proxy.mjs` | The proxy itself (single file, no deps) + the upstream health monitor |
| `service.cjs` | Service manager: install / set / start / stop / restart / status / uninstall |
| `install.cmd` | One-shot installer (Node check, npm installs, settings.json, service registration) |
| `start-proxy.cmd` | Optional manual launcher with a port guard — for running *without* the service |
| `proxy.env` | Your configuration — created by the installer, edit freely |
| `daemon\cproxy.xml`, `daemon\cproxy.exe` | WinSW host + config generated at install (service definition) |
| `logs\cproxy-out.log`, `logs\cproxy-err.log` | Service stdout/stderr |
| `%USERPROFILE%\.claude\settings.json` | Claude Code env vars written by the installer |

### `proxy.env` (per-machine config)

Plain `KEY=VALUE` lines; `#` starts a comment. Loaded by `proxy.mjs` at startup from its own directory. **Precedence: CLI flags (`--port/--host/--upstream`) > real environment variables > `proxy.env`.** So the service's baked-in startup params win over this file, and anything you export in your shell wins over both.

```ini
# Where your OpenAI-compatible server lives (no trailing slash needed)
UPSTREAM=http://tr4:8080/v1

# Optional overrides — defaults shown
PORT=8787
HOST=127.0.0.1
HEALTH_POLL_MS=5000            ; how often to probe the upstream while deciding if it's alive
# UPSTREAM_MODEL=my-model-id   ; force a model id upstream regardless of what Claude Code sends
# STRIP_TOOLS=1                ; drop tools from requests (for servers without function-calling)
# LOG=0                        ; silence request logging
# UPSTREAM_KEY=secret          ; Bearer token for the upstream (default: "llama")
```

After editing, restart the service (`node service.cjs restart`) — or just `start-proxy.cmd` again if you're running it manually.

### All environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Local port the proxy listens on |
| `HOST` | `127.0.0.1` | Bind address (keep local unless you need LAN access) |
| `UPSTREAM` | `http://localhost:8080/v1` | OpenAI-compatible base URL of your LLM server |
| `HEALTH_POLL_MS` | `5000` | Milliseconds between upstream liveness probes |
| `UPSTREAM_MODEL` | *(pass-through)* | Force this model id on every upstream request |
| `STRIP_TOOLS` | off | Set `1` to remove tools from requests (server without function calling) |
| `LOG` | on | Set `0` for quiet logging |
| `UPSTREAM_KEY` | `llama` | Bearer token sent to the upstream server |

### Claude Code side (`settings.json`)

The installer writes this; tweak values as needed:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8787",
    "ANTHROPIC_API_KEY": "llama-proxy-local",
    "ANTHROPIC_MODEL": "qwen3.8-27b",
    "MAX_THINKING_TOKENS": "0",
    "DISABLE_PROMPT_CACHING": "1",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "4096"
  }
}
```

Notes:

- `ANTHROPIC_API_KEY` can be any non-empty string — the proxy doesn't check it (set a real one only if your upstream does).
- `MAX_THINKING_TOKENS=0` disables extended thinking, which most local models don't support.
- `DISABLE_PROMPT_CACHING=1` avoids caching features llama.cpp can't honor.
- If you want Claude Code to use a *different* model name than what the server expects, set `ANTHROPIC_MODEL` here and `UPSTREAM_MODEL` in `proxy.env`.

## Upstream health monitor & graceful 503s

On startup (and continuously) the proxy probes `{UPSTREAM}/models` every `HEALTH_POLL_MS` (default 5 s, 3 s timeout). **Any** HTTP response counts as "alive"; only a network error or timeout means "down". This matters because your GPU box may take a while to boot its model after you power it on.

Behavior:

- When the upstream first goes down, the proxy logs **one** line (`upstream tr4:8080 is DOWN — ...`) and stays quiet until it changes state again.
- While the upstream is down, every `POST /v1/messages` gets a **503** (not 502) with an Anthropic-shaped error body and a `Retry-After` header:

  ```json
  { "error": { "type": "upstream_unavailable",
      "message": "Upstream LLM server (tr4:8080) is not available yet. The proxy is running and will retry automatically — please try again in a few seconds." } }
  ```

  Claude Code treats 503 as retryable, so it backs off and retries on its own instead of surfacing a hard failure.
- When the upstream returns, the proxy logs **one** line (`upstream tr4:8080 is back — resuming requests`) and traffic flows normally again.

Check live status any time:

```bat
curl http://127.0.0.1:8787/health
:: { "ok": true, "upstream": "http://tr4:8080/v1", "upstream_up": true }
```

`upstream_up` is `true`/`false` (or `null` before the first probe completes).

## Using it with Cygwin (optional)

If you also run Claude Code inside a **Cygwin** terminal on the same machine, no second install is needed — the native Windows binary runs fine under Cygwin. Create `/usr/local/bin/claude`:

```bash
#!/bin/bash
# IMPORTANT: use #!/bin/bash, NOT #!/usr/bin/env bash.
# On some machines `env` resolves to WSL's system32 bash, which cannot read
# /cygdrive paths and fails with exit 127 "No such file or directory".
export HOME="C:\Users\<your-user>"
export USERPROFILE="C:\Users\<your-user>"
exec "/cygdrive/c/Users/<your-user>/AppData/Roaming/npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe" "$@"
```

`chmod +x /usr/local/bin/claude`, and `claude` works in Cygwin sharing the same config/session history as your Windows terminals. (Write the file with LF line endings.)

## How it works (the interesting bits)

- **Request direction** — Anthropic messages are flattened to OpenAI: `system` becomes a system message; `tool_result` blocks become separate `role:"tool"` messages; `tool_use` blocks become `tool_calls`; tools use `input_schema` → `parameters`. Claude Code appends `?beta=true` to the URL, so routing matches on pathname only.
- **Response direction (streaming)** — OpenAI SSE chunks are re-emitted as Anthropic events: `message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`. Tool-call argument fragments stream through as `input_json_delta`.
- **The llama.cpp usage quirk** — llama-server sends the `finish_reason` chunk, *then* a separate empty-choices chunk carrying `usage`, then `[DONE]`. The proxy waits for that final usage chunk before emitting `message_delta`/`message_stop`, so Claude Code's token accounting (and context compaction) stays correct.
- **Prompt caching** — Anthropic-style `cache_control` markers are accepted and stripped during translation (OpenAI has no equivalent field, and llama.cpp reuses prompt prefixes implicitly via its KV cache). When your server reports KV-cache stats (`prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`, available in recent llama-server builds), the proxy maps them to Anthropic's `usage.cache_read_input_tokens` / `cache_creation_input_tokens` — so Claude Code shows real cache-hit numbers, and `input_tokens` is reported as the non-cached portion only (matching Anthropic semantics). Servers without those fields behave exactly as before.
- **Health check** — `GET http://127.0.0.1:8787/health` returns `{ "ok": true, "upstream": "...", "upstream_up": true }`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ECONNREFUSED 127.0.0.1:8787` in Claude Code | Service isn't running — `node service.cjs status`, then `start`; check `logs\cproxy-err.log` |
| `upstream_unavailable ... not available yet` (503) | Your LLM server is down or still loading its model — wait; the proxy retries automatically. Verify with a browser/curl on the GPU host |
| `upstream error ECONNREFUSED tr4:8080` (in logs) | Upstream went down mid-request — same as above |
| `There's an issue with the selected model` | Usually upstream returned 4xx/5xx — read the service logs; also check the model name in `settings.json` / `UPSTREAM_MODEL` |
| Service won't start, port in use | Something else owns the port — change it via `node service.cjs set --port N` **and** update `ANTHROPIC_BASE_URL` in `settings.json` to match |
| PowerShell says `claude is not recognized` but it works in cmd | Use `claude.cmd`, or run from a new terminal after install (PATH refresh) |
| Cygwin: `/bin/bash: /usr/local/bin/claude: No such file or directory` (exit 127) | Shebang problem — use `#!/bin/bash` directly, not `#!/usr/bin/env bash`; ensure LF line endings |
| Garbled/empty responses from a non-llama.cpp server | Try `STRIP_TOOLS=1`, or check that your server supports streaming + `stream_options.include_usage` (Ollama/vLLM do) |

Logs: the service's stdout/stderr are in `logs\cproxy-out.log` and `logs\cproxy-err.log`; Claude Code's own debug logs are in `%USERPROFILE%\.claude\debug\<session-id>.txt`.

## Uninstall

```bat
node service.cjs uninstall            :: stop + remove the cproxy.exe service (admin)
npm uninstall -g @anthropic-ai/claude-code
del "%USERPROFILE%\.claude\settings.json"   (or restore settings.json.bak)
```

Then delete the install folder. The proxy leaves no other traces.
