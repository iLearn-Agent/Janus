import { sha256Text } from '../../../utils.js';

export function withAttachmentContext(prompt, attachmentContext) {
  const context = String(attachmentContext || '').trim();
  if (!context) return prompt;
  const marker = '\nCurrent user message:\n';
  if (prompt.includes(marker)) {
    const [head, tail] = prompt.split(marker, 2);
    return `${head.trimEnd()}\n\n${context}\n${marker}${tail}`;
  }
  return `${prompt.trimEnd()}\n\n${context}\n`;
}

export function withWorkspaceBoundary(prompt, workspaceRoot = '') {
  const root = String(workspaceRoot || '').trim();
  if (!root) return prompt;
  return [
    'Project workspace:',
    `- The project root is: ${root}`,
    '- This project root is the working directory for project file reads, commands, edits, and generated files.',
    '- Treat the current working directory as the project root. Pass workspace-relative paths to file-edit tools and generated-file commands; do not prefix paths with the project root, a drive letter, $HOME, or another absolute location.',
    '- Keep helper scripts and temporary build files inside the project root. A path outside this root requires the explicit user-selected file or permission approval flow.',
    '- Discover and follow the applicable AGENTS.md files and closer nested guidance before changing files.',
    '- If the user names a path, use that path. Otherwise follow the project\'s existing structure and conventions instead of inventing a generic outputs/ directory.',
    '- Keep generated project files inside this root unless the user explicitly selects or approves another location.',
    '- If the user explicitly requests files outside the project root, access them only through the applicable user-selected file or permission approval flow.',
    '',
    String(prompt || ''),
  ].join('\n');
}

export function withInteractionMode(prompt, interactionMode = '') {
  const mode = normalizeInteractionMode(interactionMode);
  if (!mode) return prompt;
  const guidance = mode === 'goal'
    ? [
        'Active interaction mode: Goal',
        '- Treat the user request as a durable goal that should be advanced across turns, not as a one-off question.',
        '- Identify the concrete completion criteria, make meaningful progress in this turn, and verify completed work before claiming success.',
        '- Continue independently while safe in-scope work remains. Stop only when the goal is complete or a genuine blocker requires user input or external change.',
        '- In the final answer, report what was completed, verification performed, and any remaining work or blocker.',
      ]
    : [
        'Active interaction mode: Plan',
        '- Work read-only: inspect and analyze the project, but do not create, edit, delete, rename, or move files.',
        '- Do not run commands that mutate the project, install dependencies, change external state, deploy, publish, or send messages.',
        '- Before finalizing the plan, proactively call request_user_input whenever a product, design, scope, compatibility, data, or implementation choice would materially change the plan.',
        '- Ask 1-3 short questions with 2-3 mutually exclusive clickable options. Put the recommended option first and explain each tradeoff briefly.',
        '- Skip request_user_input only when there is no meaningful choice or the user has already decided it; then state reasonable assumptions and continue.',
        '- The answers refine the plan only. They do not authorize implementation or any write action.',
        '- When the user asks to revise a previous plan, use that plan as the baseline, preserve requirements and steps they did not reject, and produce a complete revised plan rather than only a diff.',
        '- A plan revision remains read-only and must be presented for confirmation again; never interpret revision feedback as permission to execute.',
        '- Produce an implementation-ready plan that names affected areas, risks, validation steps, and rollback considerations.',
        '- Do not begin implementation until plan mode has been exited.',
      ];
  return [...guidance, '', String(prompt || '')].join('\n');
}

export function normalizeInteractionMode(value = '') {
  const mode = String(value || '').trim();
  return ['goal', 'plan'].includes(mode) ? mode : '';
}

export function organizationFingerprint(organization = {}) {
  return sha256Text(JSON.stringify({
    departments: (organization.departments || []).map((item) => ({ id: item.id, name: item.name })),
    agents: (organization.agents || []).map((item) => ({
      id: item.id,
      departmentId: item.departmentId,
      lifecycleStatus: item.lifecycleStatus,
      routingState: item.routingState,
    })),
  }));
}

export function normalizeWorkspaceKey(value = '') {
  return String(value || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
