// Grok Orchestrator — frontend logic (vanilla JS, no build step)
const { invoke } = window.__TAURI__.core;

const uid = () => 'id-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

const MODE_LABELS = { chain: 'Цепочка', delegate: 'Делегирование', collab: 'Совместная работа' };
const MODE_DESC = {
  chain: 'Каждая модель получает результат предыдущей и передаёт дальше по цепочке. Итог — выход последней модели.',
  delegate: 'Все модели получают исходный запрос параллельно и отвечают каждая за свой аспект. Результаты собираются вместе.',
  collab: 'Все модели (кроме синтезатора) отвечают на запрос независимо, затем модель-синтезатор сводит их ответы в один.'
};

let state = {
  chats: [],
  activeChatId: null,
  apiKeys: [] // {id, label, key}  -- id здесь локальный (frontend), синхронизируется с backend при старте
};

let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 400);
}
async function saveState() {
  try {
    await invoke('save_data', { json: JSON.stringify(state) });
  } catch (e) {
    console.error('save failed', e);
  }
}

function defaultNode(n) {
  return {
    id: uid(),
    name: `Модель ${n}`,
    model: 'llama-3.3-70b-versatile',
    role: '',
    systemPrompt: ''
  };
}

function newChat() {
  const chat = {
    id: uid(),
    title: 'Новый чат',
    mode: 'chain',
    nodes: [defaultNode(1), defaultNode(2)],
    synthesizerId: null,
    messages: []
  };
  chat.synthesizerId = chat.nodes[0].id;
  return chat;
}

// ---------------- Startup / persistence ----------------
async function boot() {
  let raw = '';
  try { raw = await invoke('load_data'); } catch (e) { console.error(e); }
  if (raw) {
    try {
      const loaded = JSON.parse(raw);
      state.chats = loaded.chats || [];
      state.apiKeys = loaded.apiKeys || [];
    } catch (e) { console.error('parse failed', e); }
  }
  // Re-hydrate backend key pool from saved raw keys
  for (const k of state.apiKeys) {
    try {
      const pub = await invoke('restore_api_key', { label: k.label, key: k.key });
      k.backendId = pub.id;
    } catch (e) { console.error(e); }
  }
  if (state.chats.length === 0) {
    const c = newChat();
    state.chats.push(c);
    state.activeChatId = c.id;
  }
  if (!state.activeChatId) state.activeChatId = state.chats[0].id;

  renderChatList();
  renderKeyList();
  openChat(state.activeChatId);
}

// ---------------- Chat list ----------------
function renderChatList() {
  const el = document.getElementById('chatList');
  el.innerHTML = '';
  for (const chat of state.chats) {
    const div = document.createElement('div');
    div.className = 'chat-item' + (chat.id === state.activeChatId ? ' active' : '');
    div.innerHTML = `
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(chat.title || 'Без названия')}</span>
      <span class="mode-badge">${MODE_LABELS[chat.mode]}</span>
      <button class="del-chat" title="Удалить">✕</button>
    `;
    div.addEventListener('click', (e) => {
      if (e.target.classList.contains('del-chat')) return;
      openChat(chat.id);
    });
    div.querySelector('.del-chat').addEventListener('click', (e) => {
      e.stopPropagation();
      if (!confirm('Удалить чат «' + chat.title + '»?')) return;
      state.chats = state.chats.filter(c => c.id !== chat.id);
      if (state.activeChatId === chat.id) {
        state.activeChatId = state.chats[0] ? state.chats[0].id : null;
      }
      renderChatList();
      if (state.activeChatId) openChat(state.activeChatId); else showEmptyState();
      scheduleSave();
    });
    el.appendChild(div);
  }
}

function showEmptyState() {
  document.getElementById('emptyState').classList.remove('hidden');
  document.getElementById('chatView').classList.add('hidden');
}

function activeChat() {
  return state.chats.find(c => c.id === state.activeChatId);
}

