import './services/llm-interceptor.js';
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';
import { loadConfig } from './config.js';
import { initDb, deleteExpiredSessions } from './services/db.js';
import { loadVectorCache } from './services/vector-cache.js';
import { createWebSocketServer, setVoiceService, setGatewayServices, registry } from './services/ws.js';
import { Orchestrator } from './services/orchestrator.js';
import { AgentService } from './services/agent.js';
import { VoiceService } from './services/voice.js';
import { PushService } from './services/push.js';
import { DiscordService } from './services/discord/index.js';
import { TelegramService } from './services/telegram/index.js';
import { rateLimiter, securityHeaders } from './middleware/security.js';
import apiRoutes, { initCcRoutes } from './routes/api.js';

// Load config FIRST — before any other initialization
const config = loadConfig();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = config.server.port;
const HOST = config.server.host;
const DB_PATH = config.server.db_path;

// Ensure data directory exists
const dataDir = dirname(DB_PATH);
if (!existsSync(dataDir)) {
  mkdirSync(dataDir, { recursive: true });
}

// Ensure files directory exists
const filesDir = join(dataDir, 'files');
if (!existsSync(filesDir)) {
  mkdirSync(filesDir, { recursive: true });
}

// Initialize database
console.log('Initializing database...');
const db = initDb(DB_PATH);
deleteExpiredSessions();
loadVectorCache();
console.log('Database initialized');

// Create Express app
const app = express();

// Trust proxy headers (e.g. Cloudflare tunnel, nginx)
app.set('trust proxy', 1);

// Environment-conditional origins
const IS_DEV = process.env.NODE_ENV !== 'production';
const corsOrigins: string[] = [...config.cors.origins, `http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
if (IS_DEV) corsOrigins.push('http://localhost:5173');

const connectSrc: string[] = ["'self'"];
// Derive WebSocket connect sources from CORS origins
for (const origin of config.cors.origins) {
  const wsOrigin = origin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  connectSrc.push(wsOrigin);
}
if (IS_DEV) connectSrc.push(`ws://localhost:${PORT}`);

// Security middleware
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      connectSrc,
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https:"],
      mediaSrc: ["'self'", "blob:"],
      fontSrc: ["'self'"],
      frameAncestors: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      workerSrc: ["'self'"],
    }
  },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
}));

app.use(securityHeaders);
// Rate limiter only on API/MCP routes — not static assets
app.use('/api', rateLimiter);
app.use('/mcp', rateLimiter);

