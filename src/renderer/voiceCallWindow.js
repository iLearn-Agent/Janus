import { normalizeProfileAvatarUrl } from '../shared/profileAvatar.js';
import { COMPOSER_DEFAULT_EMOJIS } from '../shared/composerEmojis.js';

const params = new URLSearchParams(location.search);
const token = params.get('token') || '';
const janus = window.janus;
const $ = (selector) => document.querySelector(selector);

let payload = {};
let members = [];
let seconds = 0;
let timer = null;
let connected = false;
let incoming = false;
let localStream = null;
let cameraStream = null;
let cameraTrack = null;
let cameraSender = null;
let peerConnection = null;
let remoteAudio = null;
let pendingCandidates = [];
let signalUnsubscribe = null;
let ringtoneContext = null;
let ringtoneTimer = null;
let callTimeout = null;
let waitingTimer = null;
let waitingStartedAt = 0;
let connectionTimeout = null;
let language = 'zh-CN';
let reconnectTimer = null;
let reconnectAttempts = 0;
let callAccepted = false;
let dataChannel = null;
let sharedStream = null;
let sharedVideoTrack = null;
let screenSender = null;
let localVideoKind = '';
let recorder = null;
let recordingChunks = [];
const videoStreams = new Map();
let recordSubmitted = false;
let callStartedAt = '';
let answeredAt = '';
let makingOffer = false;
let ignoreOffer = false;
let isSettingRemoteAnswerPending = false;

async function flushPendingCandidates(connection = peerConnection) {
  if (!connection?.remoteDescription || !pendingCandidates.length) return;
  const candidates = pendingCandidates.splice(0);
  await Promise.all(candidates.map((candidate) => connection.addIceCandidate(candidate).catch(() => {})));
}

const COPY = {
  'zh-CN': { title: '语音通话', calling: '正在呼叫…', incoming: '来电', waiting: '等待你接听', waitingCaller: '等待对方接听', answer: '接通', mute: '静音', unmute: '取消静音', share: '共享屏幕', record: '录制', members: '成员', invite: '邀请', hangup: '挂断', chat: '输入消息…', connected: '通话中', connecting: '连接中…', connectionFailed: '连接超时，请重试', mic: '无法访问麦克风，请检查系统权限', ended: '通话已结束', minimize: '最小化', maximize: '最大化', close: '关闭', collapseChat: '收起弹幕', host: '我', member: '对方', unnamed: '未命名用户', emptyMembers: '暂无成员', rejected: '对方拒绝了通话', sharePending: '屏幕共享将在语音通话稳定后加入', recordPending: '录音功能将在语音通话稳定后加入', oneToOne: '当前为一对一通话', invitePending: '多人邀请将在语音通话稳定后加入' },
  en: { title: 'Voice Call', calling: 'Calling…', incoming: 'Incoming call', waiting: 'Waiting for you to answer', waitingCaller: 'Waiting for the other person to answer', answer: 'Answer', mute: 'Mute', unmute: 'Unmute', share: 'Share screen', record: 'Record', members: 'Members', invite: 'Invite', hangup: 'Hang up', chat: 'Type a message…', connected: 'Connected', connecting: 'Connecting…', connectionFailed: 'Connection timed out. Try again.', mic: 'Microphone unavailable. Check system permissions.', ended: 'Call ended', minimize: 'Minimize', maximize: 'Maximize', close: 'Close', collapseChat: 'Collapse chat', host: 'Me', member: 'Other participant', unnamed: 'Unnamed user', emptyMembers: 'No participants', rejected: 'The other person declined the call', sharePending: 'Screen sharing will be available when voice calls are stable', recordPending: 'Recording will be available when voice calls are stable', oneToOne: 'This is a one-to-one call', invitePending: 'Multi-party invites will be available when voice calls are stable' },
};
const text = (key) => COPY[language]?.[key] || COPY['zh-CN'][key] || key;
Object.assign(COPY['zh-CN'], { shared: '正在共享屏幕', returnCall: '返回通话', stopShare: '结束共享', emoji: '表情', send: '发送', memberTitle: '参会成员', searchMembers: '搜索成员', inviteTitle: '邀请联系人', renameTitle: '修改会中昵称', renamePlaceholder: '请输入会中昵称', cancel: '取消', save: '保存' });
Object.assign(COPY.en, { shared: 'Sharing screen', returnCall: 'Return to call', stopShare: 'Stop sharing', emoji: 'Emoji', send: 'Send', memberTitle: 'Participants', searchMembers: 'Search participants', inviteTitle: 'Invite contacts', renameTitle: 'Change call nickname', renamePlaceholder: 'Enter a call nickname', cancel: 'Cancel', save: 'Save' });
Object.assign(COPY['zh-CN'], { camera: '摄像头', cameraOff: '关闭摄像头', cameraDenied: '无法访问摄像头，请检查系统权限' });
Object.assign(COPY.en, { camera: 'Camera', cameraOff: 'Turn camera off', cameraDenied: 'Camera unavailable. Check system permissions.' });
Object.assign(COPY['zh-CN'], { speaker: '扬声器', speakerOff: '关闭扬声器' });
Object.assign(COPY.en, { speaker: 'Speaker', speakerOff: 'Mute speaker' });
Object.assign(COPY['zh-CN'], { chatSent: '消息已发送', chatUnavailable: '聊天通道尚未连接', shareStarted: '已开始共享屏幕', shareStopped: '已停止共享屏幕', shareDenied: '屏幕共享已取消或被系统拒绝', recording: '录音中', recordStarted: '已开始录音', recordStopped: '录音已保存' });
Object.assign(COPY.en, { chatSent: 'Message sent', chatUnavailable: 'Chat channel is not connected', shareStarted: 'Screen sharing started', shareStopped: 'Screen sharing stopped', shareDenied: 'Screen sharing was cancelled or denied', recording: 'Recording', recordStarted: 'Recording started', recordStopped: 'Recording saved' });