function openChat(id) {
  state.activeChatId = id;
  document.getElementById('emptyState').classList.add('hidden');
  document.getElementById('chatView').classList.remove('hidden');
  const chat = activeChat();
  document.getElementById('chatTitleInput').value = chat.title;
  document.querySelectorAll('.mode-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === chat.mode);
  });
  renderMessages();
  renderGraph();
  renderChatList();
}

// ---------------- API keys ----------------
function renderKeyList() {
  const el = document.getElementById('keyList');
  el.innerHTML = '';
  invoke('list_api_keys').then(list => {
    for (const k of list) {
      const local = state.apiKeys.find(x => x.backendId === k.id);
      const row = document.createElement('div');
      row.className = 'key-row';
      const statusClass = !k.enabled ? 'off' : (k.cooling_down ? 'cooling' : '');
      row.innerHTML = `
        <span class="key-status ${statusClass}" title="${k.cooling_down ? 'Rate limit, ждём' : (k.enabled ? 'Активен' : 'Отключен')}"></span>
        <span class="key-label">${escapeHtml(k.label)}</span>
        <span class="key-masked">${k.masked}</span>
        <button class="toggle-key" title="Вкл/выкл">${k.enabled ? '⏸' : '▶'}</button>
        <button class="remove-key" title="Удалить">✕</button>
      `;
      row.querySelector('.toggle-key').addEventListener('click', async () => {
        await invoke('toggle_api_key', { id: k.id, enabled: !k.enabled });
        renderKeyList();
      });
      row.querySelector('.remove-key').addEventListener('click', async () => {
        await invoke('remove_api_key', { id: k.id });
        state.apiKeys = state.apiKeys.filter(x => x.backendId !== k.id);
        scheduleSave();
        renderKeyList();
      });
      el.appendChild(row);
    }
  });
}

document.getElementById('addKeyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const label = document.getElementById('keyLabel').value.trim();
  const key = document.getElementById('keyValue').value.trim();
  if (!label || !key) return;
  const pub = await invoke('add_api_key', { label, key });
  state.apiKeys.push({ id: uid(), label, key, backendId: pub.id });
  document.getElementById('addKeyForm').reset();
  scheduleSave();
  renderKeyList();
});

// ---------------- New chat / title / mode ----------------
document.getElementById('newChatBtn').addEventListener('click', () => {
  const c = newChat();
  state.chats.unshift(c);
  state.activeChatId = c.id;
  renderChatList();
  openChat(c.id);
  scheduleSave();
});

document.getElementById('chatTitleInput').addEventListener('input', (e) => {
  const chat = activeChat();
  if (!chat) return;
  chat.title = e.target.value;
  renderChatList();
  scheduleSave();
});

document.querySelectorAll('.mode-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const chat = activeChat();
    if (!chat) return;
    chat.mode = btn.dataset.mode;
    document.querySelectorAll('.mode-tab').forEach(b => b.classList.toggle('active', b === btn));
    renderChatList();
    renderGraph();
    scheduleSave();
  });
});

// ---------------- Pipeline modal ----------------
let editingNodes = [];
let editingSynth = null;

document.getElementById('configurePipelineBtn').addEventListener('click', () => {
  const chat = activeChat();
  if (!chat) return;
  editingNodes = JSON.parse(JSON.stringify(chat.nodes));
  editingSynth = chat.synthesizerId;
  document.getElementById('pipelineModalTitle').textContent = 'Пайплайн: ' + MODE_LABELS[chat.mode];
  document.getElementById('pipelineModeDesc').textContent = MODE_DESC[chat.mode];
  document.getElementById('synthWrap').classList.toggle('hidden', chat.mode !== 'collab');
  renderNodesEditor();
  document.getElementById('pipelineModal').classList.remove('hidden');
});

document.getElementById('closePipelineModal').addEventListener('click', () => {
  document.getElementById('pipelineModal').classList.add('hidden');
});

document.getElementById('addNodeBtn').addEventListener('click', () => {
  editingNodes.push(defaultNode(editingNodes.length + 1));
  renderNodesEditor();
});

