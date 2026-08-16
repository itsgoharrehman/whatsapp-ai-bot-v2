import { config } from '../config.js';
import { logger } from './logger.js';

export default {
  unwrapMessage(rawMessage) {
    if (!rawMessage || !rawMessage.message) return null;
    let message = rawMessage.message;

    if (message.ephemeralMessage) message = message.ephemeralMessage.message;
    if (message.viewOnceMessage) message = message.viewOnceMessage.message;
    if (message.viewOnceMessageV2) message = message.viewOnceMessageV2.message;
    if (message.documentWithCaptionMessage) message = message.documentWithCaptionMessage.message;
    if (message.editedMessage) message = message.editedMessage.message?.protocolMessage?.editedMessage || message;

    return message;
  },

  detectMediaType(unwrappedMessage) {
    if (!unwrappedMessage) return 'text';
    if (unwrappedMessage.imageMessage) return 'image';
    if (unwrappedMessage.audioMessage) return 'audio';
    if (unwrappedMessage.videoMessage) return 'video';
    if (unwrappedMessage.documentMessage) return 'document';
    if (unwrappedMessage.stickerMessage) return 'sticker';
    return 'text';
  },

  hasMedia(unwrappedMessage) {
    if (!unwrappedMessage) return false;
    return Boolean(
      unwrappedMessage.imageMessage ||
      unwrappedMessage.audioMessage ||
      unwrappedMessage.videoMessage ||
      unwrappedMessage.documentMessage ||
      unwrappedMessage.stickerMessage
    );
  },

  extractMessageText(unwrappedMessage) {
    if (!unwrappedMessage) return '';
    return (
      unwrappedMessage.conversation ||
      unwrappedMessage.extendedTextMessage?.text ||
      unwrappedMessage.imageMessage?.caption ||
      unwrappedMessage.videoMessage?.caption ||
      unwrappedMessage.documentMessage?.caption ||
      unwrappedMessage.buttonsResponseMessage?.selectedButtonId ||
      unwrappedMessage.listResponseMessage?.singleSelectReply?.selectedRowId ||
      ''
    );
  },

  normalizeJid(jid) {
    if (!jid || typeof jid !== 'string') return '';
    return jid.split('@')[0].split(':')[0];
  },

  isBroadcastOrNewsletter(jid) {
    return jid && (jid.endsWith('@newsletter') || jid.endsWith('@broadcast'));
  },

  isGroup(jid) {
    return jid && jid.endsWith('@g.us');
  },

  extractQuotedText(rawMessage) {
    const unwrapped = this.unwrapMessage(rawMessage);
    if (!unwrapped) return '';
    const contextInfo =
      unwrapped.extendedTextMessage?.contextInfo ||
      unwrapped.imageMessage?.contextInfo ||
      unwrapped.videoMessage?.contextInfo ||
      unwrapped.audioMessage?.contextInfo ||
      unwrapped.documentMessage?.contextInfo;

    if (!contextInfo || !contextInfo.quotedMessage) return '';
    const quotedUnwrapped = this.unwrapMessage({ message: contextInfo.quotedMessage });
    return this.extractMessageText(quotedUnwrapped);
  },

  isBotMentionedInGroup(msg, botJid, botLid = null, messageText = '', customBotTag = null, username = null) {
    if (!msg) return false;
    const unwrapped = this.unwrapMessage(msg);
    const botPhoneNum = this.normalizeJid(botJid);
    const botLidNum = this.normalizeJid(botLid);

    const contextInfo =
      unwrapped.extendedTextMessage?.contextInfo ||
      unwrapped.imageMessage?.contextInfo ||
      unwrapped.videoMessage?.contextInfo ||
      unwrapped.audioMessage?.contextInfo ||
      unwrapped.documentMessage?.contextInfo;

    if (contextInfo) {
      // 1. Check if bot is explicitly mentioned in mentionedJid list
      if (Array.isArray(contextInfo.mentionedJid) && contextInfo.mentionedJid.length > 0) {
        const isMentioned = contextInfo.mentionedJid.some(jid => {
          if (!jid) return false;
          if (botJid && jid === botJid) return true;
          if (botLid && jid === botLid) return true;
          const num = this.normalizeJid(jid);
          if (botPhoneNum && num === botPhoneNum) return true;
          if (botLidNum && num === botLidNum) return true;
          return false;
        });
        if (isMentioned) return true;
      }

      // 2. Check if this is a quote/reply specifically to the bot's message
      if (contextInfo.participant) {
        const quoted = contextInfo.participant;
        if (botJid && quoted === botJid) return true;
        if (botLid && quoted === botLid) return true;
        const quotedNum = this.normalizeJid(quoted);
        if (botPhoneNum && quotedNum === botPhoneNum) return true;
        if (botLidNum && quotedNum === botLidNum) return true;
      }
    }

    // 3. Check tenant-specific text tags: @<botNumber>, @<username>, @<customBotTag>
    if (messageText) {
      const cleanText = messageText.toLowerCase().trim();
      const tag = customBotTag ? customBotTag.toLowerCase().replace(/^@+/, '').trim() : '';
      const uname = username ? username.toLowerCase().replace(/^@+/, '').trim() : '';

      if (
        (tag && (cleanText.includes(`@${tag}`) || cleanText.startsWith(`${tag} `) || cleanText === tag)) ||
        (uname && (cleanText.includes(`@${uname}`) || cleanText.startsWith(`${uname} `) || cleanText === uname)) ||
        (botPhoneNum && cleanText.includes(`@${botPhoneNum}`)) ||
        (botLidNum && cleanText.includes(`@${botLidNum}`))
      ) {
        return true;
      }
    }

    return false;
  },

  async hasGroupWritePermission(sock, groupJid, botJid) {
    return true; // Safe no-op
  }
};