function localizeWindow() {
  document.documentElement.lang = language;
  document.title = text('title');
  $('#call-status').textContent = incoming ? text('incoming') : text('calling');
  $('#incoming-actions span').textContent = incoming ? text('waiting') : text('waitingCaller');
  $('#accept').textContent = text('answer');
  $('#mute span').textContent = text('mute');
  $('#speaker span').textContent = text('speaker');
  $('#share span').textContent = text('share');
  $('#record span').textContent = text('record');
  $('#members span').textContent = text('members');
  $('#invite span').textContent = text('invite');
  $('#hangup span').textContent = text('hangup');
  $('#chat-input').placeholder = text('chat');
  $('#minimize').setAttribute('aria-label', text('minimize'));
  $('#maximize').setAttribute('aria-label', text('maximize'));
  $('#close').setAttribute('aria-label', text('close'));
  $('#chat-toggle').setAttribute('aria-label', text('collapseChat'));
  $('#share-strip span').textContent = text('shared'); $('#return-call').textContent = text('returnCall'); $('#stop-share').textContent = text('stopShare');
  $('#emoji').setAttribute('title', text('emoji')); $('#send').textContent = text('send');
  $('#members-dialog > header > strong').textContent = text('memberTitle'); $('#member-search').placeholder = text('searchMembers');
  $('#invite-dialog > header > strong').textContent = text('inviteTitle'); $('#rename-dialog header > strong').textContent = text('renameTitle');
  $('#rename-input').placeholder = text('renamePlaceholder'); $('#rename-dialog footer button[value="cancel"]').textContent = text('cancel'); $('#rename-submit').textContent = text('save');
}

function startRingtone() {
  if (ringtoneTimer) return;
  try {
    ringtoneContext = new AudioContext();
    const beep = () => {
      if (!ringtoneContext) return;
      const oscillator = ringtoneContext.createOscillator();
      const gain = ringtoneContext.createGain();
      oscillator.type = 'triangle'; oscillator.frequency.value = incoming ? 740 : 520;
      gain.gain.setValueAtTime(0.0001, ringtoneContext.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, ringtoneContext.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ringtoneContext.currentTime + 0.32);
      oscillator.connect(gain).connect(ringtoneContext.destination);
      oscillator.start(); oscillator.stop(ringtoneContext.currentTime + 0.34);
    };
    beep(); ringtoneTimer = setInterval(beep, incoming ? 950 : 1250);
  } catch { ringtoneContext = null; }
}
document.addEventListener('pointerdown', () => { void ringtoneContext?.resume?.().catch?.(() => {}); }, { passive: true });
function stopRingtone() {
  if (ringtoneTimer) clearInterval(ringtoneTimer);
  ringtoneTimer = null;
  void ringtoneContext?.close?.().catch?.(() => {});
  ringtoneContext = null;
}

