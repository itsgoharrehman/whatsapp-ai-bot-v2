import fs from 'fs';
import path from 'path';

try {
  const dotenv = await import('dotenv');
  dotenv.default.config();
} catch (err) {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    envContent.split(/\r?\n/).forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const idx = trimmed.indexOf('=');
        if (idx > 0) {
          const key = trimmed.substring(0, idx).trim();
          const val = trimmed.substring(idx + 1).trim().replace(/^['"]|['"]$/g, '');
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
    });
  }
}

const ROOT_DIR = process.cwd();

export const config = {
  port: parseInt(process.env.PORT || '8100', 10),
  host: process.env.HOST || '0.0.0.0',
  ownerNumber: process.env.OWNER_NUMBER ? process.env.OWNER_NUMBER.trim().replace(/[^0-9]/g, '') : '',

  // Groq API Keys & Models
  groqKeys: (process.env.GROQ_API_KEYS || '').split(',').map(k => k.trim()).filter(k => k.length > 0),
  routerModel: process.env.GROQ_ROUTER_MODEL || process.env.ROUTER_MODEL || 'openai/gpt-oss-120b',
  groqRouterFallbackModels: (process.env.GROQ_ROUTER_FALLBACK_MODELS || 'openai/gpt-oss-20b')
    .split(',')
    .map(m => m.trim())
    .filter(m => m.length > 0),
  groqModelSimple: process.env.GROQ_MODEL_SIMPLE || 'openai/gpt-oss-20b',
  groqSimpleFallbackModels: (process.env.GROQ_SIMPLE_FALLBACK_MODELS || 'qwen/qwen3-32b')
    .split(',')
    .map(m => m.trim())
    .filter(m => m.length > 0),
  groqModelReasoning: process.env.GROQ_MODEL_REASONING || 'openai/gpt-oss-120b',
  groqReasoningFallbackModels: (process.env.GROQ_REASONING_FALLBACK_MODELS || 'qwen/qwen3-32b')
    .split(',')
    .map(m => m.trim())
    .filter(m => m.length > 0),

  // NVIDIA API Keys & Models (NVIDIA NIM)
  nvidiaKeys: (process.env.NVIDIA_API_KEYS || '').split(',').map(k => k.trim()).filter(k => k.length > 0),
  nvidiaRouterModel: process.env.NVIDIA_ROUTER_MODEL || 'openai/gpt-oss-20b',
  nvidiaRouterFallbackModels: (process.env.NVIDIA_ROUTER_FALLBACK_MODELS || 'openai/gpt-oss-120b')
    .split(',')
    .map(m => m.trim())
    .filter(m => m.length > 0),
  nvidiaModelSimple: process.env.NVIDIA_MODEL_SIMPLE || 'minimaxai/minimax-m3',
  nvidiaSimpleFallbackModels: (process.env.NVIDIA_SIMPLE_FALLBACK_MODELS || 'nvidia/nemotron-3-super-120b-a12b')
    .split(',')
    .map(m => m.trim())
    .filter(m => m.length > 0),
  nvidiaModelReasoning: process.env.NVIDIA_MODEL_REASONING || 'z-ai/glm-5.2',
  nvidiaReasoningFallbackModels: (process.env.NVIDIA_REASONING_FALLBACK_MODELS || 'deepseek-ai/deepseek-v4-pro')
    .split(',')
    .map(m => m.trim())
    .filter(m => m.length > 0),
  nvidiaModelMultimodal: process.env.NVIDIA_MODEL_MULTIMODAL || 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
  nvidiaMultimodalFallbackModels: (process.env.NVIDIA_MULTIMODAL_FALLBACK_MODELS || 'moonshotai/kimi-k2.6,nvidia/nemotron-nano-12b-v2-vl,meta/llama-3.2-11b-vision-instruct')
    .split(',')
    .map(m => m.trim())
    .filter(m => m.length > 0),

  // Token limits & generation parameters
  routerMaxTokens: 256,
  routerTemperature: 0.1,
  simpleMaxTokens: 1024,
  reasoningMaxTokens: 2048,
  generationTemperature: 0.7,
  routerConfidenceThreshold: 0.80,

  defaultProvider: (process.env.DEFAULT_PROVIDER || 'nvidia').toLowerCase(),

  antiBanMinDelayMs: parseInt(process.env.ANTI_BAN_MIN_DELAY_MS || '5000', 10),
  antiBanMaxDelayMs: parseInt(process.env.ANTI_BAN_MAX_DELAY_MS || '8000', 10),
  rateLimitMaxPerMinute: parseInt(process.env.RATE_LIMIT_MAX_PER_MINUTE || '2', 10),
  autoReplyEnabled: process.env.AUTO_REPLY_ENABLED === 'false' ? false : true,
  adminUsername: process.env.ADMIN_USERNAME || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',
  encryptionSecret: process.env.ENCRYPTION_SECRET || process.env.APP_SECRET || '',

  internalApiKey: process.env.INTERNAL_API_KEY || process.env.ALWAYSDATA_API_KEY || 'default-internal-service-secret-2026',
  alwaysdataBaseUrl: process.env.ALWAYSDATA_BASE_URL || '',

  sessionDir: path.resolve(ROOT_DIR, process.env.SESSION_DIR || './auth_sessions'),
  dbFilePath: path.resolve(ROOT_DIR, process.env.DB_FILE_PATH || './db.json'),
  systemPromptPath: path.resolve(ROOT_DIR, process.env.SYSTEM_PROMPT_PATH || './system.md')
};

export function getSystemPrompt() {
  try {
    return fs.readFileSync(config.systemPromptPath, 'utf8');
  } catch (err) {
    return "You are Mark Zuckerberg, Gohar's Personal AI Assistant.";
  }
}
