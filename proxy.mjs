#!/usr/bin/env node
/**
 * cproxy — claude-llama-proxy
 * ---------------------------
 * Zero-dependency translation proxy that lets Claude Code (which speaks the
 * Anthropic Messages API) talk to an OpenAI-compatible server such as
 * llama.cpp's `llama-server`.
 *
 *   Claude Code  --(Anthropic /v1/messages)-->  THIS PROXY  --(OpenAI /chat/completions)-->  llama-server
 *
 * It handles both streaming (SSE) and non-streaming responses, tool calls,
 * images, system prompts, and stop sequences.
 *
 * Configuration (environment variables):
 *   PORT            listen port                     (default 8787)
 *   HOST            bind address                    (default 127.0.0.1)
 *   UPSTREAM        OpenAI base url                 (default http://localhost:8080/v1)
 *   UPSTREAM_MODEL  force this model id upstream    (default: pass through)
 *   STRIP_TOOLS     "1" to drop tools from requests (default off)
 *   LOG             "1" for verbose request logging (default on)
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const UPSTREAM = (process.env.UPSTREAM || 'http://localhost:8080/v1').replace(/\/$/, '');
const UPSTREAM_MODEL = process.env.UPSTREAM_MODEL || '';
const STRIP_TOOLS = process.env.STRIP_TOOLS === '1';
const LOG = process.env.LOG !== '0';

function log(...args) {
  if (LOG) console.error('[proxy]', ...args);
}

/* ------------------------------------------------------------------ *
 * Request translation: Anthropic -> OpenAI
 * ------------------------------------------------------------------ */

