export function readConfig(env = process.env, options = {}) {
  const requireJwt = options.requireJwt !== false;
  const jwtSecret = env.JWT_SECRET || env.JANUS_JWT_SECRET || '';
  if (requireJwt && (!jwtSecret || jwtSecret.length < 32)) {
    throw new Error('JWT_SECRET must be at least 32 characters.');
  }
  return {
    port: Number(env.PORT || 8787),
    host: String(env.JANUS_CLOUD_HOST || env.HOST || '127.0.0.1').trim() || '127.0.0.1',
    databaseUrl: env.DATABASE_URL || '',
    evolutionWorkerDatabaseUrl: env.EVOLUTION_WORKER_DATABASE_URL || (env.NODE_ENV === 'production' ? '' : env.DATABASE_URL || ''),
    migratorDatabaseUrl: env.DATABASE_MIGRATOR_URL || (env.NODE_ENV === 'production' ? '' : env.DATABASE_URL || ''),
    production: env.NODE_ENV === 'production',
    jwtSecret,
    emailCodeSecret: env.EMAIL_CODE_SECRET || jwtSecret,
    accessTokenTtlSeconds: Number(env.ACCESS_TOKEN_TTL_SECONDS || 15 * 60),
    refreshTokenTtlDays: Number(env.REFRESH_TOKEN_TTL_DAYS || 30),
    emailCodeTtlMinutes: Number(env.EMAIL_CODE_TTL_MINUTES || 10),
    emailCodeResendSeconds: Number(env.EMAIL_CODE_RESEND_SECONDS || env.JANUS_EMAIL_CODE_RESEND_SECONDS || 60),
    organizationSecondaryVerificationTtlSeconds: Number(env.ORGANIZATION_SECONDARY_VERIFICATION_TTL_SECONDS || 7 * 24 * 60 * 60),
    mailFrom: env.MAIL_FROM || 'Janus <no-reply@janus.local>',
    providerKeyApplicationEmail: env.JANUS_PROVIDER_KEY_APPLICATION_EMAIL || env.PROVIDER_KEY_APPLICATION_EMAIL || '',
    providerKeyDistributionBaseUrl: env.JANUS_PROVIDER_KEY_DISTRIBUTION_BASE_URL || env.JANUS_TRIAL_CODEX_BASE_URL || '',
    providerKeyDistributionKey: env.JANUS_PROVIDER_KEY_DISTRIBUTION_KEY || env.JANUS_TRIAL_CODEX_KEY || '',
    providerKeyDistributionModel: env.JANUS_PROVIDER_KEY_DISTRIBUTION_MODEL || '',
    smtpUrl: env.SMTP_URL || '',
    smtpHost: env.SMTP_HOST || '',
    smtpPort: Number(env.SMTP_PORT || 587),
    smtpUser: env.SMTP_USER || '',
    smtpPass: env.SMTP_PASS || '',
    smtpSecure: String(env.SMTP_SECURE || '').toLowerCase() === 'true',
    mailProvider: env.MAIL_PROVIDER || (env.SMTP_URL || env.SMTP_HOST ? 'smtp' : 'unconfigured'),
  };
}