function formatCallSeconds(value = 0) {
  const secondsValue = Math.max(0, Number(value) || 0);
  return `${String(Math.floor(secondsValue / 60)).padStart(2, '0')}:${String(secondsValue % 60).padStart(2, '0')}`;
}
function serializableDescription(description) {
  if (!description) return null;
  const json = description.toJSON?.();
  return {
    type: String(json?.type || description.type || ''),
    sdp: String(json?.sdp || description.sdp || ''),
  };
}
function updateWaitingStatus() {
  if (connected || !waitingStartedAt) return;
  const elapsed = formatCallSeconds(Math.floor((Date.now() - waitingStartedAt) / 1000));
  const node = incoming ? $('#incoming-actions span') : $('#duration');
  if (node) node.textContent = incoming ? `${text('waiting')} · ${elapsed}` : elapsed;
}
function startWaitingTimer() {
  if (!waitingStartedAt) waitingStartedAt = Date.now();
  updateWaitingStatus();
  if (!waitingTimer) waitingTimer = setInterval(updateWaitingStatus, 1000);
}
function stopWaitingTimer() {
  if (waitingTimer) clearInterval(waitingTimer);
  waitingTimer = null;
}
function isCallerRole() {
  const currentId = String(payload.currentUser?.id || '').trim();
  const callerId = String(payload.callerId || '').trim();
  return callerId ? currentId === callerId : !Boolean(payload.incoming);
}
function stopConnectionTimeout() {
  if (connectionTimeout) clearTimeout(connectionTimeout);
  connectionTimeout = null;
}

async function recordCall(status = 'ended') {
  if (recordSubmitted || !payload.callId || String(payload.currentUser?.id || '') !== String(payload.callerId || '')) return;
  recordSubmitted = true;
  try {
    await janus.recordVoiceCall?.({
      callId: payload.callId, peerId: payload.peerId, callerId: payload.callerId,
      workspaceId: payload.workspaceId || payload.accountWorkspaceId,
      status, durationSeconds: connected ? seconds : 0,
      startedAt: callStartedAt || new Date().toISOString(), answeredAt,
      endedAt: new Date().toISOString(),
    });
  } catch (error) { console.warn('voice-call record failed', error); }
}

function scheduleReconnect() {
  if (reconnectTimer || !peerConnection) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (!peerConnection || ['closed', 'connected'].includes(peerConnection.connectionState)) return;
    reconnectAttempts += 1;
    try {
      if (peerConnection.connectionState === 'disconnected' && peerConnection.restartIce) {
        peerConnection.restartIce();
      } else {
        peerConnection.close();
        peerConnection = null;
        await setupPeerConnection();
        if (!incoming) await createOffer();
      }
    } catch (error) {
      console.warn('voice-call reconnect failed', error);
      if (reconnectAttempts < 5) scheduleReconnect();
    }
  }, Math.min(10_000, 1_000 * Math.max(1, reconnectAttempts)));
}

const unwrap = (value) => value?.user || value?.profile || value?.friend || value || {};
const displayName = (value) => {
  const user = unwrap(value);
  return String(user.remark || user.displayName || user.display_name || user.nickname || user.name
    || user.fullName || user.full_name || user.username || user.email || user.callerName || payload.callerName || user.id || text('unnamed'));
};
const avatar = (value) => {
  const user = unwrap(value);
  const src = normalizeProfileAvatarUrl(user.avatarUrl || user.avatar_url || user.avatar || user.photoUrl || user.photo_url || '');
  const label = displayName(user).slice(0, 2);
  return src ? `<img src="${src.replace(/"/g, '&quot;')}" alt="">` : `<span>${label}</span>`;
};

function renderStage() {
  const shown = members.slice(0, 10);
  const cols = shown.length <= 1 ? 1 : shown.length <= 2 ? 2 : shown.length <= 4 ? 2 : 5;
  $('#stage').style.setProperty('--cols', cols);
  $('#stage').innerHTML = shown.map((member) => {
    const userId = String(member.user?.id || '');
    const stream = videoStreams.get(userId);
    const isLocal = userId === String(payload.currentUser?.id || '');
    const mirror = isLocal && localVideoKind === 'camera' ? 'is-mirrored' : '';
    const video = stream ? `<video class="tile-video ${isLocal ? 'is-local' : ''} ${mirror}" data-video-user="${userId.replace(/"/g, '&quot;')}" autoplay playsinline ${isLocal ? 'muted' : ''}></video>` : '';
    return `<article class="tile ${member.speaking ? 'speaking' : ''} ${connected ? '' : 'waiting'} ${stream ? 'has-video' : ''}">
    ${video}<div class="tile-avatar">${avatar(member.user)}${member.muted ? '<span class="muted">×</span>' : ''}</div>
    <strong>${displayName(member.user)}${String(member.user.id || '') === String(payload.currentUser?.id || '') ? '（我）' : ''}</strong>
    <small>（${member.role === 'host' ? text('host') : text('member')}）</small>
  </article>`;
  }).join('') || `<p class="empty">${text('emptyMembers')}</p>`;
  $('#stage').querySelectorAll('[data-video-user]').forEach((video) => {
    const stream = videoStreams.get(video.dataset.videoUser || '');
    if (stream) { video.srcObject = stream; void video.play?.().catch?.(() => {}); }
  });
}