function renderNodesEditor() {
  const el = document.getElementById('nodesEditor');
  el.innerHTML = '';
  const chat = activeChat();
  editingNodes.forEach((node, i) => {
    const card = document.createElement('div');
    card.className = 'node-card';
    card.innerHTML = `
      <div class="node-card-row">
        <input class="node-name-input" value="${escapeAttr(node.name)}" placeholder="Название узла">
        <button class="remove-node" title="Удалить">✕</button>
      </div>
      <div class="node-card-row">
        <input class="node-model-input" list="modelSuggestions" value="${escapeAttr(node.model)}" placeholder="ID модели Groq">
      </div>
      <textarea class="node-prompt-input" placeholder="Системный промпт / роль этой модели в пайплайне">${escapeHtml(node.systemPrompt)}</textarea>
    `;
    card.querySelector('.node-name-input').addEventListener('input', e => node.name = e.target.value);
    card.querySelector('.node-model-input').addEventListener('input', e => node.model = e.target.value);
    card.querySelector('.node-prompt-input').addEventListener('input', e => node.systemPrompt = e.target.value);
    card.querySelector('.remove-node').addEventListener('click', () => {
      if (editingNodes.length <= 1) { alert('Нужен хотя бы один узел'); return; }
      editingNodes.splice(i, 1);
      renderNodesEditor();
    });
    el.appendChild(card);
  });
  if (chat.mode === 'collab') {
    const sel = document.getElementById('synthSelect');
    sel.innerHTML = '';
    editingNodes.forEach(n => {
      const opt = document.createElement('option');
      opt.value = n.id; opt.textContent = n.name;
      if (n.id === editingSynth) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.onchange = () => editingSynth = sel.value;
  }
}

document.getElementById('savePipelineBtn').addEventListener('click', () => {
  const chat = activeChat();
  if (!chat) return;
  chat.nodes = editingNodes;
  if (chat.mode === 'collab') {
    chat.synthesizerId = editingSynth && editingNodes.find(n => n.id === editingSynth)
      ? editingSynth : editingNodes[0].id;
  }
  document.getElementById('pipelineModal').classList.add('hidden');
  renderGraph();
  scheduleSave();
});

// ---------------- Messages rendering ----------------
function renderMessages() {
  const chat = activeChat();
  const el = document.getElementById('messages');
  el.innerHTML = '';
  for (const m of chat.messages) {
    const div = document.createElement('div');
    div.className = 'msg ' + (m.role === 'user' ? 'user' : 'assistant');
    div.textContent = m.content;
    if (m.meta) {
      const meta = document.createElement('div');
      meta.className = 'msg-meta';
      meta.textContent = '▸ показать ответы моделей';
      meta.addEventListener('click', () => {
        const shown = meta.dataset.shown === '1';
        meta.dataset.shown = shown ? '0' : '1';
        meta.textContent = shown ? '▸ показать ответы моделей' : '▾ скрыть';
        if (!shown) {
          const pre = document.createElement('div');
          pre.style.marginTop = '6px';
          pre.style.whiteSpace = 'pre-wrap';
          pre.style.fontSize = '12px';
          pre.style.color = 'var(--text-dim)';
          pre.textContent = m.meta;
          pre.className = 'meta-detail';
          div.appendChild(pre);
        } else {
          const d = div.querySelector('.meta-detail');
          if (d) d.remove();
        }
      });
      div.appendChild(meta);
    }
    el.appendChild(div);
  }
  el.scrollTop = el.scrollHeight;
}

// ---------------- Graph rendering ----------------
const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

function renderGraph() {
  const chat = activeChat();
  const svg = document.getElementById('graphSvg');
  svg.innerHTML = '';
  const defs = svgEl('defs', {});
  defs.innerHTML = `<marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#666"/></marker>`;
  svg.appendChild(defs);

  const W = 600, H = 320;
  const positions = {}; // nodeId -> {x,y}
  const edges = []; // {from:{x,y}, to:{x,y}, id}

  if (chat.mode === 'chain') {
    const n = chat.nodes.length;
    const gap = W / (n + 1);
    chat.nodes.forEach((node, i) => {
      positions[node.id] = { x: gap * (i + 1), y: H / 2 };
    });
    for (let i = 0; i < n - 1; i++) {
      edges.push({ from: chat.nodes[i].id, to: chat.nodes[i + 1].id });
    }
  } else if (chat.mode === 'delegate') {
    positions['__input'] = { x: 60, y: H / 2 };
    const n = chat.nodes.length;
    const step = H / (n + 1);
    chat.nodes.forEach((node, i) => {
      positions[node.id] = { x: W / 2, y: step * (i + 1) };
      edges.push({ from: '__input', to: node.id });
    });
    positions['__output'] = { x: W - 60, y: H / 2 };
    chat.nodes.forEach(node => edges.push({ from: node.id, to: '__output' }));
  } else if (chat.mode === 'collab') {
    const others = chat.nodes.filter(n => n.id !== chat.synthesizerId);
    const synth = chat.nodes.find(n => n.id === chat.synthesizerId) || chat.nodes[0];
    positions[synth.id] = { x: W / 2, y: H / 2 };
    const radius = Math.min(W, H) / 2 - 70;
    const cx = W / 2, cy = H / 2;
    others.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / Math.max(others.length, 1) - Math.PI / 2;
      positions[node.id] = { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
      edges.push({ from: node.id, to: synth.id });
    });
  }

  // Draw edges first
  for (const e of edges) {
    const p1 = positions[e.from], p2 = positions[e.to];
    if (!p1 || !p2) continue;
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const r = 30;
    const x1 = p1.x + (dx / len) * r, y1 = p1.y + (dy / len) * r;
    const x2 = p2.x - (dx / len) * r, y2 = p2.y - (dy / len) * r;
    const line = svgEl('line', { x1, y1, x2, y2, class: 'graph-edge', id: 'edge-' + e.from + '-' + e.to });
    svg.appendChild(line);
  }

  // pseudo nodes for delegate
  if (chat.mode === 'delegate') {
    drawPseudoNode(svg, positions['__input'], 'Вход');
    drawPseudoNode(svg, positions['__output'], 'Итог');
  }

  // real nodes
  for (const node of chat.nodes) {
    const p = positions[node.id];
    if (!p) continue;
    const g = svgEl('g', { class: 'graph-node idle', id: 'node-' + node.id, transform: `translate(${p.x},${p.y})` });
    g.appendChild(svgEl('circle', { r: 28 }));
    const label = (node.name || 'Модель').slice(0, 12);
    const t1 = svgEl('text', { 'text-anchor': 'middle', y: 4 });
    t1.textContent = label;
    g.appendChild(t1);
    const t2 = svgEl('text', { 'text-anchor': 'middle', y: 42, class: 'role-text' });
    t2.textContent = (node.model || '').slice(0, 20);
    g.appendChild(t2);
    if (chat.mode === 'collab' && node.id === chat.synthesizerId) {
      const badge = svgEl('text', { 'text-anchor': 'middle', y: -36, class: 'role-text' });
      badge.textContent = '⭐ синтезатор';
      g.appendChild(badge);
    }
    svg.appendChild(g);
  }

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
}

function drawPseudoNode(svg, pos, label) {
  if (!pos) return;
  const g = svgEl('g', { transform: `translate(${pos.x},${pos.y})` });
  g.appendChild(svgEl('circle', { r: 22, fill: '#22232c', stroke: '#444', 'stroke-width': 1.5 }));
  const t = svgEl('text', { 'text-anchor': 'middle', y: 4, fill: '#9698a8', 'font-size': 10 });
  t.textContent = label;
  g.appendChild(t);
  svg.appendChild(g);
}

function setNodeState(nodeId, cls) {
  const g = document.getElementById('node-' + nodeId);
  if (!g) return;
  g.setAttribute('class', 'graph-node ' + cls);
}

function resetGraphStates() {
  const chat = activeChat();
  for (const node of chat.nodes) setNodeState(node.id, 'idle');
}

// ---------------- Orchestration ----------------
document.getElementById('sendForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const chat = activeChat();
  const input = document.getElementById('userInput');
  const text = input.value.trim();
  if (!text || !chat) return;
  input.value = '';
  document.getElementById('sendBtn').disabled = true;

  chat.messages.push({ role: 'user', content: text });
  renderMessages();
  resetGraphStates();

  try {
    if (chat.mode === 'chain') await runChain(chat, text);
    else if (chat.mode === 'delegate') await runDelegate(chat, text);
    else if (chat.mode === 'collab') await runCollab(chat, text);
  } catch (err) {
    chat.messages.push({ role: 'assistant', content: 'Ошибка пайплайна: ' + err });
  }

  renderMessages();
  renderChatList();
  scheduleSave();
  document.getElementById('sendBtn').disabled = false;
});