/** Flatten an Anthropic `system` value into a plain string. */
function systemToString(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (typeof b === 'string' ? b : b?.text || ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Convert a single Anthropic image block to an OpenAI image_url part. */
function imageToOpenAI(block) {
  const src = block.source || {};
  if (src.type === 'base64') {
    const url = `data:${src.media_type};base64,${src.data}`;
    return { type: 'image_url', image_url: { url } };
  }
  if (src.type === 'url') {
    return { type: 'image_url', image_url: { url: src.url } };
  }
  return null;
}

/**
 * Convert an Anthropic messages array into OpenAI messages.
 * One Anthropic message can expand to several OpenAI messages (tool results).
 */
function convertMessages(messages) {
  const out = [];
  for (const msg of messages || []) {
    const role = msg.role; // 'user' | 'assistant'
    const content = msg.content;

    if (typeof content === 'string') {
      out.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) {
      out.push({ role, content: content == null ? '' : String(content) });
      continue;
    }

    // Array of blocks. Split into text/image parts and tool blocks.
    const parts = []; // OpenAI content parts (text / image_url)
    const toolCalls = []; // for assistant tool_use
    const toolResults = []; // for user tool_result -> separate 'tool' messages

    for (const block of content) {
      switch (block?.type) {
        case 'text':
          if (block.text) parts.push({ type: 'text', text: block.text });
          break;
        case 'image': {
          const p = imageToOpenAI(block);
          if (p) parts.push(p);
          break;
        }
        case 'tool_use':
          toolCalls.push({
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
          break;
        case 'tool_result': {
          let c = block.content;
          if (Array.isArray(c)) {
            c = c.map((b) => (typeof b === 'string' ? b : b?.text || '')).join('\n');
          } else if (c && typeof c === 'object') {
            c = c.text ?? JSON.stringify(c);
          }
          toolResults.push({
            role: 'tool',
            tool_call_id: block.tool_use_id,
            content: c == null ? '' : String(c),
          });
          break;
        }
        case 'thinking':
        case 'redacted_thinking':
          // Drop reasoning blocks from history (OpenAI has no equivalent).
          break;
        default:
          if (block?.text) parts.push({ type: 'text', text: block.text });
      }
    }

    if (role === 'assistant') {
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
      const hasImage = parts.some((p) => p.type === 'image_url');
      out.push({
        role: 'assistant',
        content: hasImage ? (parts.length > 1 ? parts : text || null) : text || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    } else {
      // user message: emit tool results first, then any text/image content.
      for (const tr of toolResults) out.push(tr);
      if (parts.length > 0) {
        const onlyText = parts.every((p) => p.type === 'text');
        out.push({ role: 'user', content: onlyText ? parts.map((p) => p.text).join('') : parts });
      } else if (toolResults.length === 0) {
        out.push({ role: 'user', content: '' });
      }
    }
  }
  return out;
}

function anthropicToOpenAI(body) {
  const messages = [];
  const system = systemToString(body.system);
  if (system) messages.push({ role: 'system', content: system });
  messages.push(...convertMessages(body.messages));

  const oai = {
    model: UPSTREAM_MODEL || body.model || 'default',
    messages,
    stream: !!body.stream,
  };

  if (typeof body.max_tokens === 'number') oai.max_tokens = body.max_tokens;
  if (typeof body.temperature === 'number') oai.temperature = body.temperature;
  if (typeof body.top_p === 'number') oai.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    oai.stop = body.stop_sequences;
  }

  // Tools: Anthropic {name,description,input_schema} -> OpenAI function tool.
  if (!STRIP_TOOLS && Array.isArray(body.tools) && body.tools.length) {
    oai.tools = body.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }));
    if (body.tool_choice && body.tool_choice.type === 'any') {
      oai.tool_choice = 'required';
    } else if (body.tool_choice && body.tool_choice.type === 'tool' && body.tool_choice.name) {
      oai.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
    }
  }

  // Ask for usage in the final stream chunk when supported.
  if (oai.stream) oai.stream_options = { include_usage: true };

  return oai;
}

/* ------------------------------------------------------------------ *
 * Response translation: OpenAI -> Anthropic (non-streaming)
 * ------------------------------------------------------------------ */

function mapFinishReason(fr) {
  switch (fr) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
    default:
      return 'end_turn';
  }
}

function openaiToAnthropic(resp, model) {
  const choice = resp.choices?.[0] || {};
  const m = choice.message || {};
  const content = [];

  if (typeof m.content === 'string' && m.content.length) {
    content.push({ type: 'text', text: m.content });
  } else if (Array.isArray(m.content)) {
    for (const p of m.content) {
      if (p?.type === 'text' && p.text) content.push({ type: 'text', text: p.text });
    }
  }

  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      let input = {};
      try {
        input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
      } catch {
        input = { _raw: tc.function?.arguments };
      }
      content.push({ type: 'tool_use', id: tc.id, name: tc.function?.name || '', input });
    }
  }

  if (content.length === 0) content.push({ type: 'text', text: '' });

  return {
    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    type: 'message',
    role: 'assistant',
    model: model || resp.model || 'default',
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: anthropicUsage(resp.usage),
  };
}

/**
 * Map OpenAI/llama.cpp usage to Anthropic usage. Recent llama-server builds
 * report KV-cache reuse as prompt_cache_hit_tokens / prompt_cache_miss_tokens
 * (their sum equals prompt_tokens). We surface those as Anthropic's
 * cache_read_input_tokens / cache_creation_input_tokens so Claude Code can
 * display real cache stats, and shrink input_tokens to the non-cached portion
 * (Anthropic counts input_tokens excluding cached tokens).
 */
function anthropicUsage(u) {
  const usage = u || {};
  const promptTokens = usage.prompt_tokens ?? 0;
  const cacheRead = usage.prompt_cache_hit_tokens ?? 0;
  const cacheCreate = usage.prompt_cache_miss_tokens ?? 0;
  const out = {
    input_tokens: Math.max(0, promptTokens - cacheRead - cacheCreate),
    output_tokens: usage.completion_tokens ?? 0,
  };
  if (cacheRead) out.cache_read_input_tokens = cacheRead;
  if (cacheCreate) out.cache_creation_input_tokens = cacheCreate;
  return out;
}