function startTimer() {
  if (timer) return;
  timer = setInterval(() => {
    seconds += 1;
    $('#duration').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  }, 1000);
}

function setConnected() {
  if (connected) return;
  connected = true;
  answeredAt = answeredAt || new Date().toISOString();
  reconnectAttempts = 0;
  stopRingtone();
  stopWaitingTimer();
  stopConnectionTimeout();
  if (callTimeout) clearTimeout(callTimeout);
  $('#call-status').textContent = text('connected');
  $('#incoming-actions').style.display = 'none';
  renderStage();
  startTimer();
  void sendSignal('state', { state: 'connected' });
  toast(text('connected'));
}

function appendChatMessage(message, mine = false) {
  const log = $('#chat-log'); if (!log) return;
  const item = document.createElement('p'); item.className = `chat-barrage ${mine ? 'mine' : ''}`;
  item.textContent = `${mine ? displayName(payload.currentUser) : displayName(payload.peer)}: ${String(message || '')}`;
  log.appendChild(item); while (log.children.length > 30) log.firstElementChild.remove();
  requestAnimationFrame(() => { log.scrollTop = log.scrollHeight; });
}

function setupDataChannel(channel) {
  if (!channel) return;
  dataChannel = channel;
  channel.onopen = () => { toast(text('chatSent')); };
  channel.onmessage = (event) => {
    try { const data = JSON.parse(String(event.data || '{}')); if (data.kind === 'chat' && data.text) appendChatMessage(data.text, false); } catch {}
  };
  channel.onclose = () => { if (dataChannel === channel) dataChannel = null; };
}

function sendChatMessage() {
  const input = $('#chat-input'); const value = String(input?.value || '').trim(); if (!value) return;
  if (!dataChannel || dataChannel.readyState !== 'open') { toast(text('chatUnavailable')); return; }
  dataChannel.send(JSON.stringify({ kind: 'chat', text: value, sentAt: new Date().toISOString() }));
  appendChatMessage(value, true); input.value = ''; input.focus();
}

async function toggleScreenShare() {
  if (!peerConnection) return;
  if (sharedStream) { await stopScreenShare(); return; }
  try {
    const source = await chooseDesktopSource();
    if (!source) return;
    sharedStream = source.fallback || await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id, maxFrameRate: 15 } } });
    sharedVideoTrack = sharedStream.getVideoTracks()[0];
    if (cameraSender?.replaceTrack) { await cameraSender.replaceTrack(sharedVideoTrack); screenSender = cameraSender; }
    else screenSender = peerConnection.addTrack(sharedVideoTrack, sharedStream);
    sharedVideoTrack.onended = () => { void stopScreenShare(); };
    videoStreams.set(String(payload.currentUser?.id || ''), sharedStream);
    localVideoKind = 'screen';
    const cameraButton = $('#camera'); if (cameraButton) cameraButton.disabled = true;
    renderStage();
    await janus.setVoiceCallSharingMode?.(token, true);
    await createOffer(); $('#share').classList.add('active'); $('#share span').textContent = text('stopShare');
    toast(text('shareStarted'));
  } catch { sharedStream = null; sharedVideoTrack = null; toast(text('shareDenied')); }
}
async function stopScreenShare() {
  if (!sharedStream) return;
  sharedStream.getTracks().forEach((track) => track.stop());
  if (screenSender && peerConnection) {
    if (screenSender === cameraSender && cameraTrack && cameraSender?.replaceTrack) await cameraSender.replaceTrack(cameraTrack).catch(() => {});
    else peerConnection.removeTrack(screenSender);
  }
  sharedStream = null; sharedVideoTrack = null; screenSender = null;
  if (cameraStream && cameraTrack) {
    videoStreams.set(String(payload.currentUser?.id || ''), cameraStream);
    localVideoKind = 'camera';
  } else {
    videoStreams.delete(String(payload.currentUser?.id || ''));
    localVideoKind = '';
  }
  const cameraButton = $('#camera'); if (cameraButton) cameraButton.disabled = false;
  renderStage();
  void janus.setVoiceCallSharingMode?.(token, false);
  void createOffer().catch(() => {}); $('#share').classList.remove('active'); $('#share span').textContent = text('share'); toast(text('shareStopped'));
}

