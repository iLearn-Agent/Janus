const params = new URLSearchParams(location.search);
const token = params.get('token') || '';
const $ = (selector) => document.querySelector(selector);

let payload = {};
let ws;
let sessionId;
let publisher;
let localStream;
let sequence = 0;
const subscribers = new Map();
const pending = new Map();
let keepaliveTimer = null;
let language = 'zh-CN';
let callStartedAt = '';
let eventUnsubscribe = null;
let screenStream = null;
let screenSender = null;
let recorder = null;
let recordingChunks = [];
const COPY = {
  'zh-CN': { title: '多人通话', joining: '正在加入房间…', failed: '连接失败', closed: '已断开', negotiation: '媒体协商失败', config: '多人通话配置获取失败', participant: '参与者', me: '我', mute: '静音', unmute: '取消静音', camera: '摄像头', cameraOff: '打开摄像头', share: '共享屏幕', stopShare: '结束共享', invite: '邀请成员', record: '录音', recording: '录音中', hangup: '挂断', close: '关闭' },
  en: { title: 'Group call', joining: 'Joining room…', failed: 'Connection failed', closed: 'Disconnected', negotiation: 'Media negotiation failed', config: 'Could not load group call configuration', participant: 'Participant', me: 'Me', mute: 'Mute', unmute: 'Unmute', camera: 'Camera', cameraOff: 'Turn camera on', share: 'Share screen', stopShare: 'Stop sharing', invite: 'Invite', record: 'Record', recording: 'Recording', hangup: 'Hang up', close: 'Close' },
};
const text = (key) => COPY[language]?.[key] || COPY['zh-CN'][key] || key;
function localize() { document.documentElement.lang = language; document.title = text('title'); $('#title').textContent = text('title'); $('#mute').textContent = text('mute'); $('#camera').textContent = text('camera'); $('#share').textContent = text('share'); $('#invite').textContent = text('invite'); $('#kick').textContent = language === 'en' ? 'Remove member' : '移除成员'; $('#record').textContent = text('record'); $('#end-room').textContent = language === 'en' ? 'End call' : '结束通话'; $('#hangup').textContent = text('hangup'); $('#close').setAttribute('aria-label', text('close')); }

const transaction = () => `vr_${Date.now()}_${++sequence}`;
const send = (message) => ws?.send(JSON.stringify({ ...message, ...(payload.token ? { token: payload.token } : {}) }));
const setStatus = (value) => { $('#status').textContent = value; };
function appendChatMessage(message = {}) {
  const log = $('#chat-log');
  if (!log || String(message.callId || '') !== String(payload.callId || '')) return;
  const item = document.createElement('p');
  item.textContent = `${message.senderId || text('participant')}: ${String(message.text || '')}`;
  log.appendChild(item);
  while (log.children.length > 100) log.firstElementChild.remove();
}
function onVoiceCallEvent(event = {}) {
  if (event.type === 'voice_call.chat') appendChatMessage(event);
  if (event.type === 'voice_call.participant_left' && String(event.callId || '') === String(payload.callId || '')) {
    if (String(event.userId || '') === String(payload.currentUser?.id || '') && event.kicked) { setStatus(text('closed')); setTimeout(() => { void closeCall(); }, 100); }
    else removeTile(event.userId);
  }
  if (event.type === 'voice_call.ended' && String(event.callId || '') === String(payload.callId || '')) {
    setStatus(text('closed')); setTimeout(() => { void closeCall(); }, 250);
  }
}
function startKeepalive() {
  if (keepaliveTimer) return;
  keepaliveTimer = setInterval(() => {
    if (ws?.readyState === WebSocket.OPEN && sessionId) {
      send({ janus: 'keepalive', session_id: sessionId, transaction: transaction() });
    }
  }, 20_000);
}
function stopKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

function addTile(id, label, stream, local = false) {
  let tile = document.querySelector(`[data-id="${CSS.escape(String(id))}"]`);
  if (!tile) {
    tile = document.createElement('article');
    tile.className = 'tile';
    tile.dataset.id = String(id);
    tile.innerHTML = `<video autoplay playsinline ${local ? 'muted' : ''}></video><label></label>`;
    $('#grid').appendChild(tile);
  }
  tile.querySelector('video').srcObject = stream;
  tile.querySelector('label').textContent = label || text('participant');
}

