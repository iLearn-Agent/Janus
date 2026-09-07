export class ElectronCredentialCodec {
  constructor({ safeStorage, platform = process.platform } = {}) {
    this.safeStorage = safeStorage;
    this.platform = platform;
  }

  status() {
    const available = Boolean(this.safeStorage?.isEncryptionAvailable?.());
    const backend = this.safeStorage?.getSelectedStorageBackend?.() || 'unknown';
    const secure = available && !(this.platform === 'linux' && backend === 'basic_text');
    return { available, backend, secure };
  }

  encrypt(value) {
    const status = this.status();
    if (!status.secure) {
      const error = new Error(status.backend === 'basic_text'
        ? '当前 Linux 密钥存储后端不安全，无法保存飞书 App Secret。请启用系统密钥环后重试。'
        : '当前系统的安全凭证存储不可用，无法保存飞书 App Secret。');
      error.code = 'secure_storage_unavailable';
      throw error;
    }
    return this.safeStorage.encryptString(String(value || '')).toString('base64');
  }

  decrypt(value) {
    const status = this.status();
    if (!status.secure) {
      const error = new Error('安全凭证存储不可用，飞书连接保持关闭。');
      error.code = 'secure_storage_unavailable';
      throw error;
    }
    return this.safeStorage.decryptString(Buffer.from(String(value || ''), 'base64'));
  }
}