async function chooseDesktopSource() {
  let sources = [];
  try { sources = await janus.listVoiceCallDesktopSources?.(token) || []; } catch (error) { console.warn('desktop source enumeration failed', error); }
  if (!sources.length) {
    try { return { id: '', fallback: await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false }) }; } catch { toast(text('shareDenied')); return null; }
  }
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'source-picker';
    dialog.innerHTML = `<header><strong>${text('share')}</strong><button type="button" data-source-cancel aria-label="${text('close')}">×</button></header><div class="source-grid">${sources.map((source) => `<button type="button" data-source-id="${String(source.id || '').replace(/"/g, '&quot;')}"><img src="${String(source.thumbnail || '').replace(/"/g, '&quot;')}" alt=""><b>${String(source.name || text('share')).replace(/[&<>\"]/g, (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[value]))}</b></button>`).join('')}</div>`;
    document.body.appendChild(dialog);
    const finish = (value) => { dialog.close?.(); dialog.remove(); resolve(value); };
    dialog.querySelector('[data-source-cancel]')?.addEventListener('click', () => finish(null));
    dialog.querySelectorAll('[data-source-id]').forEach((button) => button.addEventListener('click', () => finish({ id: button.dataset.sourceId || '' })));
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(null); }, { once: true });
    dialog.showModal?.();
  });
}

function toggleRecording() {
  if (recorder?.state === 'recording') { recorder.stop(); return; }
  const tracks = [...(localStream?.getAudioTracks?.() || []), ...(remoteAudio?.srcObject?.getAudioTracks?.() || [])];
  if (!tracks.length || typeof MediaRecorder === 'undefined') { toast(text('recordPending')); return; }
  try {
    recordingChunks = []; recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: 'audio/webm' });
    recorder.ondataavailable = (event) => { if (event.data.size) recordingChunks.push(event.data); };
    recorder.onstop = () => { const url = URL.createObjectURL(new Blob(recordingChunks, { type: 'audio/webm' })); const a = document.createElement('a'); a.href = url; a.download = `janus-call-${new Date().toISOString().replace(/[:.]/g, '-')}.webm`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); recorder = null; $('#record').classList.remove('active'); $('#record span').textContent = text('record'); toast(text('recordStopped')); };
    recorder.start(); $('#record').classList.add('active'); $('#record span').textContent = text('recording'); toast(text('recordStarted'));
  } catch { recorder = null; toast(text('recordPending')); }
}

function showMembers() {
  const list = $('#member-list'); if (list) list.innerHTML = members.map((member) => `<div class="member-row"><div class="member-avatar">${avatar(member.user)}</div><span>${displayName(member.user)}</span></div>`).join('');
  $('#members-dialog')?.showModal?.();
}

function showInviteDialog() {
  const list = $('#invite-list');
  const candidates = (Array.isArray(payload.friends) ? payload.friends : []).filter((user) => String(user?.id || '') !== String(payload.currentUser?.id || '') && String(user?.id || '') !== String(payload.peerId || ''));
  if (!list) return;
  list.innerHTML = candidates.length ? candidates.map((user) => `<button class="invite-row" type="button" data-invite-user="${String(user.id || '').replace(/"/g, '&quot;')}"><span>${displayName(user)}</span><b>${text('invite')}</b></button>`).join('') : `<p class="empty">${text('emptyMembers')}</p>`;
  $('#invite-dialog')?.showModal?.();
  list.querySelectorAll('[data-invite-user]').forEach((button) => button.addEventListener('click', async () => {
    const recipientId = String(button.dataset.inviteUser || '').trim(); if (!recipientId) return;
    await sendSignal('invite', { recipientId }); $('#invite-dialog')?.close(); toast(text('invitePending'));
  }));
}

function ensureCameraButton() {
  if ($('#camera')) return $('#camera');
  const button = document.createElement('button'); button.id = 'camera'; button.type = 'button'; button.innerHTML = '<i>◉</i><span></span>'; button.title = text('camera'); button.className = 'camera-control';
  document.querySelector('.toolbar')?.insertBefore(button, $('#share')); $('#camera span').textContent = text('camera');
  button.onclick = toggleCamera; return button;
}

async function toggleCamera() {
  if (!peerConnection) return;
  if (!cameraTrack && sharedStream) return;
  if (cameraTrack) {
    cameraTrack.stop(); if (cameraSender) peerConnection.removeTrack(cameraSender);
    cameraTrack = null; cameraSender = null; cameraStream = null; localVideoKind = '';
    videoStreams.delete(String(payload.currentUser?.id || ''));
    renderStage();
    $('#camera span').textContent = text('camera'); $('#camera').classList.remove('active');
    await createOffer().catch(() => {}); return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false });
    cameraTrack = cameraStream.getVideoTracks()[0]; cameraSender = peerConnection.addTrack(cameraTrack, cameraStream); localVideoKind = 'camera';
    videoStreams.set(String(payload.currentUser?.id || ''), cameraStream);
    renderStage();
    cameraTrack.onended = () => { if (cameraTrack) void toggleCamera(); };
    $('#camera span').textContent = text('cameraOff'); $('#camera').classList.add('active');
    await createOffer();
  } catch { cameraStream = null; cameraTrack = null; toast(text('cameraDenied')); }
}

