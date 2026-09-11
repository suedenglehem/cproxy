# cproxy — run Claude Code against llama.cpp (Windows)

**cproxy** is a zero-dependency translation proxy that lets [Claude Code](https://docs.anthropic.com/en/docs/claude-code) talk to an OpenAI-compatible server such as llama.cpp's `llama-server`. No npm packages, no build step — just Node.js.

```
┌──────────────┐   Anthropic /v1/messages    ┌─────────────┐   OpenAI /chat/completions   ┌──────────────────┐
│  Claude Code │ ──────────────────────────► │ cproxy      │ ───────────────────────────► │ llama-server     │
│ (VS Code,    │ ◄────────────────────────── │ :8787       │ ◄─────────────────────────── │ tr4:8080         │
│  Cygwin, CLI)│                             │ (this box)  │                              │ (your GPU host)  │
└──────────────┘                             └─────────────┘                              └──────────────────┘
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
| **Windows 10/11** | Any edition; no admin needed for the default install |
| **Node.js ≥ 18** | From <https://nodejs.org> (LTS is fine). Only used to run `proxy.mjs` and Claude Code itself. |
| **An OpenAI-compatible LLM server** | e.g. `llama-server` on a GPU box, Ollama, vLLM, LM Studio — anything serving `/v1/chat/completions`. |

That's it. The proxy has **zero npm dependencies**.

## Quick start (3 steps)

### 1. Install

Double-click **`install.cmd`** (or run it in a terminal). It will:

1. Check that Node.js is on PATH
2. `npm install -g @anthropic-ai/claude-code` (skipped if already installed)
3. Write `%USERPROFILE%\.claude\settings.json` pointing Claude Code at the proxy (existing file backed up to `settings.json.bak`)
4. Drop a copy of `start-proxy.cmd` into your **Startup** folder so the proxy auto-starts at logon

You can pass your own upstream and model:

```bat
install.cmd http://tr4:8080/v1 qwen3.8-27b
```

### 2. Start the proxy

```bat
start-proxy.cmd
```

It's port-guarded — running it again while the proxy is up does nothing. It prints `[cproxy] already listening on port 8787` and exits. The proxy binds **only to `127.0.0.1:8787`**, so your local port 8080 (or any other) stays free for other things; the connection to your LLM server is outbound.

### 3. Run Claude Code

In any terminal — VS Code integrated terminal, PowerShell, cmd, Cygwin:

```bat
claude
```

Quick smoke test:

```bat
claude -p "Reply with exactly: OK"
```

You should see `OK`. A harmless diagnostic line `[claude-code:unrecognized_model] {"model":"qwen3.8-27b",...}` may appear — that's just Claude Code noting the model ID isn't a known Anthropic one; ignore it.

## Configuration

### Where things live

| File | Purpose |
|---|---|
| `proxy.mjs` | The proxy itself (single file, no deps) |
| `start-proxy.cmd` | Launcher with port guard + config loading |
| `install.cmd` | One-shot installer (Node check, npm install, settings.json, Startup entry) |
| `proxy.env` | Your configuration — created by the installer, edit freely |
| `%USERPROFILE%\.claude\settings.json` | Claude Code env vars written by the installer |

### `proxy.env` (per-machine config)

Plain `KEY=VALUE` lines; `#` starts a comment. The launcher loads it before starting:

```ini
# Where your OpenAI-compatible server lives (no trailing slash needed)
UPSTREAM=http://tr4:8080/v1

# Optional overrides — defaults shown
PORT=8787
HOST=127.0.0.1
# UPSTREAM_MODEL=my-model-id     ; force a model id upstream regardless of what Claude Code sends
# STRIP_TOOLS=1                  ; drop tools from requests (for servers without function-calling)
# LOG=0                          ; silence request logging
# UPSTREAM_KEY=secret            ; Bearer token for the upstream (default: "llama")
```

After editing, stop the proxy (`taskkill /F /IM node.exe` or restart the machine) and run `start-proxy.cmd` again.

### All environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Local port the proxy listens on |
| `HOST` | `127.0.0.1` | Bind address (keep local unless you need LAN access) |
| `UPSTREAM` | `http://localhost:8080/v1` | OpenAI-compatible base URL of your LLM server |
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
- **Health check** — `GET http://127.0.0.1:8787/health` returns `{ "ok": true, "upstream": "..." }`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `ECONNREFUSED 127.0.0.1:8787` in Claude Code | Proxy isn't running — run `start-proxy.cmd`, check `proxy.log` |
| `upstream error ECONNREFUSED tr4:8080` (in proxy.log) | Your LLM server is down or unreachable — verify with a browser/curl on the GPU host |
| `There's an issue with the selected model` | Usually upstream returned 4xx/5xx — read `proxy.log`; also check the model name in `settings.json` / `UPSTREAM_MODEL` |
| PowerShell says `claude is not recognized` but it works in cmd | Use `claude.cmd`, or run from a new terminal after install (PATH refresh) |
| Cygwin: `/bin/bash: /usr/local/bin/claude: No such file or directory` (exit 127) | Shebang problem — use `#!/bin/bash` directly, not `#!/usr/bin/env bash`; ensure LF line endings |
| Proxy won't start, port in use | Something else owns the port — change `PORT` in `proxy.env` **and** `ANTHROPIC_BASE_URL` in `settings.json` to match |
| Garbled/empty responses from a non-llama.cpp server | Try `STRIP_TOOLS=1`, or check that your server supports streaming + `stream_options.include_usage` (Ollama/vLLM do) |

Logs: proxy request log is `proxy.log` next to the launcher; Claude Code's own debug logs are in `%USERPROFILE%\.claude\debug\<session-id>.txt`.

## Uninstall

```bat
del "%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\cproxy.cmd"
npm uninstall -g @anthropic-ai/claude-code
del "%USERPROFILE%\.claude\settings.json"   (or restore settings.json.bak)
```

Then delete this folder. The proxy leaves no other traces.