function removeTile(id) { document.querySelector(`[data-id="${CSS.escape(String(id))}"]`)?.remove(); }

function createPeer(handle, offer, answerRequest) {
  const pc = new RTCPeerConnection({ iceServers: payload.iceServers || [] });
  handle.pc = pc;
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) send({ janus: 'trickle', session_id: sessionId, handle_id: handle.id, transaction: transaction(), candidate });
  };
  pc.ontrack = ({ streams, track }) => addTile(handle.id, handle.label, streams[0] || new MediaStream([track]));
  pc.onconnectionstatechange = () => { if (['failed', 'closed'].includes(pc.connectionState)) removeTile(handle.id); };
  return pc.setRemoteDescription(offer)
    .then(() => pc.createAnswer())
    .then((answer) => pc.setLocalDescription(answer))
    .then(() => send({
      janus: 'message', session_id: sessionId, handle_id: handle.id, transaction: transaction(),
      jsep: pc.localDescription, body: answerRequest,
    }));
}

async function publish() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  } catch (error) {
    // A camera denial must not prevent joining an audio-only room.
    try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
    catch { throw error; }
  }
  addTile('local', payload.currentUser?.displayName || text('me'), localStream, true);
  const pc = new RTCPeerConnection({ iceServers: payload.iceServers || [] });
  publisher.pc = pc;
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) send({ janus: 'trickle', session_id: sessionId, handle_id: publisher.id, transaction: transaction(), candidate });
  };
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ janus: 'message', session_id: sessionId, handle_id: publisher.id, transaction: transaction(),
    jsep: pc.localDescription, body: { request: 'publish', audio: true, video: Boolean(localStream.getVideoTracks().length) } });
}

async function toggleScreenShare() {
  if (!publisher?.pc) return;
  if (screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());
    if (screenSender) publisher.pc.removeTrack(screenSender);
    screenStream = null; screenSender = null;
    $('#share').textContent = '共享屏幕';
  } else {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 15 }, audio: false });
      const track = screenStream.getVideoTracks()[0];
      screenSender = publisher.pc.addTrack(track, screenStream);
      track.onended = () => { if (screenStream) void toggleScreenShare(); };
      $('#share').textContent = '结束共享';
    } catch { screenStream = null; screenSender = null; return; }
  }
  try {
    const offer = await publisher.pc.createOffer();
    await publisher.pc.setLocalDescription(offer);
    send({ janus: 'message', session_id: sessionId, handle_id: publisher.id, transaction: transaction(), jsep: publisher.pc.localDescription, body: { request: 'configure', audio: true, video: true } });
  } catch (error) { console.warn('group screen renegotiation failed', error); }
}

function toggleRecording() {
  if (recorder?.state === 'recording') { recorder.stop(); return; }
  const tracks = [...(localStream?.getAudioTracks?.() || [])];
  document.querySelectorAll('.tile video').forEach((video) => video.srcObject?.getAudioTracks?.().forEach((track) => tracks.push(track)));
  if (!tracks.length || typeof MediaRecorder === 'undefined') return;
  try {
    recordingChunks = [];
    recorder = new MediaRecorder(new MediaStream(tracks), { mimeType: 'audio/webm' });
    recorder.ondataavailable = (event) => { if (event.data.size) recordingChunks.push(event.data); };
    recorder.onstop = () => { const url = URL.createObjectURL(new Blob(recordingChunks, { type: 'audio/webm' })); const a = document.createElement('a'); a.href = url; a.download = `janus-group-call-${Date.now()}.webm`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); recorder = null; $('#record').textContent = text('record'); };
    recorder.start(); $('#record').textContent = text('recording');
  } catch { recorder = null; }
}

function subscribe(feed) {
  const tx = transaction();
  pending.set(tx, { kind: 'subscribe', feed });
  send({ janus: 'attach', session_id: sessionId, plugin: 'janus.plugin.videoroom', opaque_id: `janus-${feed.id}`, transaction: tx });
}