function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  setTimeout(() => node.classList.remove('show'), 1800);
}

async function chooseOutputDevice() {
  if (!remoteAudio) { toast(text('speaker')); return; }
  try {
    let device = null;
    if (typeof navigator.mediaDevices?.selectAudioOutput === 'function') {
      device = await navigator.mediaDevices.selectAudioOutput();
    } else {
      const devices = (await navigator.mediaDevices?.enumerateDevices?.() || []).filter((item) => item.kind === 'audiooutput');
      device = devices.find((item) => item.deviceId && item.deviceId !== 'default') || devices[0] || null;
    }
    if (!device?.deviceId || typeof remoteAudio.setSinkId !== 'function') {
      toast(text('speaker')); return;
    }
    await remoteAudio.setSinkId(device.deviceId);
    $('#speaker').classList.add('active');
    $('#speaker').title = device.label || text('speaker');
    toast(device.label || text('speaker'));
  } catch (error) {
    if (error?.name !== 'NotAllowedError' && error?.name !== 'AbortError') console.warn('voice-call output device failed', error);
  }
}

async function sendSignal(type, extra = {}) {
  const recipientId = String(extra.recipientId || payload.peerId || unwrap(payload.peer).id || '').trim();
  const callId = String(payload.callId || '').trim();
  if (!recipientId || !callId) return;
  try {
    const workspaceId = String(payload.workspaceId || payload.accountWorkspaceId || 'workspace_personal').trim() || 'workspace_personal';
    await janus.sendVoiceCallSignal({ recipientId, callId, type, workspaceId, accountWorkspaceId: workspaceId, ...extra });
  } catch (error) {
    console.warn('voice-call signal failed', error);
    toast('通话信令发送失败');
  }
}

async function setupPeerConnection() {
  if (peerConnection) return peerConnection;
  const configured = await janus.voiceCallIceServers?.().catch(() => []) || [];
  const iceServers = configured.length ? configured : [{ urls: 'stun:stun.l.google.com:19302' }];
  peerConnection = new RTCPeerConnection({ iceServers });
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) void sendSignal('ice-candidate', { candidate: event.candidate.toJSON?.() || event.candidate });
  };
  peerConnection.ontrack = (event) => {
    if (event.track.kind === 'video') {
      const stream = event.streams[0] || new MediaStream([event.track]);
      const peerId = String(payload.peerId || unwrap(payload.peer).id || '');
      videoStreams.set(peerId, stream);
      event.track.addEventListener('ended', () => {
        if (videoStreams.get(peerId) === stream) {
          videoStreams.delete(peerId);
          renderStage();
        }
      }, { once: true });
      renderStage();
      return;
    }
    if (!remoteAudio) {
      remoteAudio = document.createElement('audio');
      remoteAudio.autoplay = true;
      remoteAudio.playsInline = true;
      remoteAudio.style.display = 'none';
      document.body.appendChild(remoteAudio);
    }
    remoteAudio.srcObject = event.streams[0] || new MediaStream([event.track]);
    void remoteAudio.play().catch(() => {});
  };
  peerConnection.ondatachannel = (event) => setupDataChannel(event.channel);
  peerConnection.onconnectionstatechange = () => {
    const state = peerConnection?.connectionState;
    if (state === 'connected') setConnected();
    if (['failed', 'disconnected'].includes(state)) { toast('网络连接中断，正在重连…'); scheduleReconnect(); }
  };
  peerConnection.oniceconnectionstatechange = () => {
    const iceState = peerConnection?.iceConnectionState;
    if (iceState === 'failed') {
      toast('无法建立网络连接，正在重连…');
      if (peerConnection?.restartIce) peerConnection.restartIce();
      scheduleReconnect();
    }
  };
  peerConnection.onnegotiationneeded = async () => {
    if (!callAccepted || makingOffer || peerConnection?.signalingState !== 'stable') return;
    try {
      makingOffer = true;
      await createOffer();
    } catch (error) { console.warn('voice-call renegotiation failed', error); }
    finally { makingOffer = false; }
  };
  if (localStream) localStream.getTracks().forEach((track) => peerConnection.addTrack(track, localStream));
  if (!incoming && !dataChannel) setupDataChannel(peerConnection.createDataChannel('voice-chat', { ordered: true }));
  await flushPendingCandidates(peerConnection);
  return peerConnection;
}

async function createOffer() {
  const connection = await setupPeerConnection();
  const offer = await connection.createOffer();
  await connection.setLocalDescription(offer);
  await sendSignal('offer', { sdp: serializableDescription(connection.localDescription) });
}

