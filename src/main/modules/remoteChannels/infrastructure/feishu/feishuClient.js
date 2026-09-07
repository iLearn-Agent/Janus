import { Client, Domain, EventDispatcher, LoggerLevel, WSClient } from '@larksuiteoapi/node-sdk';

function sdkDomain(domain) {
  return domain === 'lark' ? Domain.Lark : Domain.Feishu;
}

export class FeishuClient {
  constructor({ config, onMessage, onCardAction, onStatus = () => {}, logger = console } = {}) {
    this.config = config;
    this.onMessage = onMessage;
    this.onCardAction = onCardAction;
    this.onStatus = onStatus;
    this.logger = logger;
    this.client = null;
    this.wsClient = null;
  }

  createApiClient() {
    return new Client({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: sdkDomain(this.config.domain),
      loggerLevel: LoggerLevel.warn,
      source: 'janus-desktop',
    });
  }

  async testConnection() {
    const client = this.createApiClient();
    await client.tokenManager.getTenantAccessToken();
    return { ok: true };
  }

  start() {
    this.client = this.createApiClient();
    const dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.warn }).register({
      'im.message.receive_v1': (event) => {
        try { void this.onMessage?.(event); } catch (error) { this.logger.warn?.('Feishu message callback failed.', error); }
      },
      'card.action.trigger': async (event) => {
        try { return await this.onCardAction?.(event); } catch (error) {
          this.logger.warn?.('Feishu card action callback failed.', error);
          return { toast: { type: 'error', content: '操作失败，请重新发起分配任务。' } };
        }
      },
    });
    this.wsClient = new WSClient({
      appId: this.config.appId,
      appSecret: this.config.appSecret,
      domain: sdkDomain(this.config.domain),
      loggerLevel: LoggerLevel.warn,
      autoReconnect: true,
      source: 'janus-desktop',
      handshakeTimeoutMs: 15_000,
      onReady: () => this.onStatus({ connectionState: 'connected', lastError: '' }),
      onReconnecting: () => this.onStatus({ connectionState: 'reconnecting' }),
      onReconnected: () => this.onStatus({ connectionState: 'connected', lastError: '' }),
      onError: (error) => this.onStatus({ connectionState: 'error', lastError: String(error?.message || error) }),
    });
    this.onStatus({ connectionState: 'connecting', lastError: '' });
    void this.wsClient.start({ eventDispatcher: dispatcher }).catch((error) => {
      this.onStatus({ connectionState: 'error', lastError: String(error?.message || error) });
    });
  }

  stop() {
    this.wsClient?.close?.({ force: true });
    this.wsClient = null;
    this.client = null;
    this.onStatus({ connectionState: 'disabled' });
  }

  connectionStatus() {
    return this.wsClient?.getConnectionStatus?.() || { state: 'idle' };
  }

  async reply(messageId, text, uuid = '') {
    if (!this.client) throw new Error('飞书连接尚未启动。');
    return this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text: String(text || '') }),
        msg_type: 'text',
        ...(uuid ? { uuid } : {}),
      },
    });
  }

  async replyCard(messageId, card, uuid = '') {
    if (!this.client) throw new Error('飞书连接尚未启动。');
    return this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(card || {}),
        msg_type: 'interactive',
        ...(uuid ? { uuid } : {}),
      },
    });
  }
}