/* ------------------------------------------------------------------ *
 * Response translation: OpenAI stream -> Anthropic SSE events
 * ------------------------------------------------------------------ */

class StreamTranslator {
  constructor(model) {
    this.model = model;
    this.msgId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    this.started = false;
    this.nextIndex = 0;
    this.textBlock = null; // anthropic index of the open text block
    this.toolBlocks = new Map(); // openai tool_call index -> {index, id, name}
    this.openCount = 0;
    this.finishReason = null;
    this.finalUsageSeen = false; // true once the empty-choices usage chunk arrives
    this.closed = false;
    this.rawUsage = null; // last raw OpenAI/llama.cpp usage object seen
  }

  sse(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  begin() {
    if (this.started) return '';
    this.started = true;
    let out = this.sse('message_start', {
      type: 'message_start',
      message: {
        id: this.msgId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 1 },
      },
    });
    out += this.sse('ping', { type: 'ping' });
    return out;
  }

  /** Open a text block lazily. Returns its index. */
  ensureTextBlock() {
    if (this.textBlock == null) {
      this.textBlock = this.nextIndex++;
      this.openCount++;
    }
    return this.textBlock;
  }

  onDelta(delta, chunkId) {
    let out = '';
    const d = delta || {};

    // Text content.
    if (typeof d.content === 'string' && d.content.length) {
      const idx = this.ensureTextBlock();
      if (!this._textStarted) {
        out += this.sse('content_block_start', {
          type: 'content_block_start',
          index: idx,
          content_block: { type: 'text', text: '' },
        });
        this._textStarted = true;
      }
      out += this.sse('content_block_delta', {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'text_delta', text: d.content },
      });
    }

    // Tool calls.
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const oaiIdx = tc.index ?? 0;
        let block = this.toolBlocks.get(oaiIdx);
        if (!block) {
          block = { index: this.nextIndex++, id: tc.id || `toolu_${randomUUID().slice(0, 12)}`, name: '' };
          this.toolBlocks.set(oaiIdx, block);
          this.openCount++;
          out += this.sse('content_block_start', {
            type: 'content_block_start',
            index: block.index,
            content_block: { type: 'tool_use', id: block.id, name: tc.function?.name || '' },
          });
        }
        if (tc.id) block.id = tc.id;
        if (tc.function?.name && !block.name) {
          // Name may arrive in the first chunk; we already emitted start with it.
          block.name = tc.function.name;
        }
        const argFragment = tc.function?.arguments;
        if (typeof argFragment === 'string' && argFragment.length) {
          out += this.sse('content_block_delta', {
            type: 'content_block_delta',
            index: block.index,
            delta: { type: 'input_json_delta', partial_json: argFragment },
          });
        }
      }
    }

    return out;
  }

  captureUsage(usage) {
    // Keep the raw upstream usage object; it is mapped to Anthropic shape in end().
    if (usage && (usage.prompt_tokens != null || usage.completion_tokens != null)) {
      this.rawUsage = usage;
    }
  }

  end() {
    if (this.closed) return '';
    this.closed = true;
    let out = '';

    // Close the text block.
    if (this.textBlock != null && this._textStarted) {
      out += this.sse('content_block_stop', { type: 'content_block_stop', index: this.textBlock });
    }
    // Close tool blocks in creation order.
    for (const block of [...this.toolBlocks.values()].sort((a, b) => a.index - b.index)) {
      out += this.sse('content_block_stop', { type: 'content_block_stop', index: block.index });
    }

    const stopReason = mapFinishReason(this.finishReason);
    out += this.sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: anthropicUsage(this.rawUsage),
    });
    out += this.sse('message_stop', { type: 'message_stop' });
    return out;
  }
}

