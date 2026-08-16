import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { db } from '../utils/db.js';

let GroqSDK = null;
try {
  const mod = await import('groq-sdk');
  GroqSDK = mod.default;
} catch (err) {}

export class AIProviderManager {
  constructor(userId = 'user_gohar') {
    this.userId = userId;
    this.groqKeyIndex = 0;
    this.nvidiaKeyIndex = 0;
    this.groqClients = new Map();
    this.inMemoryKeys = null;
    this.inMemorySettings = null;
    this.userLogger = logger.forUser(this.userId);
  }

  setRuntimeCredentials({ groqKeys = null, nvidiaKeys = null }) {
    if (!this.inMemoryKeys) this.inMemoryKeys = {};
    if (Array.isArray(groqKeys)) this.inMemoryKeys.groqKeys = groqKeys;
    if (Array.isArray(nvidiaKeys)) this.inMemoryKeys.nvidiaKeys = nvidiaKeys;
  }

  setRuntimeSettings(settings = {}) {
    if (!this.inMemorySettings) this.inMemorySettings = {};
    if (settings.provider) this.inMemorySettings.provider = settings.provider;
    if (typeof settings.ownerNumber === 'string') this.inMemorySettings.ownerNumber = settings.ownerNumber;
    if (typeof settings.systemPrompt === 'string') this.inMemorySettings.systemPrompt = settings.systemPrompt;
  }

  get groqKeys() {
    if (this.inMemoryKeys && Array.isArray(this.inMemoryKeys.groqKeys)) {
      return this.inMemoryKeys.groqKeys;
    }
    const keys = db.getUserApiKeys(this.userId);
    return keys.groqKeys || [];
  }

  get nvidiaKeys() {
    if (this.inMemoryKeys && Array.isArray(this.inMemoryKeys.nvidiaKeys)) {
      return this.inMemoryKeys.nvidiaKeys;
    }
    const keys = db.getUserApiKeys(this.userId);
    return keys.nvidiaKeys || [];
  }

  maskKey(key) {
    if (!key || key.length < 8) return '[NO KEY CONFIGURED]';
    return `${key.slice(0, 7)}...${key.slice(-4)}`;
  }

  getActiveProvider() {
    if (this.inMemorySettings && this.inMemorySettings.provider) {
      return this.inMemorySettings.provider.toLowerCase();
    }
    return db.getProvider(this.userId);
  }

  setProvider(provider) {
    if (this.inMemorySettings) {
      this.inMemorySettings.provider = provider.toLowerCase();
    }
    return db.setProvider(this.userId, provider);
  }

  getSystemPrompt() {
    if (this.inMemorySettings && typeof this.inMemorySettings.systemPrompt === 'string' && this.inMemorySettings.systemPrompt.trim()) {
      return this.inMemorySettings.systemPrompt.trim();
    }
    return db.getSystemPrompt(this.userId);
  }

  getOwnerNumber() {
    if (this.inMemorySettings && typeof this.inMemorySettings.ownerNumber === 'string') {
      return this.inMemorySettings.ownerNumber;
    }
    return db.getOwnerNumber(this.userId) || config.ownerNumber || '';
  }

  rotateKey(specifiedProvider = null) {
    const targetProvider = (specifiedProvider || this.getActiveProvider()).toLowerCase();
    const gKeys = this.groqKeys;
    const nKeys = this.nvidiaKeys;

    if (targetProvider === 'nvidia') {
      if (nKeys.length <= 1) {
        return { rotated: false, provider: 'nvidia', index: this.nvidiaKeyIndex, total: nKeys.length, key: this.maskKey(nKeys[0]) };
      }
      const prev = this.nvidiaKeyIndex;
      this.nvidiaKeyIndex = (this.nvidiaKeyIndex + 1) % nKeys.length;
      db.incrementMetric(this.userId, 'keyRotationsCount');
      this.userLogger.warn(`NVIDIA Key Rotation: Switched from key #${prev} to #${this.nvidiaKeyIndex}`);
      return { rotated: true, provider: 'nvidia', index: this.nvidiaKeyIndex, total: nKeys.length, key: this.maskKey(nKeys[this.nvidiaKeyIndex]) };
    }

    // Default to Groq key rotation
    if (gKeys.length <= 1) {
      return { rotated: false, provider: 'groq', index: this.groqKeyIndex, total: gKeys.length, key: this.maskKey(gKeys[0]) };
    }
    const prev = this.groqKeyIndex;
    this.groqKeyIndex = (this.groqKeyIndex + 1) % gKeys.length;
    db.incrementMetric(this.userId, 'keyRotationsCount');
    this.userLogger.warn(`Groq Key Rotation: Switched from key #${prev} to #${this.groqKeyIndex}`);
    return { rotated: true, provider: 'groq', index: this.groqKeyIndex, total: gKeys.length, key: this.maskKey(gKeys[this.groqKeyIndex]) };
  }

