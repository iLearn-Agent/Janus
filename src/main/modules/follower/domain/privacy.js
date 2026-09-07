const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/gi,
];

export function redactFollowerSecrets(value = '') {
  let text = String(value || '');
  let redactionCount = 0;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, () => { redactionCount += 1; return '[Sensitive information omitted]'; });
  }
  text = text.replace(/(?:[A-Za-z]:)?[\\/](?:[^\s:]+[\\/])+[^\s:]+/g, () => {
    redactionCount += 1;
    return '[Local path hidden]';
  });
  return { text, redactionCount };
}