// CORS
app.use(cors({
  origin: corsOrigins,
  credentials: true,
}));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Custom LLM proxy for handling Z.ai / Anthropic split routing
// We must be perfectly transparent for Anthropic to support OAuth session tokens
app.post('/api/llm-proxy/*', async (req, res) => {
  try {
    const body = req.body;
    const model = (body.model || '').toLowerCase();
    const isGlm = model.includes('glm');

    // Exact path mapping: /api/llm-proxy/v1/messages -> /v1/messages
    const path = req.originalUrl.replace('/api/llm-proxy', '');
    const targetUrl = isGlm
      ? `https://api.z.ai/api/anthropic${path}`
      : `https://api.anthropic.com${path}`;

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      // Skip hop-by-hop headers
      if (['host', 'connection', 'content-length', 'content-encoding'].includes(k.toLowerCase())) continue;
      headers[k] = String(v);
    }

    if (isGlm) {
      // Map frontend IDs to Z.ai supported slugs if necessary
      const modelMap: Record<string, string> = {
        'glm-4.7-flash': 'glm-4.7-flash',
        'glm-4.5-air': 'glm-4-0520', // Common alias for 4.5 Air
      };

      const targetModel = modelMap[model] || model;

      // DETAILED LOGGING to investigate token bloat
      const messages = body.messages || [];
      const totalMessages = messages.length;
      const bodyStr = JSON.stringify(body);
      const bodySize = Buffer.byteLength(bodyStr, 'utf8');

      console.log(`\n========== LLM PROXY GLM REQUEST ==========`);
      console.log(`Model: ${model} -> ${targetModel}`);
      console.log(`URL: ${targetUrl}`);
      console.log(`Body size: ${bodySize} bytes (~${Math.round(bodySize / 4)} tokens)`);
      console.log(`Messages count: ${totalMessages}`);
      console.log(`System prompt length: ${(body.system || '').length} chars`);

      if (totalMessages > 0) {
        const firstMsg = messages[0];
        const lastMsg = messages[messages.length - 1];
        console.log(`First message role: ${firstMsg.role}`);
        console.log(`First message content length: ${JSON.stringify(firstMsg.content).length} chars`);
        console.log(`Last message role: ${lastMsg.role}`);
        console.log(`Last message content length: ${JSON.stringify(lastMsg.content).length} chars`);
      }

      // Log full body to file for inspection
      const fs = await import('fs');
      const logFile = 'C:\\Users\\Nout\\AI\\resonant\\packages\\backend\\journals\\llm-proxy-log.jsonl';

      // TRUNCATION SAFETY VALVE: Protect LLM context from massive messages
      // Skip for count_tokens — it needs full content for accurate counting
      const isCountTokens = path.includes('count_tokens');
      if (!isCountTokens && body.messages && Array.isArray(body.messages)) {
        body.messages = body.messages.map((m: any, idx: number) => {
          if (typeof m.content === 'string' && m.content.length > 10000) {
            console.log(`[LLM Proxy] TRUNCATING message at index ${idx} (${m.content.length} -> 10000 chars)`);
            return { ...m, content: m.content.slice(0, 10000) + '... [TRUNCATED BY PROXY FOR TOKEN SAFETY]' };
          }
          if (Array.isArray(m.content)) {
            let truncated = false;
            const newContent = m.content.map((block: any) => {
              if (block.type === 'text' && block.text && block.text.length > 10000) {
                truncated = true;
                return { ...block, text: block.text.slice(0, 10000) + '... [TRUNCATED]' };
              }
              return block;
            });
            if (truncated) {
              console.log(`[LLM Proxy] TRUNCATED text blocks in message at index ${idx}`);
              return { ...m, content: newContent };
            }
          }
          return m;
        });
      }

      // Also guard system prompt just in case
      if (typeof body.system === 'string' && body.system.length > 15000) {
        console.log(`[LLM Proxy] TRUNCATING massive system prompt (${body.system.length} -> 15000 chars)`);
        body.system = body.system.slice(0, 15000) + '... [TRUNCATED]';
      }

      const logEntry = {
        timestamp: new Date().toISOString(),
        model: targetModel,
        body_size: Buffer.byteLength(JSON.stringify(body), 'utf8'),
        message_count: body.messages?.length || 0,
        body: body
      };
      fs.appendFileSync(logFile, JSON.stringify(logEntry) + '\n');

      console.log(`Full request body logged to: ${logFile}`);
      console.log(`==========================================\n`);

      // Update body with the mapped/lowercased model name
      body.model = targetModel;

      headers['x-api-key'] = process.env.ZAI_API_KEY || '';
      delete headers['authorization']; // Z.ai doesn't like the OAuth session token
    } else {
      // Transparent forward to Anthropic
      // DO NOT change anything in authorization or x-api-key
    }

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (response.status >= 400) {
      const errText = await response.clone().text();
      console.log(`[LLM Proxy] Target API returned ${response.status}: ${errText}`);
    }

    res.status(response.status);
    response.headers.forEach((v, k) => {
      if (k.toLowerCase() !== 'content-encoding' && k.toLowerCase() !== 'transfer-encoding') {
        res.setHeader(k, v);
      }
    });

    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        if ((res as any).flush) (res as any).flush();
      }
    }
    res.end();
  } catch (err) {
    console.error('[LLM Proxy] Error:', err);
    res.status(500).json({ error: 'Proxy failed' });
  }
});

// All API routes — auth middleware is applied selectively inside the router
app.use('/api', apiRoutes);

// Command Center MCP endpoint
if (config.command_center.enabled) {
  import('./routes/cc-mcp.js').then(m => app.use('/mcp/cc', m.default));
}

