import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArtifactMessage } from '../../../artifacts.js';
import { canonicalProjectWorkspace, normalizeWorkspaceKey } from '../../projects/index.js';

export function createFileRuntimeApi({ auth, store, runtimeRoot, upload, uploadFromPath, render, renderAsync = render, describe }) {
  const fileAccessOptions = (payload = {}, user = null) => {
    const messageId = String(payload.messageId || payload.message_id || '').trim();
    if (messageId) {
      const message = store.getMessage?.(messageId) || null;
      const messageSession = message?.sessionId ? store.getSession(message.sessionId) : null;
      if (!message || !messageSession || messageSession.userId !== user?.id) throw new Error('无权访问该历史消息的文件。');
      const messageProjectId = String(messageSession.projectId || messageSession.project_id || '').trim();
      const messageProject = messageProjectId ? store.getProject(messageProjectId) : null;
      if (messageProjectId && (!messageProject || messageProject.userId !== user.id)) throw new Error('无权访问该项目的文件。');
      const requestedWorkspace = String(messageProject?.workspaceRoot || messageProject?.workspace_root
        || messageSession.workspaceRoot || messageSession.workspace_root || '').trim();
      let workspaceRoot = '';
      if (requestedWorkspace) {
        try { workspaceRoot = canonicalProjectWorkspace(requestedWorkspace); } catch {}
      }
      const artifacts = Array.isArray(message.metadata?.outputArtifacts) ? message.metadata.outputArtifacts : [];
      const embeddedArtifact = parseArtifactMessage(message.content || '')?.data || null;
      const matchingArtifact = [...artifacts, ...storedArtifactFileDescriptors(embeddedArtifact)]
        .find((artifact) => sameStoredFileDescriptor(artifact, payload, workspaceRoot));
      if (!matchingArtifact) throw new Error('该文件不属于指定的历史消息。');
      if (workspaceRoot) return { allowedRoots: [workspaceRoot] };
      const requestedPath = existingDescriptorPath(payload, '');
      return requestedPath ? { allowedRoots: [path.dirname(requestedPath)] } : {};
    }
    const sessionId = String(payload.sessionId || payload.session_id || '').trim();
    const requestedProjectId = String(payload.projectId || payload.project_id || '').trim();
    const session = sessionId ? store.getSession(sessionId) : null;
    const activeWorkspaceId = store.activeAccountWorkspace?.({ userId: user?.id || '', deviceId: store.contextDeviceId?.() || 'local' })?.id || 'workspace_personal';
    if (sessionId && (!session || !auth.canAccessSession(user, session, activeWorkspaceId))) throw new Error('无权访问该会话的文件。');

    const sessionProjectId = String(session?.projectId || session?.project_id || '').trim();
    if (requestedProjectId && sessionProjectId && requestedProjectId !== sessionProjectId) {
      throw new Error('文件所属项目与当前会话不一致。');
    }
    const projectId = requestedProjectId || sessionProjectId;
    const project = projectId ? store.getProject(projectId) : null;
    if (projectId && (!project || project.userId !== user.id || project.workspaceId !== activeWorkspaceId)) {
      throw new Error('无权访问该项目的文件。');
    }

    const projectWorkspace = String(project?.workspaceRoot || project?.workspace_root || '').trim();
    const sessionWorkspace = String(session?.workspaceRoot || session?.workspace_root || '').trim();
    if (projectWorkspace && sessionWorkspace && normalizeWorkspaceKey(projectWorkspace) !== normalizeWorkspaceKey(sessionWorkspace)) {
      throw new Error('项目工作区与会话工作区不一致。');
    }

    const requestedWorkspace = projectWorkspace || sessionWorkspace;
    let workspaceRoot = '';
    if (requestedWorkspace) {
      try {
        workspaceRoot = canonicalProjectWorkspace(requestedWorkspace);
      } catch {
        // Keep runtime-managed uploads available even when a previously selected project is offline.
      }
    }
    return workspaceRoot ? { allowedRoots: [workspaceRoot] } : {};
  };

  return {
    uploadFile(payload = {}) {
      const user = auth.requireUser();
      return upload(runtimeRoot, payload, user.id);
    },
    uploadFileFromPath(payload = {}) {
      const user = auth.requireUser();
      return uploadFromPath(runtimeRoot, payload, user.id);
    },
    renderUploadedFile(payload = {}) {
      const user = auth.requireUser();
      return render(runtimeRoot, payload, fileAccessOptions(payload, user));
    },
    renderUploadedFileAsync(payload = {}) {
      const user = auth.requireUser();
      return renderAsync(runtimeRoot, payload, fileAccessOptions(payload, user));
    },
    describeFile(payload = {}) {
      const user = auth.requireUser();
      return describe(runtimeRoot, payload, user.id, fileAccessOptions(payload, user));
    },
  };
}

function storedArtifactFileDescriptors(value, output = []) {
  if (!value || typeof value !== 'object') return output;
  if (fileDescriptorCandidates(value).length) output.push(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (child && typeof child === 'object') storedArtifactFileDescriptors(child, output);
  }
  return output;
}

function sameStoredFileDescriptor(stored = {}, requested = {}, workspaceRoot = '') {
  const requestedCandidates = fileDescriptorCandidates(requested);
  const storedCandidates = fileDescriptorCandidates(stored);
  if (!requestedCandidates.length || !storedCandidates.length) return false;

  const requestedRelative = normalizedRelativeCandidates(requestedCandidates);
  const storedRelative = normalizedRelativeCandidates(storedCandidates);
  if (requestedRelative.some((candidate) => storedRelative.includes(candidate))) return true;

  for (const requestedCandidate of requestedCandidates) {
    const requestedPath = existingDescriptorPath({ path: requestedCandidate }, workspaceRoot);
    if (!requestedPath) continue;
    for (const storedCandidate of storedCandidates) {
      const storedPath = existingDescriptorPath({ path: storedCandidate }, workspaceRoot);
      if (storedPath && normalizeWorkspaceKey(storedPath) === normalizeWorkspaceKey(requestedPath)) return true;
    }
  }
  return false;
}

function fileDescriptorCandidates(value = {}) {
  return [
    value.path,
    value.workspace_relative_path,
    value.workspaceRelativePath,
    value.relative_path,
    value.relativePath,
  ].map((item) => String(item || '').trim()).filter(Boolean);
}

function normalizedRelativeCandidates(candidates = []) {
  return candidates
    .filter((candidate) => !descriptorPathIsAbsolute(candidate))
    .map((candidate) => normalizeWorkspaceKey(candidate).replace(/^\.\//, ''));
}

function existingDescriptorPath(value = {}, workspaceRoot = '') {
  for (let candidate of fileDescriptorCandidates(value)) {
    if (/^file:\/\//i.test(candidate)) {
      try { candidate = fileURLToPath(candidate); } catch { continue; }
    }
    const requested = descriptorPathIsAbsolute(candidate)
      ? path.resolve(candidate)
      : workspaceRoot ? path.resolve(workspaceRoot, candidate) : '';
    if (!requested) continue;
    try {
      const resolved = fs.realpathSync(requested);
      if (fs.statSync(resolved).isFile()) return resolved;
    } catch {}
  }
  return '';
}

function descriptorPathIsAbsolute(value = '') {
  return path.isAbsolute(value) || /^[a-z]:[\\/]/i.test(value) || /^\\\\/.test(value);
}
