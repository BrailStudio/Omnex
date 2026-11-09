export class Conversation {
  constructor(maxTurns = 20) {
    this.history = [];
    this.maxTurns = maxTurns;
  }

  async send(userText) {
    this.history.push({ role: 'user', content: userText });
    const trimmed = this.history.slice(-this.maxTurns * 2);
    const result = await window.omnex.chat(trimmed);
    if (result.source === 'error') {
      this.history.pop(); // don't keep failed turns in context
    } else {
      this.history.push({ role: 'assistant', content: result.text });
    }
    return result; // { text, source: 'local'|'cloud'|'error', fellBack?, error? }
  }
}
