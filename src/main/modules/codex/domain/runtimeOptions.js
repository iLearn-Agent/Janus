export function codexPermissionProfile(mode = 'full-access') {
  if (mode === 'draft-stream') return { mode, sandbox: 'read-only', approvalPolicy: 'never', approvalsReviewer: 'user', appServer: true };
  if (mode === 'task-workspace') return { mode, sandbox: 'workspace-write', approvalPolicy: 'never', approvalsReviewer: 'user', appServer: false };
  if (mode === 'request-approval') return { mode, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'user', appServer: true };
  if (mode === 'auto-approve') return { mode, sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', appServer: true };
  return { mode: 'full-access', sandbox: 'danger-full-access', approvalPolicy: 'never', approvalsReviewer: 'user', appServer: false };
}

export function codexExecutionBackend(permission = null, platform = globalThis.process?.platform || '') {
  if (permission?.appServer) return 'app-server';
  if (platform === 'win32' && permission?.sandbox === 'workspace-write') return 'app-server';
  return 'exec';
}

export function codexAppServerArgs(helpText = '') {
  const args = ['app-server'];
  const help = String(helpText || '');
  if (/--listen(?:\s|\s*<)/.test(help)) args.push('--listen', 'stdio://');
  else if (/--stdio(?:\s|$)/m.test(help)) args.push('--stdio');
  return args;
}

export function codexCollaborationMode(interactionMode = '', { model = '', reasoningEffort = '' } = {}) {
  return {
    mode: interactionMode === 'plan' ? 'plan' : 'default',
    settings: {
      model: String(model || ''),
      reasoning_effort: String(reasoningEffort || '') || null,
      developer_instructions: null,
    },
  };
}
