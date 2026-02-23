
(() => {
  const me = window.APP_ME;
  const socket = io();

  const $ = (id) => document.getElementById(id);
  const contactsList = $('contactsList');
  const chatSearch = $('chatSearch');
  const friendSearch = $('friendSearch');
  const friendAddBtn = $('friendAddBtn');
  const messagesEl = $('messages');
  const activeName = $('activeName');
  const activeStatus = $('activeStatus');
  const activeAvatar = $('activeAvatar');
  const messageInput = $('messageInput');
  const sendBtn = $('sendBtn');
  const typingIndicator = $('typingIndicator');
  const typingLabel = $('typingLabel');
  const emojiBtn = $('emojiBtn');
  const emojiPicker = $('emojiPicker');
  const mediaBtn = $('mediaBtn');
  const mediaInput = $('mediaInput');
  const voiceBtn = $('voiceBtn');
  const avatarInput = $('avatarInput');
  const avatarBtn = $('avatarBtn');
  const meAvatar = $('meAvatar');
  const themeToggle = $('themeToggle');
  const replyPreview = $('replyPreview');
  const mediaPreview = $('mediaPreview');
  const selectionBar = $('selectionBar');
  const selectionCount = $('selectionCount');
  const forwardSelectedBtn = $('forwardSelectedBtn');
  const deleteSelectedBtn = $('deleteSelectedBtn');
  const clearSelectionBtn = $('clearSelectionBtn');
  const dropZone = $('dropZone');
  const lightbox = $('lightbox');
  const lightboxImg = $('lightboxImg');
  const lightboxClose = $('lightboxClose');
  const composer = document.querySelector('.composer');
  const chatPanel = document.querySelector('.chat-panel');
  const appShell = document.querySelector('.app-shell');

  let contacts = [];
  let activePeer = null;
  let typingTimer = null;
  let hasMore = true;
  let loadingHistory = false;
  let oldestMessageId = null;
  let replyTarget = null;
  let selectionMode = false;
  let mediaDraft = null;
  let mediaRecorder = null;
  let voiceChunks = [];
  let waveformLive = [];
  let recordStartedAt = null;

  const selectedMessageIds = new Set();
  const messageStore = new Map();
  const OFFLINE_KEY_PREFIX = `pulsechat_cache_${me.id}_`;
  const QUEUE_KEY = `pulsechat_queue_${me.id}`;

  const esc = (text) => (text || '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const fmtTime = (ts) => ts ? new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const fmtLastSeen = (ts) => ts ? `Last seen at ${new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : 'Offline';
  const fmtDuration = (s) => `${Math.floor((s || 0) / 60)}:${String(Math.round((s || 0) % 60)).padStart(2, '0')}`;
  const statusText = (c) => c.is_online ? `Online${c.device_count > 1 ? ` (${c.device_count} devices)` : ''}` : fmtLastSeen(c.last_seen);
  const tickSymbol = (s) => (s === 'seen' ? '✓✓' : s === 'delivered' ? '✓' : '•');
  const tickClass = (s) => (s === 'seen' ? 'read' : s === 'delivered' ? 'delivered' : 'sent');

  function humanBytes(bytes) {
    let n = Number(bytes || 0); if (!n) return '';
    const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i += 1; }
    return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
  }

  function cacheMessages(peerId, messages) {
    try { localStorage.setItem(`${OFFLINE_KEY_PREFIX}${peerId}`, JSON.stringify(messages.slice(-200))); } catch (_) {}
  }

  function getCachedMessages(peerId) {
    try { return JSON.parse(localStorage.getItem(`${OFFLINE_KEY_PREFIX}${peerId}`) || '[]'); } catch (_) { return []; }
  }

  function getQueuedMessages() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch (_) { return []; }
  }

  function saveQueuedMessages(items) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(items)); } catch (_) {}
  }

  function queueMessage(payload) {
    const q = getQueuedMessages();
    q.push({ ...payload, _queuedAt: Date.now() });
    saveQueuedMessages(q);
  }

  function notifyFromSW(title, body) {
    if (Notification.permission !== 'granted') return;
    if (!navigator.serviceWorker || !navigator.serviceWorker.controller) return;
    navigator.serviceWorker.controller.postMessage({
      type: 'SHOW_NOTIFICATION',
      payload: { title, body, data: { url: '/chat' } },
    });
  }

  function playNotify() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880; gain.gain.value = 0.03;
      osc.start(); osc.stop(ctx.currentTime + 0.08);
    } catch (_) {}
  }

  function showMessageSkeleton() {
    messagesEl.innerHTML = '<div class="skeleton-stack"><div class="skeleton-bubble"></div><div class="skeleton-bubble me"></div><div class="skeleton-bubble"></div><div class="skeleton-bubble me"></div></div>';
  }

  function setTheme(theme) {
    document.body.classList.add('theme-morph');
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    themeToggle.checked = theme === 'light';
    setTimeout(() => document.body.classList.remove('theme-morph'), 500);
  }

  function initTheme() {
    const saved = localStorage.getItem('theme') || 'dark';
    setTheme(saved);
    themeToggle.addEventListener('change', () => setTheme(themeToggle.checked ? 'light' : 'dark'));
  }

  function setReplyTarget(msg) {
    replyTarget = msg;
    if (!msg) { replyPreview.classList.add('hidden'); replyPreview.innerHTML = ''; return; }
    const content = msg.content || msg.file_name || (msg.media_type ? `[${msg.media_type}]` : 'Message');
    replyPreview.classList.remove('hidden');
    replyPreview.innerHTML = `<div><strong>Replying to ${esc(msg.sender_name || (msg.sender_id === me.id ? 'You' : 'User'))}</strong><div class="muted">${esc(content).slice(0, 80)}</div></div><button class="close-reply" title="Cancel">✕</button>`;
    replyPreview.querySelector('.close-reply').addEventListener('click', () => setReplyTarget(null));
  }

  function setMediaDraft(draft) {
    mediaDraft = draft;
    if (!draft) { mediaPreview.classList.add('hidden'); mediaPreview.innerHTML = ''; return; }
    const isVisual = draft.media_type === 'image' || draft.media_type === 'video';
    const thumb = isVisual
      ? (draft.media_type === 'image' ? `<img class="media-thumb" src="${esc(draft.preview_url || draft.media_url)}" alt="preview">` : `<video class="media-thumb" src="${esc(draft.preview_url || draft.media_url)}"></video>`)
      : '<div class="media-thumb" style="display:grid;place-items:center;background:rgba(255,255,255,0.2);">📄</div>';
    mediaPreview.classList.remove('hidden');
    mediaPreview.innerHTML = `<div class="media-preview-left">${thumb}<div><strong>${esc(draft.file_name || 'Attachment')}</strong><div class="muted">${esc((draft.media_type || 'file').toUpperCase())}${draft.file_size ? ` • ${humanBytes(draft.file_size)}` : ''}${draft.duration_sec ? ` • ${fmtDuration(draft.duration_sec)}` : ''}</div></div></div><button class="close-media" title="Remove">✕</button>`;
    mediaPreview.querySelector('.close-media').addEventListener('click', () => setMediaDraft(null));
  }

  function setSelectionMode(enabled) {
    selectionMode = enabled;
    if (!enabled) selectedMessageIds.clear();
    messagesEl.querySelectorAll('.message').forEach((el) => {
      el.classList.toggle('selectable', enabled);
      if (!enabled) el.classList.remove('selected');
    });
    selectionBar.classList.toggle('hidden', !enabled);
    selectionCount.textContent = `${selectedMessageIds.size} selected`;
  }

  function toggleSelectMessage(id, node) {
    if (selectedMessageIds.has(id)) { selectedMessageIds.delete(id); node.classList.remove('selected'); }
    else { selectedMessageIds.add(id); node.classList.add('selected'); }
    selectionCount.textContent = `${selectedMessageIds.size} selected`;
    if (!selectedMessageIds.size) setSelectionMode(false);
  }

  function reactionSummary(reactions) {
    const grouped = {};
    (reactions || []).forEach((r) => {
      if (!grouped[r.emoji]) grouped[r.emoji] = { count: 0, mine: false };
      grouped[r.emoji].count += 1;
      if (r.is_me) grouped[r.emoji].mine = true;
    });
    return Object.entries(grouped).map(([emoji, meta]) => ({ emoji, ...meta }));
  }

  function renderWaveformBars(samples) {
    const arr = Array.isArray(samples) && samples.length ? samples : [12, 18, 9, 22, 14, 8, 16, 20, 11, 19];
    return `<div class="waveform">${arr.slice(0, 38).map((v, i) => `<span class="wave-bar" style="height:${Math.max(4, Math.min(26, Number(v) || 8))}px;animation-delay:${i * 0.04}s"></span>`).join('')}</div>`;
  }

  function renderMediaContent(msg) {
    const mediaType = msg.media_type || (msg.image_url ? 'image' : '');
    const mediaUrl = msg.media_url || msg.image_url;
    if (!mediaType || !mediaUrl || msg.deleted_at) return '';
    if (mediaType === 'image') return `<img class="chat-image" data-lightbox="1" src="${esc(mediaUrl)}" alt="Image">`;
    if (mediaType === 'video') return `<video controls preload="metadata" src="${esc(mediaUrl)}"></video>`;
    if (mediaType === 'voice' || mediaType === 'audio') return `<div class="voice-wrap">${renderWaveformBars(msg.waveform)}<audio controls src="${esc(mediaUrl)}"></audio><div class="muted">${fmtDuration(msg.duration_sec || 0)}</div></div>`;
    return `<div class="file-card"><div><strong>${esc(msg.file_name || 'Document')}</strong><div class="muted">${humanBytes(msg.file_size || 0)}</div></div><a class="download-btn" href="${esc(mediaUrl)}" download="${esc(msg.file_name || 'file')}">Download</a></div>`;
  }

  function buildMessageHTML(msg) {
    const mine = msg.sender_id === me.id;
    const deleted = !!msg.deleted_at;
    const reactions = reactionSummary(msg.reactions);
    const reactionHTML = reactions.length ? `<div class="reactions">${reactions.map((r) => `<button class="reaction-chip ${r.mine ? 'mine' : ''}" data-emoji="${esc(r.emoji)}">${esc(r.emoji)} ${r.count}</button>`).join('')}</div>` : '';
    const replyHTML = msg.reply_preview ? `<div class="reply-snippet"><strong>${esc(msg.reply_preview.sender_name || 'User')}</strong><div>${esc(msg.reply_preview.content || (msg.reply_preview.image_url ? 'Photo' : 'Message')).slice(0, 70)}</div></div>` : '';
    const body = deleted ? '<i>This message was deleted</i>' : `${msg.is_forwarded ? '<div class="forwarded-tag">Forwarded</div>' : ''}${replyHTML}${msg.content ? `<div class="msg-content">${esc(msg.content)}</div>` : ''}${renderMediaContent(msg)}${reactionHTML}`;
    const showEdit = mine && !deleted && !!msg.content;
    return `<div class="message-top">${!mine ? `<div class="sender">${esc(msg.sender_name || '')}</div>` : '<span></span>'}${!deleted ? `<div class="message-actions"><button class="msg-action-btn react-btn" title="React">😊</button><button class="msg-action-btn reply-btn" title="Reply">↩</button><button class="msg-action-btn forward-btn" title="Forward">↪</button>${showEdit ? '<button class="msg-action-btn edit-btn" title="Edit">✎</button>' : ''}<button class="msg-action-btn select-btn" title="Select">☑</button><button class="msg-action-btn delete-btn" title="Delete">🗑</button></div><div class="reaction-picker hidden"><button class="reaction-pick" data-emoji="👍">👍</button><button class="reaction-pick" data-emoji="❤️">❤️</button><button class="reaction-pick" data-emoji="😂">😂</button><button class="reaction-pick" data-emoji="🔥">🔥</button><button class="reaction-pick" data-emoji="👏">👏</button></div>` : ''}</div>${body}<div class="meta"><span>${fmtTime(msg.created_at)}</span>${msg.edited_at ? '<span class="edited-tag">edited</span>' : ''}${mine ? `<span class="ticks ${tickClass(msg.status)}" data-status="${msg.status}">${tickSymbol(msg.status)}</span>` : ''}</div>`;
  }
  function attachMessageEvents(node, msg) {
    const on = (sel, fn) => { const el = node.querySelector(sel); if (el) el.addEventListener('click', fn); };
    on('.react-btn', (e) => { e.stopPropagation(); node.querySelector('.reaction-picker').classList.toggle('hidden'); });
    node.querySelectorAll('.reaction-pick').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); socket.emit('react_message', { message_id: msg.id, emoji: b.dataset.emoji }); node.querySelector('.reaction-picker').classList.add('hidden'); }));
    node.querySelectorAll('.reaction-chip').forEach((chip) => chip.addEventListener('click', (e) => { e.stopPropagation(); socket.emit('react_message', { message_id: msg.id, emoji: chip.dataset.emoji }); }));
    node.querySelectorAll('[data-lightbox="1"]').forEach((img) => img.addEventListener('click', (e) => { e.stopPropagation(); lightboxImg.src = img.src; lightbox.classList.remove('hidden'); }));
    on('.reply-btn', (e) => { e.stopPropagation(); setReplyTarget(msg); });
    on('.edit-btn', (e) => { e.stopPropagation(); const updated = prompt('Edit message', msg.content || ''); if (updated && updated.trim()) socket.emit('edit_message', { message_id: msg.id, content: updated.trim() }); });
    on('.forward-btn', (e) => {
      e.stopPropagation(); if (!activePeer) return;
      socket.emit('send_message', { recipient_id: activePeer.id, content: msg.content || '', image_url: msg.image_url || '', media_url: msg.media_url || '', media_type: msg.media_type || '', file_name: msg.file_name || '', file_size: msg.file_size || 0, duration_sec: msg.duration_sec || 0, waveform: msg.waveform || [], forwarded_from_id: msg.id });
    });
    on('.delete-btn', (e) => {
      e.stopPropagation();
      const mine = msg.sender_id === me.id;
      const choice = mine ? (prompt('Delete mode: type "me" or "everyone"', 'everyone') || '').toLowerCase() : 'me';
      if (choice === 'me' || choice === 'everyone') socket.emit('delete_message', { message_id: msg.id, mode: choice });
    });
    on('.select-btn', (e) => { e.stopPropagation(); if (!selectionMode) setSelectionMode(true); toggleSelectMessage(msg.id, node); });
    node.addEventListener('click', () => { if (selectionMode) toggleSelectMessage(msg.id, node); });

    let startX = 0;
    let deltaX = 0;
    node.addEventListener('touchstart', (e) => {
      if (!e.touches || !e.touches[0]) return;
      startX = e.touches[0].clientX;
      deltaX = 0;
    }, { passive: true });
    node.addEventListener('touchmove', (e) => {
      if (!e.touches || !e.touches[0]) return;
      deltaX = e.touches[0].clientX - startX;
      if (Math.abs(deltaX) > 8) node.style.transform = `translateX(${Math.max(-70, Math.min(70, deltaX))}px)`;
    }, { passive: true });
    node.addEventListener('touchend', () => {
      node.style.transform = '';
      if (deltaX > 55) setReplyTarget(msg);
      if (deltaX < -55) {
        const mode = msg.sender_id === me.id ? 'everyone' : 'me';
        socket.emit('delete_message', { message_id: msg.id, mode });
      }
    });
  }

  function renderOrUpdateMessage(msg, append = true, prepend = false) {
    messageStore.set(msg.id, msg);
    let node = messagesEl.querySelector(`.message[data-id="${msg.id}"]`);
    if (!node) {
      node = document.createElement('article');
      node.className = `message ${msg.sender_id === me.id ? 'me' : 'other'} ${msg.deleted_at ? 'deleted' : ''}`;
      node.dataset.id = msg.id;
      node.innerHTML = buildMessageHTML(msg);
      if (prepend) messagesEl.prepend(node); else if (append) messagesEl.appendChild(node); else messagesEl.appendChild(node);
    } else {
      node.className = `message ${msg.sender_id === me.id ? 'me' : 'other'} ${msg.deleted_at ? 'deleted' : ''}`;
      node.innerHTML = buildMessageHTML(msg);
    }
    attachMessageEvents(node, msg);
    node.classList.toggle('selectable', selectionMode);
  }

  function scrollBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

  async function loadContacts() {
    const res = await fetch('/api/contacts');
    contacts = await res.json();
    const q = chatSearch.value.toLowerCase().trim();
    const html = contacts.filter((c) => c.username.toLowerCase().includes(q) || (c.last_message || '').toLowerCase().includes(q)).map((c) => {
      const statusClass = c.is_online ? 'online' : 'offline';
      const activeClass = activePeer && activePeer.id === c.id ? 'active' : '';
      return `<article class="contact ${activeClass}" data-id="${c.id}"><img src="${esc(c.avatar_url || '')}" class="avatar" alt="${esc(c.username)}"><div><h4>${esc(c.username)}</h4><p>${esc(c.last_message || 'Start chatting...')}</p></div><div><small class="status-dot ${statusClass}">${esc(statusText(c))}</small>${c.unread_count > 0 ? `<div class="badge">${c.unread_count}</div>` : ''}</div></article>`;
    }).join('');
    contactsList.innerHTML = html || '<p class="muted">No chats found</p>';
    contactsList.querySelectorAll('.contact').forEach((el) => el.addEventListener('click', () => openChat(Number(el.dataset.id))));
    if (!activePeer && contacts.length) openChat(contacts[0].id);
  }

  async function fetchMessages({ beforeId = null, prepend = false } = {}) {
    if (!activePeer || loadingHistory || (!hasMore && prepend)) return;
    loadingHistory = true;
    if (!prepend) showMessageSkeleton();
    const params = new URLSearchParams({ limit: '25' });
    if (beforeId) params.set('before_id', String(beforeId));
    let data = { messages: [], has_more: false };
    try {
      const res = await fetch(`/api/messages/${activePeer.id}?${params}`);
      data = await res.json();
    } catch (_) {
      data = { messages: getCachedMessages(activePeer.id), has_more: false };
    }
    const messages = data.messages || [];
    if (!prepend) { messagesEl.innerHTML = ''; messageStore.clear(); }
    const prevHeight = messagesEl.scrollHeight;
    if (prepend) {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        renderOrUpdateMessage(m, false, true);
        oldestMessageId = oldestMessageId === null ? m.id : Math.min(oldestMessageId, m.id);
      }
    } else {
      messages.forEach((m) => {
        renderOrUpdateMessage(m, true, false);
        oldestMessageId = oldestMessageId === null ? m.id : Math.min(oldestMessageId, m.id);
      });
    }
    hasMore = !!data.has_more;
    if (!prepend) cacheMessages(activePeer.id, messages);
    if (prepend) messagesEl.scrollTop = messagesEl.scrollHeight - prevHeight; else scrollBottom();
    loadingHistory = false;
  }

  async function openChat(peerId) {
    const peer = contacts.find((c) => c.id === peerId);
    if (!peer) return;
    activePeer = peer;
    hasMore = true;
    loadingHistory = false;
    oldestMessageId = null;
    setReplyTarget(null);
    setSelectionMode(false);
    setMediaDraft(null);
    activeName.textContent = peer.username;
    activeAvatar.src = peer.avatar_url || '';
    activeStatus.textContent = statusText(peer);
    activeStatus.className = `status-dot ${peer.is_online ? 'online' : 'offline'}`;
    if (window.innerWidth <= 900) appShell.classList.add('mobile-chat-focus');
    socket.emit('join_chat', { peer_id: peerId });
    await fetchMessages();
    loadContacts();
  }

  async function uploadAvatar(file) {
    const fd = new FormData();
    fd.append('avatar', file);
    const res = await fetch('/upload/avatar', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    return data;
  }

  async function uploadMedia(file, mediaType = '') {
    const fd = new FormData();
    fd.append('media', file);
    if (mediaType) fd.append('media_type', mediaType);
    const res = await fetch('/upload/media', { method: 'POST', body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    return data;
  }

  async function addMediaFromFile(file, preferredType = '') {
    if (!file) return;
    try {
      const uploaded = await uploadMedia(file, preferredType);
      setMediaDraft({ ...uploaded, preview_url: uploaded.media_type === 'image' || uploaded.media_type === 'video' ? URL.createObjectURL(file) : '', waveform: preferredType === 'voice' ? waveformLive.slice(0, 40) : [], duration_sec: preferredType === 'voice' ? ((Date.now() - recordStartedAt) / 1000) : 0 });
    } catch (err) { alert(err.message); }
  }

  function sendMessage() {
    if (!activePeer) return;
    const content = messageInput.value.trim();
    if (!content && !mediaDraft) return;
    const payload = {
      recipient_id: activePeer.id,
      content,
      image_url: mediaDraft && mediaDraft.media_type === 'image' ? mediaDraft.media_url : '',
      media_url: mediaDraft ? mediaDraft.media_url : '',
      media_type: mediaDraft ? mediaDraft.media_type : '',
      file_name: mediaDraft ? mediaDraft.file_name : '',
      file_size: mediaDraft ? mediaDraft.file_size : 0,
      duration_sec: mediaDraft ? mediaDraft.duration_sec || 0 : 0,
      waveform: mediaDraft ? mediaDraft.waveform || [] : [],
      reply_to_id: replyTarget ? replyTarget.id : null,
    };

    if (!navigator.onLine) {
      queueMessage(payload);
      alert('Offline: message queued and will send when back online.');
    } else {
      socket.emit('send_message', payload);
    }
    messageInput.value = '';
    messageInput.style.height = '44px';
    setReplyTarget(null);
    setMediaDraft(null);
    socket.emit('typing', { recipient_id: activePeer.id, is_typing: false });
  }
  async function startVoiceRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
      composer.classList.remove('recording');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder = new MediaRecorder(stream);
      voiceChunks = [];
      waveformLive = [];
      recordStartedAt = Date.now();
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      let rafId = null;
      const capture = () => {
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        waveformLive.push(Math.max(4, Math.min(26, Math.round(avg / 5))));
        if (waveformLive.length > 80) waveformLive.shift();
        rafId = requestAnimationFrame(capture);
      };
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) voiceChunks.push(e.data); };
      mediaRecorder.onstop = async () => {
        cancelAnimationFrame(rafId);
        stream.getTracks().forEach((t) => t.stop());
        audioCtx.close();
        composer.classList.remove('recording');
        if (!voiceChunks.length) return;
        const blob = new Blob(voiceChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        const file = new File([blob], `voice_${Date.now()}.webm`, { type: blob.type || 'audio/webm' });
        await addMediaFromFile(file, 'voice');
      };
      mediaRecorder.start();
      capture();
      composer.classList.add('recording');
    } catch (_) {
      alert('Microphone permission denied or unavailable.');
    }
  }

  function initDragDrop() {
    let dragDepth = 0;
    const show = () => dropZone.classList.remove('hidden');
    const hide = () => dropZone.classList.add('hidden');
    ['dragenter', 'dragover'].forEach((evt) => chatPanel.addEventListener(evt, (e) => { e.preventDefault(); dragDepth += 1; show(); }));
    ['dragleave', 'drop'].forEach((evt) => chatPanel.addEventListener(evt, (e) => { e.preventDefault(); dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) hide(); }));
    chatPanel.addEventListener('drop', async (e) => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      hide(); dragDepth = 0;
      if (file) await addMediaFromFile(file);
    });
  }

  function addRipple(target, event) {
    const rect = target.getBoundingClientRect();
    const ripple = document.createElement('span');
    const size = Math.max(rect.width, rect.height);
    ripple.className = 'ripple';
    ripple.style.width = `${size}px`;
    ripple.style.height = `${size}px`;
    ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
    ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
    target.appendChild(ripple);
    setTimeout(() => ripple.remove(), 550);
  }

  function buildEmojiPicker() {
    const emojis = '😀 😁 😂 🤣 😊 😎 😍 😘 🤗 🤔 😴 😭 😡 👍 👏 🙌 🎉 ❤️ 🔥 ✨ ✅'.split(' ');
    emojiPicker.innerHTML = emojis.map((e) => `<button class="emoji">${e}</button>`).join('');
    emojiPicker.querySelectorAll('.emoji').forEach((btn) => btn.addEventListener('click', () => { messageInput.value += btn.textContent; messageInput.focus(); }));
  }

  socket.on('new_message', (msg) => {
    const belongs = activePeer && [msg.sender_id, msg.recipient_id].includes(activePeer.id);
    if (belongs) {
      renderOrUpdateMessage(msg);
      scrollBottom();
      oldestMessageId = oldestMessageId === null ? msg.id : Math.min(oldestMessageId, msg.id);
      if (msg.sender_id === activePeer.id) socket.emit('join_chat', { peer_id: activePeer.id });
    }
    if (msg.sender_id !== me.id) {
      playNotify();
      if (document.hidden) {
        notifyFromSW(msg.sender_name || 'New message', msg.content || msg.file_name || 'Sent you a media message');
      }
    }
    loadContacts();
  });

  socket.on('message_status', ({ message_ids, status }) => {
    (message_ids || []).forEach((id) => {
      const msg = messageStore.get(id); if (!msg) return;
      msg.status = status;
      const tick = messagesEl.querySelector(`.message[data-id="${id}"] .ticks`);
      if (tick) { tick.dataset.status = status; tick.className = `ticks ${tickClass(status)}`; tick.textContent = tickSymbol(status); }
    });
    loadContacts();
  });

  socket.on('message_edited', ({ message_id, content, edited_at }) => {
    const msg = messageStore.get(message_id); if (!msg) return;
    msg.content = content; msg.edited_at = edited_at; renderOrUpdateMessage(msg, false, false);
  });

  socket.on('message_reactions', ({ message_id, reactions }) => {
    const msg = messageStore.get(message_id); if (!msg) return;
    msg.reactions = reactions || []; renderOrUpdateMessage(msg, false, false);
  });

  socket.on('message_deleted', ({ message_id }) => {
    const msg = messageStore.get(message_id); if (!msg) return;
    Object.assign(msg, { content: '', image_url: null, media_url: null, media_type: null, file_name: null, file_size: null, duration_sec: null, waveform: [], deleted_at: new Date().toISOString(), reactions: [], edited_at: null });
    renderOrUpdateMessage(msg, false, false);
    loadContacts();
  });

  socket.on('message_hidden', ({ message_id }) => {
    messageStore.delete(message_id);
    const el = messagesEl.querySelector(`.message[data-id="${message_id}"]`);
    if (el) el.remove();
    selectedMessageIds.delete(message_id);
    selectionCount.textContent = `${selectedMessageIds.size} selected`;
    loadContacts();
  });

  socket.on('presence', ({ user_id, status, is_online, last_seen, device_count }) => {
    const online = typeof is_online === 'boolean' ? is_online : status === 'online';
    contacts = contacts.map((c) => (c.id === user_id ? { ...c, is_online: online, last_seen: last_seen || c.last_seen, device_count: device_count ?? c.device_count } : c));
    if (activePeer && activePeer.id === user_id) {
      activePeer.is_online = online;
      if (last_seen) activePeer.last_seen = last_seen;
      if (typeof device_count === 'number') activePeer.device_count = device_count;
      activeStatus.textContent = statusText(activePeer);
      activeStatus.className = `status-dot ${activePeer.is_online ? 'online' : 'offline'}`;
    }
    loadContacts();
  });

  socket.on('typing', ({ from_user_id, is_typing }) => {
    if (!activePeer || from_user_id !== activePeer.id) return;
    typingLabel.textContent = `${activePeer.username} is typing...`;
    typingIndicator.classList.toggle('hidden', !is_typing);
  });

  messageInput.addEventListener('input', () => {
    messageInput.style.height = 'auto';
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, 130)}px`;
    if (!activePeer) return;
    socket.emit('typing', { recipient_id: activePeer.id, is_typing: true });
    clearTimeout(typingTimer);
    typingTimer = setTimeout(() => socket.emit('typing', { recipient_id: activePeer.id, is_typing: false }), 900);
  });

  messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  messagesEl.addEventListener('scroll', async () => {
    if (messagesEl.scrollTop > 60 || !hasMore || loadingHistory || !oldestMessageId) return;
    await fetchMessages({ beforeId: oldestMessageId, prepend: true });
  });

  sendBtn.addEventListener('click', sendMessage);
  mediaBtn.addEventListener('click', () => mediaInput.click());
  mediaInput.addEventListener('change', async () => { const file = mediaInput.files[0]; if (file) await addMediaFromFile(file); mediaInput.value = ''; });
  voiceBtn.addEventListener('click', startVoiceRecording);

  avatarBtn.addEventListener('click', () => avatarInput.click());
  avatarInput.addEventListener('change', async () => {
    const file = avatarInput.files[0];
    if (!file) return;
    try { const data = await uploadAvatar(file); meAvatar.src = data.avatar_url; } catch (err) { alert(err.message); }
    avatarInput.value = '';
  });

  forwardSelectedBtn.addEventListener('click', () => {
    if (!activePeer || !selectedMessageIds.size) return;
    [...selectedMessageIds].forEach((id) => {
      const msg = messageStore.get(id); if (!msg) return;
      socket.emit('send_message', { recipient_id: activePeer.id, content: msg.content || '', image_url: msg.image_url || '', media_url: msg.media_url || '', media_type: msg.media_type || '', file_name: msg.file_name || '', file_size: msg.file_size || 0, duration_sec: msg.duration_sec || 0, waveform: msg.waveform || [], forwarded_from_id: msg.id });
    });
    setSelectionMode(false);
  });

  deleteSelectedBtn.addEventListener('click', () => {
    if (!selectedMessageIds.size) return;
    const mode = (prompt('Delete selected: type "me" or "everyone"', 'me') || '').toLowerCase();
    if (mode !== 'me' && mode !== 'everyone') return;
    [...selectedMessageIds].forEach((id) => socket.emit('delete_message', { message_id: id, mode }));
    setSelectionMode(false);
  });

  clearSelectionBtn.addEventListener('click', () => setSelectionMode(false));
  emojiBtn.addEventListener('click', () => emojiPicker.classList.toggle('hidden'));
  chatSearch.addEventListener('input', loadContacts);
  lightboxClose.addEventListener('click', () => lightbox.classList.add('hidden'));
  lightbox.addEventListener('click', (e) => { if (e.target === lightbox) lightbox.classList.add('hidden'); });

  document.addEventListener('click', (e) => {
    if (!emojiPicker.contains(e.target) && e.target !== emojiBtn) emojiPicker.classList.add('hidden');
    if (!e.target.closest('.message')) document.querySelectorAll('.reaction-picker').forEach((p) => p.classList.add('hidden'));
  });

  document.addEventListener('pointerdown', (e) => {
    const target = e.target.closest('.btn, .icon-btn, .contact, .emoji, .msg-action-btn, .reaction-chip, .download-btn');
    if (!target) return;
    addRipple(target, e);
  });

  document.addEventListener('mousemove', (e) => {
    const x = e.clientX - window.innerWidth / 2;
    const y = e.clientY - window.innerHeight / 2;
    document.body.style.setProperty('--mouse-x', `${x}px`);
    document.body.style.setProperty('--mouse-y', `${y}px`);
  });

  ['dragenter', 'dragover'].forEach((evt) => chatPanel.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.remove('hidden'); }));
  ['dragleave', 'drop'].forEach((evt) => chatPanel.addEventListener(evt, (e) => { e.preventDefault(); dropZone.classList.add('hidden'); }));
  chatPanel.addEventListener('drop', async (e) => { const file = e.dataTransfer.files && e.dataTransfer.files[0]; if (file) await addMediaFromFile(file); });

  let navStartX = 0;
  let navEndX = 0;
  appShell.addEventListener('touchstart', (e) => {
    if (!e.touches || !e.touches[0]) return;
    navStartX = e.touches[0].clientX;
  }, { passive: true });
  appShell.addEventListener('touchmove', (e) => {
    if (!e.touches || !e.touches[0]) return;
    navEndX = e.touches[0].clientX;
  }, { passive: true });
  appShell.addEventListener('touchend', () => {
    if (window.innerWidth > 900) return;
    const delta = navEndX - navStartX;
    if (delta < -80 && activePeer) appShell.classList.add('mobile-chat-focus');
    if (delta > 80 && navStartX < 40) appShell.classList.remove('mobile-chat-focus');
    navStartX = 0;
    navEndX = 0;
  });

  async function flushQueue() {
    if (!navigator.onLine) return;
    const q = getQueuedMessages();
    if (!q.length) return;
    q.forEach((item) => socket.emit('send_message', item));
    saveQueuedMessages([]);
  }

  async function addFriend() {
    const q = (friendSearch.value || '').trim();
    if (!q) return;
    const res = await fetch(`/api/friends/search?q=${encodeURIComponent(q)}`);
    const users = await res.json();
    if (!users.length) {
      alert('No user found.');
      return;
    }
    const target = users[0];
    const addRes = await fetch('/api/friends/add', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ friend_id: target.id }),
    });
    if (!addRes.ok) {
      const err = await addRes.json();
      alert(err.error || 'Could not add friend');
      return;
    }
    friendSearch.value = '';
    loadContacts();
  }

  friendAddBtn.addEventListener('click', addFriend);
  friendSearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') addFriend(); });
  window.addEventListener('online', flushQueue);

  buildEmojiPicker();
  initTheme();
  flushQueue();
  loadContacts();
})();