document.getElementById('userInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('sendForm').requestSubmit();
  }
});

async function callNode(node, userContent) {
  const messages = [];
  if (node.systemPrompt) messages.push({ role: 'system', content: node.systemPrompt });
  messages.push({ role: 'user', content: userContent });
  return invoke('groq_chat', { model: node.model, messages });
}

async function runChain(chat, userText) {
  let currentInput = userText;
  const trace = [];
  for (const node of chat.nodes) {
    setNodeState(node.id, 'active');
    try {
      const result = await callNode(node, currentInput);
      setNodeState(node.id, 'done');
      trace.push(`[${node.name}] ${result}`);
      currentInput = result;
    } catch (err) {
      setNodeState(node.id, 'error');
      chat.messages.push({ role: 'assistant', content: `Ошибка в узле «${node.name}»: ${err}` });
      return;
    }
  }
  chat.messages.push({ role: 'assistant', content: currentInput, meta: trace.join('\n\n') });
}

async function runDelegate(chat, userText) {
  const promises = chat.nodes.map(async (node) => {
    setNodeState(node.id, 'active');
    try {
      const r = await callNode(node, userText);
      setNodeState(node.id, 'done');
      return { node, ok: true, result: r };
    } catch (err) {
      setNodeState(node.id, 'error');
      return { node, ok: false, result: String(err) };
    }
  });
  const results = await Promise.all(promises);
  let combined = '';
  for (const r of results) {
    combined += `【${r.node.name}】\n${r.result}\n\n`;
  }
  chat.messages.push({ role: 'assistant', content: combined.trim() });
}

