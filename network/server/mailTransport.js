import nodemailer from 'nodemailer';

export function createMailTransport(config, { logger = console } = {}) {
  if (config.mailProvider === 'console') {
    return {
      async sendMail({ to, subject, text, meta = {} }) {
        logger.info(`[janus-cloud] email code purpose=${meta.purpose || ''} email=${to} code=${meta.code || ''} expiresAt=${meta.expiresAt || ''}`);
      },
    };
  }

  if (!config.smtpUrl && !config.smtpHost) {
    throw new Error('SMTP_URL or SMTP_HOST must be configured for email delivery.');
  }

  return config.smtpUrl
    ? nodemailer.createTransport(config.smtpUrl)
    : nodemailer.createTransport({
        host: config.smtpHost,
        port: config.smtpPort,
        secure: config.smtpSecure,
        auth: config.smtpUser ? { user: config.smtpUser, pass: config.smtpPass } : undefined,
      });
}