async function handleMessage(message) {
  if (message.janus === 'timeout') {
    stopKeepalive();
    setStatus(text('failed'));
    ws?.close();
    return;
  }
  if (message.janus === 'success' && message.transaction === window.createTransaction) {
    sessionId = message.data.id;
    send({ janus: 'attach', session_id: sessionId, plugin: 'janus.plugin.videoroom', transaction: window.attachTransaction });
    return;
  }
  if (message.janus === 'success') {
    const operation = pending.get(message.transaction);
    if (operation?.kind === 'subscribe') {
      pending.delete(message.transaction);
      const handle = { id: message.data.id, label: operation.feed.display || text('participant'), feed: operation.feed.id };
      subscribers.set(handle.id, handle);
      send({ janus: 'message', session_id: sessionId, handle_id: handle.id, transaction: transaction(), body: { request: 'join', ptype: 'subscriber', room: Number(payload.roomId), feed: Number(handle.feed) } });
    }
    return;
  }
  if (message.janus === 'event' && message.plugindata?.data?.videoroom === 'joined') {
    const data = message.plugindata.data;
    (data.publishers || []).forEach(subscribe);
    if (message.sender === publisher?.id && publisher?.joinPending) {
      publisher.joinPending = false;
      await publish();
    }
    return;
  }
  if (message.janus === 'event' && message.plugindata?.data?.videoroom === 'attached') {
    const handle = subscribers.get(message.sender);
    if (handle && message.jsep) await createPeer(handle, message.jsep, { request: 'start', room: Number(payload.roomId) });
    return;
  }
  if (message.janus === 'event' && message.plugindata?.data?.videoroom === 'event') {
    const data = message.plugindata.data;
    (data.publishers || []).forEach(subscribe);
    (data.unpublished || []).forEach((id) => { removeTile(id); [...subscribers.values()].filter((item) => item.feed === id).forEach((item) => subscribers.delete(item.id)); });
  }
  if (message.jsep) {
    const handle = message.sender === publisher?.id ? publisher : subscribers.get(message.sender);
    if (handle?.pc) await handle.pc.setRemoteDescription(message.jsep);
  }
}

async function start() {
  payload = await window.janus.auxiliaryWindowPayload(token);
  callStartedAt = String(payload.callStartedAt || new Date().toISOString());
  language = payload.language === 'en' ? 'en' : 'zh-CN';
  document.body.dataset.theme = payload.theme === 'dark' ? 'dark' : 'light';
  localize();
  const config = await window.janus.videoRoomConfig(payload.workspaceId, payload.callId || '', payload.groupId || '');
  let iceServers = [];
  try { iceServers = await window.janus.voiceCallIceServers(); } catch (error) { console.warn('voice ICE lookup failed; continuing with host candidates', error); }
  payload = { ...payload, ...config, iceServers: Array.isArray(iceServers) ? iceServers : [] };
  const isHost = String(payload.currentUser?.id || '') === String(payload.callerId || '');
  if (!isHost) { $('#invite').hidden = true; $('#kick').hidden = true; $('#end-room').hidden = true; }
  eventUnsubscribe = window.janus.onVoiceCallSignal?.(onVoiceCallEvent) || null;
  window.createTransaction = transaction();
  window.attachTransaction = transaction();
  ws = new WebSocket(config.websocketUrl, 'janus-protocol');
  ws.onopen = () => { startKeepalive(); send({ janus: 'create', transaction: window.createTransaction }); };
  ws.onmessage = (event) => { handleMessage(JSON.parse(event.data)).catch((error) => { console.error(error); setStatus(text('negotiation')); }); };
  ws.onerror = () => setStatus(text('failed'));
  ws.onclose = () => { stopKeepalive(); setStatus(text('closed')); };
  const publisherHandle = await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (sessionId) { clearInterval(timer); resolve(true); }
    }, 30);
  });
  if (!publisherHandle) return;
  publisher = { id: null, joinPending: true, label: payload.currentUser?.displayName || text('me') };
  const tx = transaction();
  pending.set(tx, { kind: 'publisher' });
  send({ janus: 'attach', session_id: sessionId, plugin: 'janus.plugin.videoroom', transaction: tx });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.janus === 'success' && message.transaction === tx) {
      publisher.id = message.data.id;
      send({ janus: 'message', session_id: sessionId, handle_id: publisher.id, transaction: transaction(), body: { request: 'join', ptype: 'publisher', room: Number(payload.roomId), display: publisher.label } });
    }
  });
  setStatus(text('joining'));
}