async function runCollab(chat, userText) {
  const others = chat.nodes.filter(n => n.id !== chat.synthesizerId);
  const synth = chat.nodes.find(n => n.id === chat.synthesizerId) || chat.nodes[0];

  const promises = others.map(async (node) => {
    setNodeState(node.id, 'active');
    try {
      const r = await callNode(node, userText);
      setNodeState(node.id, 'done');
      return { node, ok: true, result: r };
    } catch (err) {
      setNodeState(node.id, 'error');
      return { node, ok: false, result: String(err) };
    }
  });
  const results = await Promise.all(promises);
  let combinedInputs = '';
  for (const r of results) {
    combinedInputs += `[${r.node.name}]: ${r.result}\n\n`;
  }

  setNodeState(synth.id, 'active');
  const synthPrompt = synth.systemPrompt || 'Ты — модель-синтезатор. Сведи ответы других моделей в один связный, лучший ответ на исходный вопрос пользователя.';
  try {
    const finalAnswer = await invoke('groq_chat', {
      model: synth.model,
      messages: [
        { role: 'system', content: synthPrompt },
        { role: 'user', content: `Вопрос пользователя:\n${userText}\n\nОтветы моделей:\n${combinedInputs}` }
      ]
    });
    setNodeState(synth.id, 'done');
    chat.messages.push({ role: 'assistant', content: finalAnswer, meta: combinedInputs.trim() });
  } catch (err) {
    setNodeState(synth.id, 'error');
    chat.messages.push({ role: 'assistant', content: 'Ошибка синтезатора: ' + err, meta: combinedInputs.trim() });
  }
}

// ---------------- utils ----------------
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

boot();