async function handleSignal(signal) {
  if (!signal) return;
  if (String(signal.senderId || '') === String(payload.currentUser?.id || '')) return;
  if (signal.type === 'invite' && !incoming) {
    incoming = true;
    payload.callId = String(signal.callId || payload.callId || '');
    payload.peerId = String(signal.senderId || payload.peerId || '');
    payload.peer = signal.senderProfile || signal.callerProfile || payload.peer || { id: signal.senderId, displayName: signal.callerName || signal.senderId };
    $('#call-title').textContent = displayName(payload.peer);
    $('#call-status').textContent = text('incoming');
    $('#incoming-actions').style.display = '';
    startWaitingTimer();
    renderStage();
    stopRingtone();
    startRingtone();
    return;
  }
  if (String(signal.callId || '') !== String(payload.callId || '')) return;
  if (signal.type === 'mute') {
    const peer = members.find((member) => String(member.user?.id || '') === String(payload.peerId || ''));
    if (peer) { peer.muted = Boolean(signal.muted); renderStage(); }
    return;
  }
  if (signal.type === 'state') {
    if (signal.state === 'connected') setConnected();
    else if (signal.state === 'connecting') $('#call-status').textContent = text('connecting');
    return;
  }
  if (signal.type === 'accept' && isCallerRole()) {
    callAccepted = true;
    if (callTimeout) clearTimeout(callTimeout);
    callTimeout = null;
    $('#call-status').textContent = text('connecting');
    return createOffer();
  }
  if (signal.type === 'reject' || signal.type === 'cancel' || signal.type === 'hangup') {
    void recordCall(signal.type === 'reject' ? (signal.reason === 'timeout' ? 'missed' : 'rejected') : (signal.type === 'cancel' ? 'cancelled' : (connected ? 'ended' : 'missed')));
    toast(signal.type === 'reject' ? text('rejected') : text('ended'));
    setTimeout(() => window.close(), 250);
    return;
  }
  if (signal.type === 'offer') {
    const connection = await setupPeerConnection();
    const offerCollision = makingOffer || connection.signalingState !== 'stable' || isSettingRemoteAnswerPending;
    ignoreOffer = !isCallerRole() ? false : offerCollision;
    if (ignoreOffer) return;
    if (offerCollision && !isCallerRole()) {
      await connection.setLocalDescription({ type: 'rollback' });
    }
    await connection.setRemoteDescription(signal.sdp);
    await flushPendingCandidates(connection);
    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    await sendSignal('answer', { sdp: serializableDescription(connection.localDescription) });
    return;
  }
  if (signal.type === 'answer' && isCallerRole() && peerConnection) {
    isSettingRemoteAnswerPending = true;
    try { await peerConnection.setRemoteDescription(signal.sdp); }
    finally { isSettingRemoteAnswerPending = false; }
    await flushPendingCandidates(peerConnection);
    return;
  }
  if (signal.type === 'ice-candidate' && signal.candidate) {
    const candidate = new RTCIceCandidate(signal.candidate);
    if (!peerConnection || !peerConnection.remoteDescription) pendingCandidates.push(candidate);
    else if (!ignoreOffer) await peerConnection.addIceCandidate(candidate).catch(() => {});
  }
}

async function acceptCall() {
  if (!incoming) return;
  $('#accept').disabled = true;
  stopRingtone();
  callAccepted = true;
  if (callTimeout) clearTimeout(callTimeout);
  callTimeout = null;
  try {
    await sendSignal('accept');
    await sendSignal('state', { state: 'connecting' });
    $('#call-status').textContent = text('connecting');
    await setupPeerConnection();
    stopConnectionTimeout();
    connectionTimeout = setTimeout(() => {
      if (!connected) { $('#call-status').textContent = text('connectionFailed'); toast(text('connectionFailed')); }
    }, 12_000);
  } catch {
    $('#accept').disabled = false;
    toast(text('ended'));
  }
}

async function timeoutUnansweredCall() {
  if (connected || callAccepted) return;
  await recordCall('missed');
  await sendSignal(incoming ? 'reject' : 'cancel', { reason: 'timeout' });
  stopRingtone();
  stopWaitingTimer();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  localStream?.getTracks?.().forEach((track) => track.stop());
  peerConnection?.close();
  janus.closeAuxiliaryWindow?.(token, true);
  window.close();
}