$('#mute').onclick = () => { const muted = !localStream?.getAudioTracks?.()[0]?.enabled; localStream?.getAudioTracks?.().forEach((track) => { track.enabled = !muted; }); $('#mute').textContent = muted ? text('unmute') : text('mute'); };
$('#camera').onclick = () => { const enabled = !localStream?.getVideoTracks?.()[0]?.enabled; localStream?.getVideoTracks?.().forEach((track) => { track.enabled = enabled; }); $('#camera').textContent = enabled ? text('camera') : text('cameraOff'); };
$('#share').onclick = () => { void toggleScreenShare(); };
$('#invite').onclick = async () => {
  const candidates = (Array.isArray(payload.friends) ? payload.friends : []).filter((user) => String(user?.id || '') !== String(payload.currentUser?.id || ''));
  const recipientId = window.prompt(`输入要邀请的群成员 ID${candidates.length ? `（可选：${candidates.map((user) => user.displayName || user.name || user.id).join('、')}）` : ''}`);
  if (!recipientId || !payload.callId) return;
  try { await window.janus.inviteVoiceCallParticipant?.({ callId: payload.callId, workspaceId: payload.workspaceId, recipientId: String(recipientId).trim() }); }
  catch { setStatus(text('negotiation')); }
};
$('#record').onclick = toggleRecording;
async function closeCall({ endRoom = false } = {}) {
  const durationSeconds = Math.max(0, Math.floor((Date.now() - new Date(callStartedAt).getTime()) / 1000));
  if (endRoom && payload.callId) await window.janus.leaveVoiceCall?.({ callId: payload.callId, workspaceId: payload.workspaceId, endRoom: true }).catch(() => {});
  if (payload.callId && payload.groupId && String(payload.currentUser?.id || '') === String(payload.callerId || '')) {
    await window.janus.recordVoiceCall?.({ callId: payload.callId, groupId: payload.groupId, callerId: payload.callerId, workspaceId: payload.workspaceId, status: 'ended', durationSeconds, startedAt: callStartedAt, endedAt: new Date().toISOString() }).catch(() => {});
  }
  if (payload.callId && !endRoom) await window.janus.leaveVoiceCall?.({ callId: payload.callId, workspaceId: payload.workspaceId }).catch(() => {});
  if (publisher?.id && sessionId && ws?.readyState === WebSocket.OPEN) send({ janus: 'message', session_id: sessionId, handle_id: publisher.id, transaction: transaction(), body: { request: 'leave' } });
  subscribers.forEach((handle) => handle.pc?.close?.()); publisher?.pc?.close?.(); screenStream?.getTracks?.().forEach((track) => track.stop());
  if (recorder?.state === 'recording') recorder.stop(); eventUnsubscribe?.(); localStream?.getTracks?.().forEach((track) => track.stop()); stopKeepalive(); ws?.close(); window.janus.closeAuxiliaryWindow(token);
}
$('#end-room').onclick = () => { void closeCall({ endRoom: true }); };
$('#kick').onclick = async () => {
  if (String(payload.currentUser?.id || '') !== String(payload.callerId || '')) return;
  const targetId = window.prompt('输入要移除的成员 ID');
  if (targetId) await window.janus.kickVoiceCallParticipant?.({ callId: payload.callId, workspaceId: payload.workspaceId, userId: targetId }).catch(() => {});
};
$('#chat-form')?.addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#chat-input'); const textValue = String(input?.value || '').trim();
  if (!textValue || !payload.callId) return;
  try {
    await window.janus.sendVoiceCallChat?.({ callId: payload.callId, workspaceId: payload.workspaceId, text: textValue, messageId: `chat-${Date.now()}-${Math.random().toString(36).slice(2)}` });
    appendChatMessage({ callId: payload.callId, senderId: payload.currentUser?.displayName || text('me'), text: textValue });
    input.value = '';
  } catch { setStatus(text('negotiation')); }
});
$('#hangup').onclick = $('#close').onclick = async () => {
  await closeCall();
};
start().catch((error) => { console.error(error); setStatus(text('config')); });
