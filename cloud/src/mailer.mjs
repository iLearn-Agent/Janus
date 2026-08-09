import { createMailTransport } from '../../network/server/mailTransport.js';

export function createMailer(config) {
  const transport = createMailTransport(config);

  return {
    async sendEmailCode({ email, purpose, code, expiresAt }) {
      await transport.sendMail({
        from: config.mailFrom,
        to: email,
        subject: emailSubject(purpose),
        text: `你的 Janus 邮箱验证码是 ${code}，有效期至 ${expiresAt}。如果不是你本人操作，请忽略这封邮件。`,
        meta: { purpose, code, expiresAt },
      });
    },
    async sendProviderKeyApplication({ recipient, applicationId, user, organization, usage, submittedAt }) {
      await transport.sendMail({
        from: config.mailFrom,
        to: recipient,
        replyTo: user.email,
        subject: `Janus Provider Key 申请：${organization}`,
        text: [
          '收到新的 Janus Provider Key 申请。',
          '',
          `申请 ID：${applicationId}`,
          `账号 ID：${user.id}`,
          `账号邮箱：${user.email}`,
          `显示名称：${user.displayName || user.display_name || '-'}`,
          `机构名称：${organization}`,
          `申请用途：${usage || '-'}`,
          `提交时间：${submittedAt}`,
          '',
          '请在 Janus 桌面端的高级配置审核区批准或拒绝。批准后用户可在自己的高级配置中一键领取。',
        ].join('\n'),
        meta: { purpose: 'provider_key_application', applicationId, userId: user.id, organization, submittedAt },
      });
    },
    async sendProviderKeyDecision({ user, applicationId, organization, status, note = '' }) {
      const approved = status === 'approved';
      await transport.sendMail({
        from: config.mailFrom,
        to: user.email,
        subject: approved ? `Janus Provider Key 申请已通过：${organization}` : `Janus Provider Key 申请结果：${organization}`,
        text: approved
          ? [
            '你的 Janus Provider Key 申请已通过。',
            '',
            `申请 ID：${applicationId}`,
            `机构名称：${organization}`,
            `审核备注：${note || '-'}`,
            '',
            '请登录 Janus，打开“高级配置 → 申请 Janus Provider Key”，点击“领取并写入配置”。',
            '真实 Key 不会通过邮件发送。',
          ].join('\n')
          : [
            '你的 Janus Provider Key 申请未通过，或再次领取资格已被撤销。',
            '',
            `申请 ID：${applicationId}`,
            `机构名称：${organization}`,
            `审核备注：${note || '-'}`,
            '',
            '如果你此前已经领取共享 Key，本次状态变更不会远程删除本机 Key；共享 Key 轮换后旧 Key 才会真正失效。',
          ].join('\n'),
        meta: { purpose: 'provider_key_decision', applicationId, userId: user.id, status },
      });
    },
  };
}

function emailSubject(purpose) {
  if (purpose === 'password_reset') return 'Janus 密码重置验证码';
  if (purpose === 'password_change') return 'Janus 修改密码验证码';
  if (purpose === 'organization_invitation_reset') return 'Janus 组织邀请码重置验证码';
  if (purpose === 'email_verify') return 'Janus 邮箱验证验证码';
  return 'Janus 注册验证码';
}