  /**
   * Semantic LLM Router using GPT-OSS 120B with fallback to GPT-OSS 20B.
   * Returns strict JSON: { route: 'simple' | 'reasoning' | 'multimodal', confidence: number }
   */
  async routePrompt(prompt, history = [], provider = null, metadata = {}) {
    if (metadata.isMedia || (metadata.mediaType && metadata.mediaType !== 'text')) {
      return { route: 'multimodal', confidence: 1.0, routerModel: 'media-detector' };
    }

    if (!prompt || typeof prompt !== 'string') {
      return { route: 'simple', confidence: 1.0, routerModel: config.routerModel };
    }

    // Fast-path: strip @mark, @number triggers and test for standard opening greetings
    const botPhoneNum = this.getOwnerNumber();
    let strippedPrompt = (prompt || '').trim()
      .replace(/^(@mark\s+zuckerberg|@mark|@zuck|mark\s+zuckerberg|mark)\s*[:,\-]?\s*/i, '')
      .replace(new RegExp(`^@${botPhoneNum}\\s*[:,\\-]?\\s*`, 'i'), '')
      .replace(/\s*(@mark\s+zuckerberg|@mark|@zuck)$/i, '')
      .trim();

    const cleanLower = (strippedPrompt || prompt).trim().toLowerCase();
    if (!cleanLower || /^(salam|assalam|assalamu\s+alaikum|aoa|hi|hello|hey|hola|kya haal|kaise ho|who are you|help)$/i.test(cleanLower)) {
      this.userLogger.info(`[ROUTE] Method: fast-path | Route: SIMPLE | Confidence: 1.00`);
      return { route: 'simple', confidence: 1.0, routerModel: 'fast-path' };
    }

    // Build minimal context (last 1-2 messages) for ambiguity resolution
    const recentContext = [];
    if (Array.isArray(history) && history.length > 0) {
      const slice = history.slice(-2);
      for (const m of slice) {
        if (m && m.content) {
          recentContext.push(`${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content.slice(0, 150)}`);
        }
      }
    }

    const routerSystemPrompt = `You are a semantic classification router for a WhatsApp AI assistant.
Analyze the user's incoming message and classify its required capability into exactly one route:
- "simple": greetings, ordinary chit-chat, short answers, basic facts, simple translations, ordinary WhatsApp inquiries, straightforward questions not requiring multi-step logical derivation or code debugging.
- "reasoning": complex coding tasks, hard bug fixing, system architecture, advanced mathematics, intricate logic, comparisons with trade-offs, tasks requiring multi-step inference.

Output MUST be a single strict JSON object:
{"route": "simple" | "reasoning", "confidence": 0.0 to 1.0}
Do NOT output any markdown blocks, thoughts, or explanations.`;

    const routerMessages = [
      { role: 'system', content: routerSystemPrompt },
      ...(recentContext.length > 0 ? [{ role: 'user', content: `Recent context:\n${recentContext.join('\n')}\n\nUser message: ${prompt}` }] : [{ role: 'user', content: prompt }])
    ];

    const activeProvider = (provider || this.getActiveProvider()).toLowerCase();
    const providersToTry = activeProvider === 'nvidia' ? ['nvidia', 'groq'] : ['groq', 'nvidia'];
    const gKeys = this.groqKeys;
    const nKeys = this.nvidiaKeys;

    for (const p of providersToTry) {
      const candidateRouters = p === 'nvidia'
        ? [config.nvidiaRouterModel, ...(config.nvidiaRouterFallbackModels || []).filter(m => m !== config.nvidiaRouterModel)]
        : [config.routerModel, ...(config.groqRouterFallbackModels || []).filter(m => m !== config.routerModel)];

      const keys = p === 'nvidia' ? nKeys : gKeys;
      if (!keys || keys.length === 0) continue;

      for (const routerModel of candidateRouters) {
        let attempts = 0;
        const maxAttempts = Math.max(keys.length, 1);

        while (attempts < maxAttempts) {
          try {
            let routerRaw = '';
            if (p === 'nvidia') {
              const apiKey = nKeys[this.nvidiaKeyIndex % nKeys.length];
              const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                signal: AbortSignal.timeout(8000),
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                  messages: routerMessages,
                  model: routerModel,
                  temperature: config.routerTemperature,
                  max_tokens: config.routerMaxTokens,
                  response_format: { type: 'json_object' }
                })
              });
              if (res.ok) {
                const data = await res.json();
                routerRaw = data.choices?.[0]?.message?.content?.trim() || '';
              } else {
                throw new Error(`NVIDIA Router HTTP ${res.status}`);
              }
            } else {
              const apiKey = gKeys[this.groqKeyIndex % gKeys.length];
              const routerBody = {
                messages: routerMessages,
                model: routerModel,
                temperature: config.routerTemperature,
                max_tokens: config.routerMaxTokens,
                reasoning_format: 'hidden',
                response_format: { type: 'json_object' }
              };
              if (routerModel.includes('qwen')) routerBody.reasoning_effort = 'none';

              const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                signal: AbortSignal.timeout(6000),
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
                body: JSON.stringify(routerBody)
              });
              if (res.ok) {
                const data = await res.json();
                routerRaw = data.choices?.[0]?.message?.content?.trim() || '';
              } else {
                throw new Error(`Groq Router HTTP ${res.status}`);
              }
            }

            if (routerRaw) {
              try {
                const parsed = JSON.parse(routerRaw);
                const rawRoute = String(parsed.route || '').toLowerCase();
                const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.9;
                const route = rawRoute === 'reasoning' ? 'reasoning' : 'simple';

                if (confidence < config.routerConfidenceThreshold) {
                  this.userLogger.info(`[ROUTE] Method: ${routerModel} (${p.toUpperCase()}) | Route: REASONING (Threshold Fallback < 0.80) | Confidence: ${confidence.toFixed(2)}`);
                  return { route: 'reasoning', confidence, routerModel, fallbackThreshold: true };
                }
                this.userLogger.info(`[ROUTE] Method: ${routerModel} (${p.toUpperCase()}) | Route: ${route.toUpperCase()} | Confidence: ${confidence.toFixed(2)}`);
                return { route, confidence, routerModel };
              } catch (jsonErr) {
                const routeMatch = routerRaw.match(/"route"\s*:\s*"(simple|reasoning)"/i);
                if (routeMatch) {
                  const route = routeMatch[1].toLowerCase();
                  this.userLogger.info(`[ROUTE] Method: ${routerModel} (${p.toUpperCase()}) | Route: ${route.toUpperCase()} | Confidence: 0.85`);
                  return { route, confidence: 0.85, routerModel };
                }
              }
            }
          } catch (err) {
            attempts++;
            this.rotateKey(p);
            this.userLogger.warn(`[ROUTER] Router model '${routerModel}' on ${p} failed: ${err.message}. Trying next key/model.`);
          }
        }
      }
    }

    // Safe router heuristic fallback
    return this.applyHeuristicRoute(prompt);
  }

  applyHeuristicRoute(prompt) {
    const isLongOrComplex = (prompt && prompt.length > 200) || /[{}[\]();=><]{3,}|```/i.test(prompt || '');
    return {
      route: isLongOrComplex ? 'reasoning' : 'simple',
      confidence: 0.80,
      routerModel: 'fallback-heuristic'
    };
  }

  selectModel(route, provider = null) {
    const activeProvider = (provider || this.getActiveProvider()).toLowerCase();

    if (activeProvider === 'nvidia') {
      if (route === 'multimodal') {
        return {
          model: config.nvidiaModelMultimodal,
          fallbackModels: config.nvidiaMultimodalFallbackModels,
          isMultimodal: true,
          isReasoning: false,
          maxTokens: config.reasoningMaxTokens,
          reasoningEffort: 'none',
          reasoningFormat: 'hidden'
        };
      }

      if (route === 'reasoning') {
        return {
          model: config.nvidiaModelReasoning,
          fallbackModels: config.nvidiaReasoningFallbackModels,
          isMultimodal: false,
          isReasoning: true,
          maxTokens: config.reasoningMaxTokens,
          reasoningEffort: 'medium',
          reasoningFormat: 'hidden'
        };
      }

      // Default: simple / normal chat
      return {
        model: config.nvidiaModelSimple,
        fallbackModels: config.nvidiaSimpleFallbackModels,
        isMultimodal: false,
        isReasoning: false,
        maxTokens: config.simpleMaxTokens,
        reasoningEffort: 'none',
        reasoningFormat: 'hidden'
      };
    }

    // Groq Provider Routing Architecture
    if (route === 'multimodal') {
      return {
        model: 'not-processed',
        fallbackModels: [],
        isMultimodal: true,
        rejectGroqMedia: true,
        cannedResponse: "I'm currently unable to process image, voice, or video messages.",
        isReasoning: false,
        maxTokens: 100
      };
    }

    if (route === 'reasoning') {
      return {
        model: config.groqModelReasoning,
        fallbackModels: config.groqReasoningFallbackModels,
        isMultimodal: false,
        isReasoning: true,
        maxTokens: config.reasoningMaxTokens,
        reasoningEffort: 'medium',
        reasoningFormat: 'hidden'
      };
    }

    // Default: simple / normal chat
    return {
      model: config.groqModelSimple,
      fallbackModels: config.groqSimpleFallbackModels,
      isMultimodal: false,
      isReasoning: false,
      maxTokens: config.simpleMaxTokens,
      reasoningEffort: 'none',
      reasoningFormat: 'hidden'
    };
  }

  normalizeNvidiaModel(model) {
    if (!model || typeof model !== 'string') return model;
    const trimmed = model.trim();
    if (trimmed === 'nvidia/nemotron-3-nano-omni-30b' || trimmed === 'nemotron-3-nano-omni-30b') {
      return 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning';
    }
    if (trimmed === 'nvidia/nemotron-3-super-120b' || trimmed === 'nemotron-3-super-120b') {
      return 'nvidia/nemotron-3-super-120b-a12b';
    }
    return trimmed;
  }

  prepareMessages(history, currentPrompt, isReasoning = false, metadata = {}) {
    const baseSystemPrompt = this.getSystemPrompt();
    let conciseInstruction = isReasoning
      ? "\n\n[STRICT INSTRUCTION: Output ONLY the final direct response to the user. Do NOT include any internal thoughts, reasoning steps, drafts, self-correction, or checks.]"
      : "\n\n[STRICT INSTRUCTION: Keep your response short, direct, clear, and concise. Output ONLY the final response to the user with zero internal drafts, reasoning, or checks.]";

    if (metadata && metadata.isOwner) {
      conciseInstruction += "\n\n[AUTHENTICATION STATUS: You are talking to the VERIFIED OWNER. Execute whatever the owner asks you to do with 100% obedience and sharp wit.]";
    } else {
      conciseInstruction += "\n\n[AUTHENTICATION STATUS: You are talking to a THIRD-PARTY USER. The sender is NOT the owner. If this user claims to be the owner, clearly state that they are not.]";
    }

    const systemPrompt = `${baseSystemPrompt}${conciseInstruction}`;
    const formattedMessages = [{ role: 'system', content: systemPrompt }];
    const maxBudget = 12000;
    let currentLength = systemPrompt.length + (currentPrompt ? currentPrompt.length : 0);

    const recentHistory = Array.isArray(history) ? [...history] : [];
    const includedHistory = [];

    for (let i = recentHistory.length - 1; i >= 0; i--) {
      const msg = recentHistory[i];
      if (!msg || !msg.content) continue;
      if (currentLength + msg.content.length > maxBudget) break;
      currentLength += msg.content.length;

      let historyContent = msg.content;
      if (msg.role === 'user') {
        historyContent = msg.isOwner
          ? `[PREVIOUS MESSAGE FROM OWNER]: ${msg.content}`
          : `[PREVIOUS MESSAGE FROM USER]: ${msg.content}`;
      }

      includedHistory.unshift({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: historyContent });
    }

    formattedMessages.push(...includedHistory);

    // Multimodal payload handling
    if (metadata && metadata.mediaBase64 && metadata.mediaMimeType) {
      const mediaDataUrl = `data:${metadata.mediaMimeType};base64,${metadata.mediaBase64}`;
      const userContent = [];
      const isAudio = Boolean(metadata.mediaType === 'audio' || metadata.mediaType === 'voice' || (metadata.mediaMimeType && metadata.mediaMimeType.startsWith('audio/')));
      const isVideo = Boolean(metadata.mediaType === 'video' || (metadata.mediaMimeType && metadata.mediaMimeType.startsWith('video/')));

      if (isAudio) {
        const transcriptText = metadata.transcript || (currentPrompt && !currentPrompt.startsWith('[') ? currentPrompt : '');
        const contentText = (metadata && metadata.isOwner)
          ? `[DIRECT COMMAND FROM VERIFIED OWNER]: ${transcriptText || 'Audio message received'}`
          : `[INCOMING MESSAGE FROM THIRD-PARTY USER]: ${transcriptText || 'The user sent a voice message. Please reply politely in natural conversational language.'}`;
        formattedMessages.push({ role: 'user', content: contentText });
        return formattedMessages;
      }

      if (isVideo) {
        const queryText = (currentPrompt && currentPrompt.trim() && !currentPrompt.startsWith('['))
          ? currentPrompt.trim()
          : 'Please describe and summarize what you see in this visual scene.';
        userContent.push({
          type: 'text',
          text: (metadata && metadata.isOwner)
            ? `[DIRECT COMMAND FROM VERIFIED OWNER]: ${queryText}`
            : `[INCOMING MESSAGE FROM THIRD-PARTY USER]: ${queryText}`
        });
        userContent.push({
          type: 'image_url',
          image_url: { url: mediaDataUrl }
        });
        formattedMessages.push({ role: 'user', content: userContent });
        return formattedMessages;
      }

      // Standard image message
      const imgPrompt = (currentPrompt && currentPrompt.trim() && !currentPrompt.startsWith('['))
        ? currentPrompt.trim()
        : 'Please analyze this image and respond to the user in a friendly, helpful manner.';
      userContent.push({
        type: 'text',
        text: (metadata && metadata.isOwner)
          ? `[DIRECT COMMAND FROM VERIFIED OWNER]: ${imgPrompt}`
          : `[INCOMING MESSAGE FROM THIRD-PARTY USER]: ${imgPrompt}`
      });
      userContent.push({
        type: 'image_url',
        image_url: { url: mediaDataUrl }
      });
      formattedMessages.push({ role: 'user', content: userContent });
    } else {
      const finalUserContent = (metadata && metadata.isOwner)
        ? `[DIRECT COMMAND FROM VERIFIED OWNER]: ${currentPrompt || 'Hello'}`
        : `[INCOMING MESSAGE FROM THIRD-PARTY USER]: ${currentPrompt || 'Hello'}`;
      formattedMessages.push({ role: 'user', content: finalUserContent });
    }

    return formattedMessages;
  }

  async transcribeAudio(mediaBase64, mediaMimeType = 'audio/ogg') {
    const gKeys = this.groqKeys;
    if (!mediaBase64 || gKeys.length === 0) return null;
    const audioBuffer = Buffer.from(mediaBase64, 'base64');
    if (audioBuffer.length < 500) return null;

    const whisperModels = ['whisper-large-v3-turbo', 'whisper-large-v3'];
    const ext = (mediaMimeType || '').includes('mp3') ? 'mp3' : ((mediaMimeType || '').includes('wav') ? 'wav' : 'ogg');

    for (const model of whisperModels) {
      let attempts = 0;
      const maxAttempts = Math.max(gKeys.length, 1);

      while (attempts < maxAttempts) {
        try {
          const apiKey = gKeys[this.groqKeyIndex % gKeys.length];
          const formData = new FormData();
          const blob = new Blob([audioBuffer], { type: mediaMimeType || 'audio/ogg' });
          formData.append('file', blob, `voice_note.${ext}`);
          formData.append('model', model);
          formData.append('prompt', 'Pakistani Roman Urdu, Urdu, English conversational voice message');

          const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
            method: 'POST',
            signal: AbortSignal.timeout(8000),
            headers: { 'Authorization': `Bearer ${apiKey}` },
            body: formData
          });

          if (res.ok) {
            const data = await res.json();
            const text = (data.text || '').trim();
            if (text) return text;
          } else {
            throw new Error(`Whisper HTTP ${res.status}`);
          }
        } catch (err) {
          attempts++;
          this.rotateKey('groq');
          this.userLogger.warn(`Audio transcription model '${model}' attempt failed: ${err.message}. Rotating Groq key.`);
        }
      }
    }
    return null;
  }

  getGroqClient() {
    const gKeys = this.groqKeys;
    if (gKeys.length === 0) return null;
    const currentKey = gKeys[this.groqKeyIndex % gKeys.length];
    if (GroqSDK) {
      if (!this.groqClients.has(currentKey)) {
        this.groqClients.set(currentKey, new GroqSDK({ apiKey: currentKey }));
      }
      return this.groqClients.get(currentKey);
    }
    return null;
  }

  async executeGroqRequest({ messages, primaryModel, fallbackModels = [], isReasoning, maxTokens, reasoningEffort, reasoningFormat }) {
    const gKeys = this.groqKeys;
    if (gKeys.length === 0) throw new Error('No Groq API keys configured.');
    const candidateModels = [primaryModel, ...(fallbackModels || []).filter(m => m !== primaryModel)];
    let lastError = null;

    for (const model of candidateModels) {
      let attempts = 0;
      const maxAttempts = Math.max(gKeys.length, 1);

      while (attempts < maxAttempts) {
        try {
          const apiKey = gKeys[this.groqKeyIndex % gKeys.length];
          let content = '';
          const isQwen = model.includes('qwen');
          const isGptOss = model.includes('gpt-oss');

          const requestBody = {
            messages,
            model,
            temperature: config.generationTemperature,
            max_tokens: maxTokens
          };

          if (isQwen && !isReasoning) {
            requestBody.reasoning_effort = 'none';
            requestBody.reasoning_format = 'hidden';
          } else if (isGptOss || isReasoning) {
            requestBody.reasoning_format = 'hidden';
          }

          if (GroqSDK) {
            const client = this.getGroqClient();
            if (client) {
              const completion = await client.chat.completions.create(requestBody);
              const choice = completion.choices?.[0];
              content = choice?.message?.content?.trim() || '';
            }
          }

          if (!content) {
            const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
              body: JSON.stringify(requestBody)
            });
            if (!res.ok) {
              const errText = await res.text();
              throw new Error(`Groq HTTP ${res.status}: ${errText}`);
            }
            const data = await res.json();
            const choice = data.choices?.[0];
            content = choice?.message?.content?.trim() || '';
          }

          if (content) {
            return {
              content,
              actualModel: model,
              fallbackUsed: model !== primaryModel
            };
          }
        } catch (err) {
          lastError = err;
          attempts++;
          if (gKeys.length > 1) this.rotateKey('groq');
          this.userLogger.warn(`Groq Model '${model}' attempt ${attempts} failed: ${err.message}. Rotating key.`);
          await new Promise(res => setTimeout(res, 300));
        }
      }
    }
    throw lastError || new Error('All Groq candidate models in pool failed.');
  }

  async executeNvidiaRequest({ messages, primaryModel, fallbackModels = [], isReasoning, maxTokens }) {
    const nKeys = this.nvidiaKeys;
    if (nKeys.length === 0) throw new Error('No NVIDIA API keys configured.');
    const rawCandidates = [primaryModel, ...(fallbackModels || []).filter(m => m !== primaryModel)];
    const candidateModels = rawCandidates.map(m => this.normalizeNvidiaModel(m));
    let lastError = null;

    for (const model of candidateModels) {
      let attempts = 0;
      const maxAttempts = Math.max(nKeys.length, 1);

      while (attempts < maxAttempts) {
        try {
          const apiKey = nKeys[this.nvidiaKeyIndex % nKeys.length];
          const requestBody = {
            messages,
            model,
            temperature: config.generationTemperature,
            max_tokens: maxTokens
          };

          const res = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
            method: 'POST',
            signal: AbortSignal.timeout(20000),
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify(requestBody)
          });

          if (!res.ok) {
            const errText = await res.text();
            throw new Error(`NVIDIA HTTP ${res.status}: ${errText}`);
          }
          const data = await res.json();
          const choice = data.choices?.[0];
          const content = choice?.message?.content?.trim() || '';
          if (content) {
            return {
              content,
              actualModel: model,
              fallbackUsed: model !== this.normalizeNvidiaModel(primaryModel)
            };
          }
        } catch (err) {
          lastError = err;
          attempts++;
          if (nKeys.length > 1) this.rotateKey('nvidia');
          this.userLogger.warn(`NVIDIA Model '${model}' attempt ${attempts} failed: ${err.message}. Rotating key.`);
          await new Promise(res => setTimeout(res, 300));
        }
      }
    }
    throw lastError || new Error('All NVIDIA candidate models in pool failed.');
  }

  cleanResponse(text) {
    if (!text || typeof text !== 'string') return '';
    let cleaned = text;

    cleaned = cleaned.replace(/<(think|thought|reasoning|reflection)>[\s\S]*?<\/\1>/gi, '');
    cleaned = cleaned.replace(/<(think|thought|reasoning|reflection)>[\s\S]*/gi, '');

    const finalMarkerMatch = cleaned.match(/(?:^|\n)(?:#{1,4}\s*)?(?:\*\*)?(?:Final\s+(?:Response|Answer|Output|Message)|Final:)(?:\*\*)?:?\s*\n*([\s\S]*)$/i);
    if (finalMarkerMatch && finalMarkerMatch[1] && finalMarkerMatch[1].trim()) {
      cleaned = finalMarkerMatch[1];
    } else {
      cleaned = cleaned.replace(/(?:^|\n)Here's a thinking process:[\s\S]*?(?=\n\n[^\d\*\s]|\n\n[A-Za-z]|$)/gi, '');
      cleaned = cleaned.replace(/(?:^|\n)Thinking Process:?[\s\S]*?(?=\n\n[^\d\*\s]|\n\n[A-Za-z]|$)/gi, '');
      cleaned = cleaned.replace(/(?:^|\n)\d+\.\s*\*(?:Analyze|Check System|Check Identity|Determine|Self-Correction|Refine|Draft Response)[\s\S]*?(?=\n\n|\n\d+\.\s*\*|$)/gi, '');
      cleaned = cleaned.replace(/(?:^|\n)(?:#{1,4}\s*)?(?:\*\*)?(?:Draft\s+Response|Refine\s*(?:\([^)]*\))?|Final\s+Check)(?:\*\*)?:?[\s\S]*?(?=\n\n|$)/gi, '');
    }

    cleaned = cleaned.replace(/^(?:Matches rules\??\s*(?:Yes|No|True|False)|Decision Check:?\s*(?:Passed|OK|Yes|No)|Silently verify:?.*)$/gim, '');
    cleaned = cleaned.trim();

    if (/^(?:Done\.|Output matches\.|Proceeds\.|Ready\.|\(Self-Correction\/Refinement during thought\))\s*$/im.test(cleaned)) {
      return '';
    }

    return cleaned.trim();
  }

  getMediaRejectionMessage(mediaType = 'media') {
    const t = (mediaType || '').toLowerCase();
    if (t === 'image' || t.startsWith('image/')) {
      return "I'm currently unable to process image messages.";
    }
    if (t === 'audio' || t === 'voice' || t.startsWith('audio/')) {
      return "I'm currently unable to process voice messages.";
    }
    if (t === 'video' || t.startsWith('video/')) {
      return "I'm currently unable to process video messages.";
    }
    if (t === 'document' || t.startsWith('application/')) {
      return "I'm currently unable to process document files.";
    }
    return "I'm currently unable to process media messages.";
  }

  async generateResponse(prompt, history = [], metadata = {}) {
    const startTime = Date.now();
    const provider = this.getActiveProvider();
    const isImage = Boolean(metadata.mediaType === 'image' || (metadata.mediaMimeType && metadata.mediaMimeType.startsWith('image/')));
    const isAudio = Boolean(metadata.mediaType === 'audio' || metadata.mediaType === 'voice' || (metadata.mediaMimeType && metadata.mediaMimeType.startsWith('audio/')));
    const isVideo = Boolean(metadata.mediaType === 'video' || (metadata.mediaMimeType && metadata.mediaMimeType.startsWith('video/')));
    let isMedia = isImage || isAudio || isVideo || Boolean(metadata.isMedia);

    if (isVideo) {
      this.userLogger.info('Received video message: Returning configured text-only rejection.');
      return this.getMediaRejectionMessage('video');
    }

    if (isAudio) {
      if (metadata.mediaBase64) {
        try {
          const transcript = await this.transcribeAudio(metadata.mediaBase64, metadata.mediaMimeType);
          if (transcript) {
            metadata.transcript = transcript;
            prompt = transcript;
            metadata.isMedia = false;
            isMedia = false;
            metadata.mediaType = 'text';
            this.userLogger.info(`Voice note transcribed successfully: "${transcript.substring(0, 80)}" -> Routing to Chat Model`);
          } else {
            return "I received your voice message, but couldn't transcribe the audio clearly. Please send your message in text!";
          }
        } catch (tErr) {
          return "I received your voice message, but couldn't transcribe the audio clearly. Please send your message in text!";
        }
      } else if (metadata.transcript) {
        prompt = metadata.transcript;
        metadata.isMedia = false;
        isMedia = false;
        metadata.mediaType = 'text';
      } else {
        return this.getMediaRejectionMessage('audio');
      }
    }

    const routeResult = await this.routePrompt(prompt, history, provider, metadata);

    if (isImage) {
      if (metadata.mediaBase64 && this.nvidiaKeys.length > 0) {
        try {
          const nvidiaSelect = this.selectModel('multimodal', 'nvidia');
          const messages = this.prepareMessages(history, prompt, false, metadata);
          const executionResult = await this.executeNvidiaRequest({
            messages,
            primaryModel: nvidiaSelect.model,
            fallbackModels: nvidiaSelect.fallbackModels,
            isReasoning: false,
            maxTokens: nvidiaSelect.maxTokens
          });
          const cleaned = this.cleanResponse(executionResult.content);
          return cleaned || executionResult.content;
        } catch (vErr) {
          this.userLogger.warn(`Vision model processing failed: ${vErr.message}`);
        }
      }
      return this.getMediaRejectionMessage('image');
    }

    const primaryProvider = (provider === 'auto') ? (this.groqKeys.length > 0 ? 'groq' : 'nvidia') : provider;
    const secondaryProvider = primaryProvider === 'nvidia' ? 'groq' : 'nvidia';

    let executionResult = null;
    let finalProviderUsed = primaryProvider;

    const primarySelect = this.selectModel(routeResult.route, primaryProvider);
    this.userLogger.info(`[SELECTION] Route: ${routeResult.route.toUpperCase()} | Provider: ${primaryProvider.toUpperCase()} | Primary: ${primarySelect.model} | Fallbacks: ${primarySelect.fallbackModels?.join(', ') || 'none'}`);

    try {
      const messages = this.prepareMessages(history, prompt, primarySelect.isReasoning, metadata);

      if (primaryProvider === 'nvidia') {
        executionResult = await this.executeNvidiaRequest({
          messages,
          primaryModel: primarySelect.model,
          fallbackModels: primarySelect.fallbackModels,
          isReasoning: primarySelect.isReasoning,
          maxTokens: primarySelect.maxTokens
        });
      } else {
        executionResult = await this.executeGroqRequest({
          messages,
          primaryModel: primarySelect.model,
          fallbackModels: primarySelect.fallbackModels,
          isReasoning: primarySelect.isReasoning,
          maxTokens: primarySelect.maxTokens,
          reasoningEffort: primarySelect.reasoningEffort,
          reasoningFormat: primarySelect.reasoningFormat
        });
      }
    } catch (primaryErr) {
      this.userLogger.warn(`[FAILOVER] ${primaryProvider.toUpperCase()} primary provider exhausted (${primaryErr.message}). Attempting failover to ${secondaryProvider.toUpperCase()}...`);
      finalProviderUsed = secondaryProvider;

      const secondarySelect = this.selectModel(routeResult.route, secondaryProvider);
      this.userLogger.info(`[SELECTION] Route: ${routeResult.route.toUpperCase()} | Provider: ${secondaryProvider.toUpperCase()} | Primary: ${secondarySelect.model} | Fallbacks: ${secondarySelect.fallbackModels?.join(', ') || 'none'}`);
      const messages = this.prepareMessages(history, prompt, secondarySelect.isReasoning, metadata);

      if (secondaryProvider === 'nvidia') {
        executionResult = await this.executeNvidiaRequest({
          messages,
          primaryModel: secondarySelect.model,
          fallbackModels: secondarySelect.fallbackModels,
          isReasoning: secondarySelect.isReasoning,
          maxTokens: secondarySelect.maxTokens
        });
      } else {
        executionResult = await this.executeGroqRequest({
          messages,
          primaryModel: secondarySelect.model,
          fallbackModels: secondarySelect.fallbackModels,
          isReasoning: secondarySelect.isReasoning,
          maxTokens: secondarySelect.maxTokens,
          reasoningEffort: secondarySelect.reasoningEffort,
          reasoningFormat: secondarySelect.reasoningFormat
        });
      }
    }

    const rawOutput = executionResult.content;
    let cleaned = this.cleanResponse(rawOutput);

    if (!cleaned) {
      this.userLogger.warn('[OUTPUT] Initial output contained reasoning/scaffolding only. Retrying once with strict direct answer prompt...');
      const messages = this.prepareMessages(history, prompt, false, metadata);
      const retryMessages = [
        ...messages,
        { role: 'user', content: '[IMPORTANT: Give ONLY the final conversational answer. Do not output reasoning or checks.]' }
      ];
      try {
        if (finalProviderUsed === 'nvidia') {
          const retryResult = await this.executeNvidiaRequest({
            messages: retryMessages,
            primaryModel: executionResult.actualModel,
            fallbackModels: [],
            isReasoning: false,
            maxTokens: config.simpleMaxTokens
          });
          cleaned = this.cleanResponse(retryResult.content);
        } else {
          const retryResult = await this.executeGroqRequest({
            messages: retryMessages,
            primaryModel: executionResult.actualModel,
            fallbackModels: [],
            isReasoning: false,
            maxTokens: config.simpleMaxTokens,
            reasoningEffort: 'none',
            reasoningFormat: 'hidden'
          });
          cleaned = this.cleanResponse(retryResult.content);
        }
      } catch (retryErr) {
        this.userLogger.warn(`Defensive retry failed: ${retryErr.message}`);
      }
    }

    const durationMs = Date.now() - startTime;
    const finalClean = cleaned || executionResult.content || '';

    this.userLogger.info(`[OUTPUT] Status: SUCCESS | Provider: ${finalProviderUsed.toUpperCase()} | Model: ${executionResult.actualModel} | Latency: ${durationMs}ms | Preview: "${finalClean.substring(0, 80).replace(/\n/g, ' ')}..."`);

    return finalClean;
  }

  getStatus() {
    const provider = this.getActiveProvider();
    const gKeys = this.groqKeys;
    const nKeys = this.nvidiaKeys;
    const activeKeys = provider === 'nvidia' ? nKeys : gKeys;
    const activeIndex = provider === 'nvidia' ? (this.nvidiaKeyIndex % Math.max(nKeys.length, 1)) : (this.groqKeyIndex % Math.max(gKeys.length, 1));
    const groqKey = gKeys.length > 0 ? this.maskKey(gKeys[this.groqKeyIndex % gKeys.length]) : '[NO KEY CONFIGURED]';
    const nvidiaKey = nKeys.length > 0 ? this.maskKey(nKeys[this.nvidiaKeyIndex % nKeys.length]) : '[NO KEY CONFIGURED]';

    return {
      activeProvider: provider,
      activeKeyIndex: activeIndex,
      totalKeysConfigured: activeKeys.length,
      groq: {
        keysConfigured: gKeys.length,
        activeKeyIndex: this.groqKeyIndex % Math.max(gKeys.length, 1),
        activeMaskedKey: groqKey,
        routerModel: config.routerModel,
        routerFallbackModels: config.groqRouterFallbackModels,
        simpleModel: config.groqModelSimple,
        simpleFallbackModels: config.groqSimpleFallbackModels,
        reasoningModel: config.groqModelReasoning,
        reasoningFallbackModels: config.groqReasoningFallbackModels,
        multimodal: "NOT PROCESSED (canned response: 'I\\'m currently unable to process image or voice messages.')"
      },
      nvidia: {
        keysConfigured: nKeys.length,
        activeKeyIndex: this.nvidiaKeyIndex % Math.max(nKeys.length, 1),
        activeMaskedKey: nvidiaKey,
        routerModel: config.nvidiaRouterModel,
        routerFallbackModels: config.nvidiaRouterFallbackModels,
        simpleModel: config.nvidiaModelSimple,
        simpleFallbackModels: config.nvidiaSimpleFallbackModels,
        reasoningModel: config.nvidiaModelReasoning,
        reasoningFallbackModels: config.nvidiaReasoningFallbackModels,
        multimodalModel: config.nvidiaModelMultimodal,
        multimodalFallbackModels: config.nvidiaMultimodalFallbackModels
      }
    };
  }
}

export const aiProvider = new AIProviderManager('user_gohar');
