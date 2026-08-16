import { config } from '../config.js';
import { db } from '../utils/db.js';
import { aiProvider as defaultAiProvider } from '../ai/provider.js';

function formatChain(primary, fallbacks) {
  if (!primary) return 'N/A';
  const f = Array.isArray(fallbacks) ? fallbacks.join(', ') : fallbacks;
  if (!f || f === 'undefined') return primary;
  return `${primary}\n  ↳ *fallback*: ${f}`;
}

function formatProviderDetails(pName, pObj) {
  if (!pObj) return '';
  const isGroq = (pName || '').toLowerCase() === 'groq';
  const routerChain = formatChain(pObj.routerModel, pObj.routerFallbackModels);
  const simpleChain = formatChain(pObj.simpleModel, pObj.simpleFallbackModels);
  const reasoningChain = formatChain(pObj.reasoningModel, pObj.reasoningFallbackModels);
  const multimodalChain = isGroq
    ? 'NOT PROCESSED (canned reply: "I\'m currently unable to process image, voice, or video messages.")'
    : `${formatChain(pObj.multimodalModel, pObj.multimodalFallbackModels)}\n🎤 *Voice/Audio*: Transcribed via Whisper -> Routed to Chat Model\n🎬 *Video*: NOT PROCESSED (canned reply: "I\'m currently unable to process video messages.")`;

  return `🎯 *Model Selector (Router)*:\n${routerChain}
💬 *Simple / Normal Chat*:\n${simpleChain}
🧠 *Reasoning / Difficult*:\n${reasoningChain}
🖼️ *Multimodal (Images / Media)*:\n${multimodalChain}`;
}

export default {
  isOwner(senderJid, isFromMe = false, userId = 'user_gohar') {
    if (isFromMe) return true;
    if (!senderJid) return false;
    const senderNumber = senderJid.split('@')[0].split(':')[0];
    const tenantOwnerNumber = db.getOwnerNumber(userId) || config.ownerNumber;
    return Boolean(tenantOwnerNumber && senderNumber === tenantOwnerNumber);
  },

  formatUptime() {
    const seconds = Math.floor(process.uptime());
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
  },

  async handleCommand(commandText, senderJid, isFromMe = false, userId = 'user_gohar', customAiProvider = null) {
    const trimmed = commandText.trim();
    if (!trimmed.startsWith('/')) return null;
    if (!this.isOwner(senderJid, isFromMe, userId)) {
      return `\`\`\`\n┌── [ACCESS DENIED] ───────────────\n│ Status : Unauthorized\n│ Detail : Owner permission required\n└──────────────────────────────────\`\`\``;
    }

    const ai = customAiProvider || defaultAiProvider;
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    if (cmd === '/help') {
      return `🤖 *Mark Zuckerberg Assistant Menu*
────────────────────────
• */status* : System metrics & active models
• */models* : Full model & fallback architecture
• */provider* [groq|nvidia|auto] : Switch AI provider
• */rotate* [groq|nvidia] : Rotate active key
• */reset* [all|chat] : Reset database history & statistics
• */auto* [on|off] : Toggle auto-reply mechanism
• */help* : Display command menu`;
    }

    if (cmd === '/status') {
      const analytics = db.getAnalytics(userId);
      const statusInfo = ai.getStatus();
      const activeP = statusInfo.activeProvider.toUpperCase();
      const activeDetails = statusInfo[statusInfo.activeProvider] || statusInfo.groq;
      const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);

      return `📊 *Mark Zuckerberg Assistant Status*
────────────────────────
• *Status* : ONLINE
• *Uptime* : ${this.formatUptime()}
• *RAM Usage* : ${mem} MB
• *Auto Reply* : ${db.getAutoReply(userId) ? 'ENABLED' : 'DISABLED'}
• *Provider* : ${activeP}
• *Active Key* : #${activeDetails.activeKeyIndex + 1} (${activeDetails.activeMaskedKey})
• *Rotations* : ${analytics.keyRotationsCount || 0}
• *Processed* : ${analytics.totalMessagesProcessed || 0} msgs
• *Replies Sent* : ${analytics.totalRepliesSent || 0}
────────────────────────
🏛️ *Active Model Hierarchy*
${formatProviderDetails(statusInfo.activeProvider, activeDetails)}`;
    }

    if (cmd === '/models') {
      const statusInfo = ai.getStatus();
      return `🏛️ *AI Models Architecture Tree*
────────────────────────
🟢 *NVIDIA (NIM)*
${formatProviderDetails('nvidia', statusInfo.nvidia)}

────────────────────────
🔵 *GROQ*
${formatProviderDetails('groq', statusInfo.groq)}`;
    }

    if (cmd === '/provider') {
      const target = (args[0] || '').toLowerCase();
      if (!target) {
        const currentP = db.getProvider(userId).toUpperCase();
        const info = ai.getStatus();
        const currentDetails = info[info.activeProvider] || info.groq;
        return `⚙️ *AI Provider Settings*
────────────────────────
• *Active Provider* : ${currentP}
• *Active Key* : #${currentDetails.activeKeyIndex + 1} (${currentDetails.activeMaskedKey})
────────────────────────
${formatProviderDetails(info.activeProvider, currentDetails)}
────────────────────────
• *Options* : groq | nvidia | auto`;
      }

      try {
        const updated = ai.setProvider(target);
        const info = ai.getStatus();
        const newDetails = info[updated] || info.groq;
        return `✅ *Provider Updated*
────────────────────────
• *New Provider* : ${updated.toUpperCase()}
• *Active Key* : #${newDetails.activeKeyIndex + 1} (${newDetails.activeMaskedKey})
────────────────────────
${formatProviderDetails(updated, newDetails)}`;
      } catch (err) {
        return `❌ *Provider Error*
────────────────────────
• *Error* : ${err.message}`;
      }
    }

    if (cmd === '/rotate') {
      const targetProvider = (args[0] || '').toLowerCase() || null;
      const res = ai.rotateKey(targetProvider);
      return `🔄 *Key Rotation Report*
────────────────────────
• *Provider* : ${res.provider.toUpperCase()}
• *Rotated* : ${res.rotated ? 'YES' : 'NO'}
• *Key Index* : #${res.index + 1} of ${res.total}
• *Active Key* : ${res.key}`;
    }

    if (cmd === '/reset') {
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'chat') {
        db.clearContext(userId, senderJid);
        return `🧹 *Chat Context Cleared*
────────────────────────
• *Target* : Current Chat
• *Status* : History cleared successfully`;
      }

      db.resetUserData(userId);
      return `🧹 *Database Reset Complete*
────────────────────────
• *Conversations* : Cleared (0 active)
• *Statistics* : Reset to 0
• *Auto-Reply* : ${db.getAutoReply(userId) ? 'ENABLED' : 'DISABLED'}
• *Status* : Fresh start ready`;
    }

    if (cmd === '/auto') {
      const sub = (args[0] || '').toLowerCase();
      if (sub === 'on') {
        db.setAutoReply(userId, true);
        return `✅ *Auto-Reply Enabled*`;
      }
      if (sub === 'off') {
        db.setAutoReply(userId, false);
        return `🛑 *Auto-Reply Disabled*`;
      }
      return `⚙️ *Auto-Reply Setting*
────────────────────────
• *Current State* : ${db.getAutoReply(userId) ? 'ENABLED' : 'DISABLED'}
• *Usage* : /auto on | off`;
    }

    return `❓ *Unknown Command* : ${cmd}\nType */help* for available commands.`;
  }
};