// Serve frontend static build (works in dev too if frontend is pre-built)
const frontendPaths = [
  join(__dirname, '../../frontend/build'),         // From compiled dist/
  join(__dirname, '../../../packages/frontend/build'), // From src/ via tsx
];
const frontendBuildPath = frontendPaths.find(p => existsSync(p));
if (frontendBuildPath) {
  console.log(`Serving frontend from: ${frontendBuildPath}`);
  app.use(express.static(frontendBuildPath));
  app.get('*', (req, res) => {
    res.sendFile(join(frontendBuildPath, 'index.html'));
  });
} else {
  console.log('No frontend build found — use Vite dev server on :5173');
}

// Global error handler — must be after all routes
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Create HTTP server
const server = createServer(app);

// Redirect Claude Agent SDK traffic through our local multi-model proxy
// This allows intercepting subprocesses spawned by the SDK
const LOCAL_OVERRIDE = `http://127.0.0.1:${PORT}/api/llm-proxy`;
process.env.ANTHROPIC_BASE_URL = LOCAL_OVERRIDE;
console.log(`[LLM Proxy] ANTHROPIC_BASE_URL set to ${LOCAL_OVERRIDE}`);

// Initialize agent service (shared between WebSocket and orchestrator)
const agentService = new AgentService();


// Initialize voice service
const voiceService = new VoiceService();
setVoiceService(voiceService);

// Initialize push service
const pushService = new PushService(
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY,
  process.env.VAPID_CONTACT,
);
agentService.setPushService(pushService);

// Initialize Discord gateway (config-gated with env fallback)
import { getConfigBool } from './services/db.js';

let discordService: DiscordService | null = null;

// Check config DB first, fall back to config file / env var for first boot
const discordEnabled = getConfigBool('discord.enabled', config.discord.enabled);
if (discordEnabled && process.env.DISCORD_BOT_TOKEN) {
  discordService = new DiscordService(agentService, registry);
  discordService.start();
}

// Initialize Telegram gateway (config-gated with env fallback)
let telegramService: TelegramService | null = null;

const telegramEnabled = getConfigBool('telegram.enabled', config.telegram.enabled);
if (telegramEnabled && process.env.TELEGRAM_BOT_TOKEN) {
  telegramService = new TelegramService(agentService, registry, voiceService);
  telegramService.start();
}

// Initialize orchestrator
const orchestrator = new Orchestrator(agentService, pushService);
orchestrator.start();

// Make orchestrator, agent, voice, push, and discord services available to route handlers
app.locals.orchestrator = orchestrator;
app.locals.agentService = agentService;
app.locals.voiceService = voiceService;
app.locals.pushService = pushService;
app.locals.discordService = discordService;
app.locals.telegramService = telegramService;

// Wire gateway services for status reporting
setGatewayServices({ discord: discordService, telegram: telegramService });

// Attach WebSocket server
console.log('Initializing WebSocket server...');
const wss = createWebSocketServer(server, agentService, orchestrator);
console.log('WebSocket server initialized');

// Mount Command Center routes (after config is loaded)
initCcRoutes().then(() => {
  if (config.command_center.enabled) console.log('Command Center routes mounted at /api/cc');
});

// Start server
server.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Auth enabled: ${config.auth.password ? 'yes' : 'no'}`);
  console.log(`Companion: ${config.identity.companion_name} | User: ${config.identity.user_name}`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');

  // Safety timeout: if we don't shut down in 5 seconds, force exit
  const timeout = setTimeout(() => {
    console.warn('[Server] Shutdown timed out after 5s, forcing exit.');
    process.exit(1);
  }, 5000);
  timeout.unref();

  orchestrator.stop();
  if (discordService) await discordService.stop();
  if (telegramService) await telegramService.stop();
  wss.clients.forEach(ws => ws.close());
  wss.close();
  server.close(() => {
    console.log('Server closed');
    db.close();
    clearTimeout(timeout);
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');

  // Safety timeout: if we don't shut down in 5 seconds, force exit
  const timeout = setTimeout(() => {
    console.warn('[Server] Shutdown timed out after 5s, forcing exit.');
    process.exit(1);
  }, 5000);
  timeout.unref();

  orchestrator.stop();
  if (discordService) await discordService.stop();
  if (telegramService) await telegramService.stop();
  wss.clients.forEach(ws => ws.close());
  wss.close();
  server.close(() => {
    console.log('Server closed');
    db.close();
    clearTimeout(timeout);
    process.exit(0);
  });
});