async function init() {
  payload = await janus.auxiliaryWindowPayload?.(token) || {};
  incoming = Boolean(payload.incoming);
  callAccepted = Boolean(payload.callAccepted);
  callStartedAt = String(payload.callStartedAt || payload.createdAt || new Date().toISOString());
  language = payload.language === 'en' ? 'en' : 'zh-CN';
  document.body.dataset.theme = payload.theme === 'dark' ? 'dark' : 'light';
  const liveUser = typeof janus.currentUser === 'function' ? await janus.currentUser().catch(() => null) : null;
  payload.currentUser = { ...(liveUser || {}), ...(payload.currentUser || {}) };
  const self = payload.currentUser || {};
  const peer = unwrap(payload.peer || {});
  members = [{ user: self, role: 'host', muted: false, speaking: true }, { user: peer, role: 'member', muted: false }];
  $('#call-title').textContent = displayName(peer);
  localizeWindow();
  ensureCameraButton();
  $('#camera span').textContent = text('camera'); $('#camera').title = text('camera');
  $('#incoming-actions').style.display = incoming && !callAccepted ? '' : 'none';
  startWaitingTimer();
  renderStage();
  $('#emoji-picker').innerHTML = COMPOSER_DEFAULT_EMOJIS.map((emoji) => `<button type="button" data-emoji="${emoji}">${emoji}</button>`).join('');
  signalUnsubscribe = janus.onVoiceCallSignal?.((signal) => { void handleSignal(signal); });
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    await setupPeerConnection();
    if (callAccepted && isCallerRole()) await createOffer();
  } catch {
    toast(text('mic'));
  }
  if (!callAccepted) startRingtone();
  connectionTimeout = null;
  // Both caller and callee need a bounded ringing window. Without this the
  // caller can remain in "Calling" forever when the peer is offline.
  callTimeout = setTimeout(() => { void timeoutUnansweredCall(); }, 30_000);
}

$('#accept').onclick = acceptCall;
$('#hangup').onclick = async () => {
  const finalStatus = connected ? 'ended' : (incoming ? 'rejected' : 'cancelled');
  await recordCall(finalStatus);
  await sendSignal(connected ? 'hangup' : (incoming ? 'reject' : 'cancel'));
  clearInterval(timer);
  stopWaitingTimer();
  stopConnectionTimeout();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (callTimeout) clearTimeout(callTimeout);
  stopRingtone();
  await stopScreenShare();
  cameraStream?.getTracks().forEach((track) => track.stop());
  if (recorder?.state === 'recording') recorder.stop();
  signalUnsubscribe?.();
  localStream?.getTracks().forEach((track) => track.stop());
  peerConnection?.close();
  remoteAudio?.remove();
  janus.closeAuxiliaryWindow?.(token, true);
  window.close();
};
$('#close').onclick = () => $('#hangup').click();
$('#minimize').onclick = () => janus.minimizeAuxiliaryWindow?.(token);
$('#maximize').onclick = () => janus.toggleMaximizeAuxiliaryWindow?.(token);
$('#mute').onclick = () => {
  const shouldMute = Boolean(localStream?.getAudioTracks().some((track) => track.enabled));
  localStream?.getAudioTracks().forEach((track) => { track.enabled = !shouldMute; });
  members[0].muted = shouldMute;
  void sendSignal('mute', { muted: shouldMute });
  $('#mute').classList.toggle('active', shouldMute);
  $('#mute span').textContent = shouldMute ? text('unmute') : text('mute');
  renderStage();
};

$('#speaker').onclick = () => {
  const button = $('#speaker');
  const audio = remoteAudio;
  if (!audio) { toast(text('speaker')); return; }
  audio.muted = !audio.muted;
  button.classList.toggle('active', audio.muted);
  button.querySelector('span').textContent = audio.muted ? text('speakerOff') : text('speaker');
};
$('#speaker').ondblclick = () => { void chooseOutputDevice(); };

$('#emoji')?.addEventListener('click', () => { $('#emoji-picker').classList.toggle('show'); $('#chat-input').focus(); });
$('#emoji-picker').onclick = (event) => {
  const button = event.target.closest('[data-emoji]');
  if (button) { $('#chat-input').value += button.dataset.emoji; $('#chat-input').focus(); $('#emoji-picker').classList.remove('show'); }
};
$('#send').onclick = sendChatMessage;
$('#chat-input').onkeydown = (event) => { if (event.key === 'Enter') { event.preventDefault(); sendChatMessage(); } };
$('#share').onclick = toggleScreenShare;
$('#stop-share').onclick = () => { void stopScreenShare(); };
$('#return-call').onclick = () => { void janus.setVoiceCallSharingMode?.(token, false); };
$('#record').onclick = toggleRecording;
$('#members').onclick = showMembers;
$('#invite').onclick = showInviteDialog;
$('#close-members')?.addEventListener('click', () => $('#members-dialog')?.close());
$('#close-invite')?.addEventListener('click', () => $('#invite-dialog')?.close());
$('#chat-toggle')?.addEventListener('click', () => $('#chat-panel')?.classList.toggle('collapsed'));

void init();