/* ------------------------------------------------------------------ *
 * HTTP plumbing
 * ------------------------------------------------------------------ */

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function upstreamFetch(path, bodyObj) {
  const url = `${UPSTREAM}${path}`;
  const payload = JSON.stringify(bodyObj);
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.UPSTREAM_KEY || 'llama'}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => resolve(res)
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, upstream: UPSTREAM }));
      return;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request', message: 'method not allowed' } }));
      return;
    }

    // We only implement /v1/messages (and tolerate /messages). Claude Code may
    // append a query string such as ?beta=true, so match on the path only.
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (!/\/(v1\/)?messages$/.test(pathname)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'not_found', message: `no handler for ${req.url}` } }));
      return;
    }

    const raw = await readBody(req);
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_json', message: String(e) } }));
      return;
    }

    const oai = anthropicToOpenAI(body);
    log(`-> ${oai.model} stream=${!!oai.stream} msgs=${oai.messages.length} tools=${(oai.tools || []).length}`);

    const upstreamRes = await upstreamFetch('/chat/completions', oai);

    if (upstreamRes.statusCode >= 400) {
      const errText = await new Promise((r) => {
        let d = '';
        upstreamRes.on('data', (c) => (d += c));
        upstreamRes.on('end', () => r(d));
      });
      log(`upstream error ${upstreamRes.statusCode}: ${errText.slice(0, 500)}`);
      res.writeHead(upstreamRes.statusCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'upstream_error', message: errText } }));
      return;
    }

    const model = oai.model;

    if (!oai.stream) {
      const text = await new Promise((r) => {
        let d = '';
        upstreamRes.on('data', (c) => (d += c));
        upstreamRes.on('end', () => r(d));
      });
      let json;
      try {
        json = JSON.parse(text);
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'bad_upstream', message: text.slice(0, 500) } }));
        return;
      }
      const out = openaiToAnthropic(json, model);
      log(`<- non-stream stop=${out.stop_reason} out_tokens=${out.usage.output_tokens}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
      return;
    }

    // Streaming.
    const st = new StreamTranslator(model);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(st.begin());

    let buf = '';
    upstreamRes.setEncoding('utf8');
    // llama.cpp sends the finish_reason chunk first, then a separate
    // empty-choices chunk carrying `usage`, then [DONE]. We must wait for that
    // usage chunk before emitting message_delta/message_stop so token counts
    // are correct (Claude Code uses them for context/compaction).
    const maybeClose = () => {
      if (!st.closed && st.finishReason != null && st.finalUsageSeen) {
        res.write(st.end());
        upstreamRes.removeAllListeners('data');
      }
    };
    upstreamRes.on('data', (chunk) => {
      buf += chunk;
      // SSE frames are separated by a blank line.
      let sep;
      while ((sep = buf.indexOf('\n\n')) !== -1 && !st.closed) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const dataStr = line.slice(5).trim();
          if (dataStr === '[DONE]') {
            st.finalUsageSeen = true; // treat end-of-stream as "usage done"
            maybeClose();
            continue;
          }
          let obj;
          try {
            obj = JSON.parse(dataStr);
          } catch {
            continue;
          }
          if (obj.usage && (obj.usage.prompt_tokens != null || obj.usage.completion_tokens != null)) {
            st.captureUsage(obj.usage);
            st.finalUsageSeen = true;
          }
          const choice = obj.choices?.[0];
          if (!choice) {
            maybeClose(); // empty-choices usage chunk
            continue;
          }
          res.write(st.onDelta(choice.delta, obj.id));
          if (choice.finish_reason) {
            st.finishReason = choice.finish_reason;
            maybeClose();
          }
        }
      }
    });
    upstreamRes.on('end', () => {
      // Safety: if we never saw a finish_reason, still close cleanly.
      if (!st.finishReason) res.write(st.end('stop'));
      res.end();
      log('<- stream complete');
    });
    upstreamRes.on('error', (e) => {
      log('upstream stream error:', e.message);
      try {
        res.write(st.end('stop'));
      } catch {}
      res.end();
    });
  } catch (err) {
    log('handler error:', err.stack || err);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'proxy_error', message: String(err) } }));
  }
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT} -> ${UPSTREAM}`);
});
