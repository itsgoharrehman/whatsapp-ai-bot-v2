import { config } from '../config.js';
import { aiProvider } from './provider.js';

class GroqManager {
  get keys() {
    return aiProvider.groqKeys;
  }

  get currentKeyIndex() {
    return aiProvider.groqKeyIndex;
  }

  rotateKey() {
    aiProvider.rotateKey('groq');
  }

  selectModel(prompt) {
    const isReasoning = aiProvider.isReasoningPrompt(prompt);
    return isReasoning ? config.groqModelReasoning : config.groqModelSimple;
  }

  async generateResponse(prompt, history = []) {
    return await aiProvider.generateResponse(prompt, history);
  }

  getStatus() {
    return aiProvider.getStatus();
  }
}

export const groq = new GroqManager();
export { aiProvider };

