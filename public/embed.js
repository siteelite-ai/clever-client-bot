(function() {
  // Cache-busting: если скрипт загружен без _v=, перезагружаем с timestamp
  var s = document.querySelector('script[src*="embed.js"]');
  if (s && !s.src.includes('_v=')) {
    var n = document.createElement('script');
    n.src = s.src + (s.src.includes('?') ? '&' : '?') + '_v=' + Math.floor(Date.now() / 300000);
    s.parentNode.removeChild(s);
    document.body.appendChild(n);
    return; // Прерывает выполнение ВСЕГО скрипта, включая виджет
  }
  'use strict';

  // Configuration
  const CONFIG = {
    supabaseUrl: 'https://supabase-proxy.bold-dawn-058f.workers.dev',
    supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InluZ29peG12bXhkZnhva3VhZmpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk2MTg0MzQsImV4cCI6MjA4NTE5NDQzNH0.bJTllxYOlRBqmnKqMAH21OkTBvXjqW4AaBLHz2fK2lQ',
    primaryColor: '#F5A623',
    logo: 'https://clever-client-bot.lovable.app/logo-220volt-widget.svg'
  };

  // Initial greeting message
  const initialGreeting = 'Здравствуйте! 👋 Я AI-консультант 220volt.kz. Помогу подобрать электроинструменты, расскажу о доставке и оплате. Что вас интересует?';

  // Generate unique session ID — persist across page navigations
  const STORAGE_KEY = 'volt_widget_state';
  let sessionId;
  let conversationHistory;
  let dialogSlots = {};
  
  // Try to restore from sessionStorage
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      sessionId = parsed.sessionId || ('session_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now());
      conversationHistory = parsed.history || [{ role: 'assistant', content: initialGreeting }];
      dialogSlots = parsed.dialogSlots || {};
    }
  } catch(e) {}
  
  if (!sessionId) {
    sessionId = 'session_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
  }
  if (!conversationHistory) {
    conversationHistory = [{ role: 'assistant', content: initialGreeting }];
  }
  
  let isOpen = false;
  let isLoading = false;

  // Thinking phrases for perceived latency reduction
  const PRODUCT_KEYWORDS = /розетк|кабел|автомат|щит|ламп|выключател|провод|удлинител|счётчик|счетчик|реле|контактор|дрел|шуруповёрт|шуруповерт|перфоратор|болгарк|пил[аеу]|насос|генератор|сварочн|компрессор|лобзик|фрез|гайковёрт|гайковерт|стабилизатор|трансформатор|инструмент|электро|плоскогубц|отвёртк|отвертк|рулетк|уровен|мультиметр|тестер|паяльник|фен|краскопульт|нож|диск|бур|свёрл|сверл|коронк|патрон|аккумулятор|зарядн|бензо|цепн|триммер|газонокосилк|мойк|пистолет/i;
  const THINKING_CATALOG = [
    'Сейчас подберу варианты',
    'Ищу в каталоге',
    'Секунду, смотрю наличие',
    'Подбираю подходящие товары',
    'Сейчас посмотрю, что есть',
  ];
  const THINKING_INFO = [
    'Сейчас проверю информацию',
    'Минутку, уточняю',
    'Секунду, проверю детали',
    'Сейчас найду ответ',
  ];
  function pickThinkingPhrase(msg) {
    var pool = PRODUCT_KEYWORDS.test(msg) ? THINKING_CATALOG : THINKING_INFO;
    return pool[Math.floor(Math.random() * pool.length)];
  }
  // Save state to sessionStorage
  function saveState() {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        sessionId: sessionId,
        history: conversationHistory.slice(-20),
        dialogSlots: dialogSlots
      }));
    } catch(e) {}
  }

  // Clean up any previous widget instance before initializing again
  var existingContainer = document.getElementById('volt-widget-container');
  if (existingContainer) {
    existingContainer.remove();
  }

  var existingStyles = document.getElementById('volt-widget-styles');
  if (existingStyles) {
    existingStyles.remove();
  }

  // Inject styles
  const styles = document.createElement('style');
  styles.id = 'volt-widget-styles';
  styles.textContent = `
    #volt-widget-container * {
      box-sizing: border-box;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    }
    
    #volt-widget-button {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background: linear-gradient(135deg, ${CONFIG.primaryColor} 0%, #E8941F 100%);
      border: none;
      cursor: pointer;
      box-shadow: 0 4px 20px rgba(245, 166, 35, 0.4);
      display: flex;
      align-items: center;
      justify-content: center;
      transition: transform 0.2s, box-shadow 0.2s;
      z-index: 999998;
    }
    
    #volt-widget-button:hover {
      transform: scale(1.05);
      box-shadow: 0 6px 25px rgba(245, 166, 35, 0.5);
    }
    
    #volt-widget-button svg {
      width: 28px;
      height: 28px;
      fill: white;
    }
    
    #volt-widget-window {
      position: fixed;
      bottom: 100px;
      right: 24px;
      width: 380px;
      height: 550px;
      background: #1a1a1a;
      border-radius: 16px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
      display: none;
      flex-direction: column;
      overflow: hidden;
      z-index: 999999;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    
    #volt-widget-window.open {
      display: flex;
      animation: voltSlideUp 0.3s ease-out;
    }
    
    @keyframes voltSlideUp {
      from {
        opacity: 0;
        transform: translateY(20px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }
    
    #volt-widget-header {
      background: #1a1a1a;
      padding: 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }
    
    .volt-header-left {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    
    .volt-header-title {
      color: white;
      font-size: 15px;
      font-weight: 600;
    }
    
    .volt-header-status {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    
    .volt-status-dot {
      width: 8px;
      height: 8px;
      background: #22c55e;
      border-radius: 50%;
      animation: voltPulse 2s infinite;
    }
    
    .volt-status-text {
      color: rgba(255, 255, 255, 0.6);
      font-size: 12px;
    }
    
    .volt-header-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    #volt-widget-logo {
      height: 28px;
    }
    
    #volt-widget-title {
      flex: 1;
      color: white;
      font-size: 16px;
      font-weight: 600;
    }
    
    #volt-widget-close {
      background: none;
      border: none;
      color: white;
      cursor: pointer;
      padding: 4px;
      opacity: 0.8;
      transition: opacity 0.2s;
    }
    
    #volt-widget-close:hover {
      opacity: 1;
    }
    
    #volt-widget-messages {
      flex: 1 1 auto;
      min-height: 0;
      max-height: 100%;
      overflow: auto;
      -webkit-overflow-scrolling: touch;
      overscroll-behavior-y: contain;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: #1a1a1a;
    }
    
    #volt-widget-messages::-webkit-scrollbar {
      width: 8px;
    }
    
    #volt-widget-messages::-webkit-scrollbar-track {
      background: #2a2a2a;
      border-radius: 4px;
    }
    
    #volt-widget-messages::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.3);
      border-radius: 4px;
    }
    
    #volt-widget-messages::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.5);
    }
    
    .volt-list-item {
      display: block;
      padding-left: 20px;
      text-indent: -12px;
      margin: 4px 0;
      line-height: 1.5;
    }
    
    .volt-list-main {
      margin-top: 12px;
      margin-bottom: 4px;
      padding-left: 0;
      text-indent: 0;
    }
    
    .volt-list-sub {
      margin: 2px 0;
      padding-left: 24px;
      text-indent: 0;
      color: #bbb;
      font-size: 13px;
    }
    
    .volt-list-item:first-child {
      margin-top: 8px;
    }
    
    .volt-message {
      max-width: 85%;
      padding: 12px 16px;
      border-radius: 12px;
      font-size: 14px;
      line-height: 1.5;
      word-wrap: break-word;
    }
    
    .volt-message.user {
      align-self: flex-end;
      background: ${CONFIG.primaryColor};
      color: white;
      border-bottom-right-radius: 4px;
    }
    
    .volt-message.assistant {
      align-self: flex-start;
      background: #2a2a2a;
      color: #e5e5e5;
      border-bottom-left-radius: 4px;
    }
    
    .volt-message.assistant a {
      color: ${CONFIG.primaryColor};
      text-decoration: none;
    }
    
    .volt-message.assistant a:hover {
      text-decoration: underline;
    }
    
    .volt-message.assistant strong {
      color: white;
    }
    
    .volt-product-card {
      background: #333;
      border-radius: 8px;
      padding: 12px;
      margin-top: 8px;
      border: 1px solid rgba(255, 255, 255, 0.1);
    }
    
    .volt-product-card:hover {
      border-color: ${CONFIG.primaryColor};
    }
    
    .volt-product-name {
      font-weight: 500;
      color: white;
      margin-bottom: 4px;
    }
    
    .volt-product-price {
      color: ${CONFIG.primaryColor};
      font-weight: 600;
    }
    
    .volt-typing {
      display: flex;
      gap: 4px;
      padding: 12px 16px;
      background: #2a2a2a;
      border-radius: 12px;
      align-self: flex-start;
      border-bottom-left-radius: 4px;
    }
    
    .volt-typing span {
      width: 8px;
      height: 8px;
      background: ${CONFIG.primaryColor};
      border-radius: 50%;
      animation: voltPulse 1.4s infinite ease-in-out;
      opacity: 0.4;
    }
    
    .volt-typing span:nth-child(1) { animation-delay: 0s; }
    .volt-typing span:nth-child(2) { animation-delay: 0.2s; }
    .volt-typing span:nth-child(3) { animation-delay: 0.4s; }
    
    @keyframes voltPulse {
      0%, 100% { opacity: 0.4; transform: scale(1); }
      50% { opacity: 1; transform: scale(1.1); }
    }
    
    #volt-widget-input-area {
      padding: 12px 16px;
      background: #242424;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    
    #volt-widget-input-row {
      display: flex;
      gap: 8px;
    }
    
    #volt-widget-char-counter {
      font-size: 11px;
      text-align: right;
      padding-right: 52px;
      color: #888;
      display: none;
    }
    
    #volt-widget-char-counter.warning {
      color: #F5A623;
    }
    
    #volt-widget-char-counter.danger {
      color: #ef4444;
    }
    
    #volt-widget-input {
      flex: 1;
      background: #333;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 8px;
      padding: 10px 14px;
      color: white;
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    
    #volt-widget-input::placeholder {
      color: #888;
    }
    
    #volt-widget-input:focus {
      border-color: ${CONFIG.primaryColor};
    }
    
    #volt-widget-send {
      background: ${CONFIG.primaryColor};
      border: none;
      border-radius: 8px;
      padding: 10px 14px;
      cursor: pointer;
      transition: background 0.2s;
    }
    
    #volt-widget-send:hover {
      background: #E8941F;
    }
    
    #volt-widget-send:disabled {
      background: #555;
      cursor: not-allowed;
    }
    
    #volt-widget-send svg {
      width: 20px;
      height: 20px;
      fill: white;
    }
    
    @media (max-width: 480px) {
      #volt-widget-window {
        width: calc(100% - 24px);
        height: calc(100% - 120px);
        right: 12px;
        bottom: 90px;
        border-radius: 12px;
      }
      
      #volt-widget-button {
        right: 16px;
        bottom: 16px;
        width: 56px;
        height: 56px;
      }
    }
  `;
  document.head.appendChild(styles);

  // Create widget container
  const container = document.createElement('div');
  container.id = 'volt-widget-container';
  container.innerHTML = `
    <button id="volt-widget-button" aria-label="Открыть чат">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
      </svg>
    </button>
    
    <div id="volt-widget-window">
      <div id="volt-widget-header">
        <div class="volt-header-left">
          <span class="volt-header-title">AI Консультант</span>
          <div class="volt-header-status">
            <span class="volt-status-dot"></span>
            <span class="volt-status-text">Онлайн</span>
          </div>
        </div>
        <div class="volt-header-right">
          <img id="volt-widget-logo" src="${CONFIG.logo}" alt="220volt">
          <button id="volt-widget-close" aria-label="Закрыть">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>
      </div>
      
      <div id="volt-widget-messages">
        <div class="volt-message assistant">
          Здравствуйте! 👋 Я AI-консультант 220volt.kz. Помогу подобрать электроинструменты, расскажу о доставке и оплате. Что вас интересует?
        </div>
      </div>
      
      <div id="volt-widget-input-area">
        <div id="volt-widget-input-row">
          <input 
            type="text" 
            id="volt-widget-input" 
            placeholder="Напишите сообщение..."
            autocomplete="off"
            maxlength="2000"
          >
          <button id="volt-widget-send" aria-label="Отправить">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        </div>
        <div id="volt-widget-char-counter"></div>
      </div>
    </div>
  `;
  document.body.appendChild(container);

  // Get elements
  const button = document.getElementById('volt-widget-button');
  const window = document.getElementById('volt-widget-window');
  const closeBtn = document.getElementById('volt-widget-close');
  const input = document.getElementById('volt-widget-input');
  const sendBtn = document.getElementById('volt-widget-send');
  const messagesContainer = document.getElementById('volt-widget-messages');

  // Force enable wheel scrolling (fix for Mac and sites that block it)
  messagesContainer.addEventListener('wheel', function(e) {
    // Prevent parent page from capturing scroll
    e.preventDefault();
    e.stopPropagation();
    
    // Manually handle scrolling
    this.scrollTop += e.deltaY;
  }, { passive: false });

  // Toggle widget
  function toggleWidget() {
    isOpen = !isOpen;
    window.classList.toggle('open', isOpen);
    if (isOpen) {
      input.focus();
    }
  }

  button.addEventListener('click', toggleWidget);
  closeBtn.addEventListener('click', toggleWidget);

  // Escape HTML to prevent XSS
  function escapeHtml(text) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }

  // Parse markdown-like formatting (only for assistant messages, input is pre-escaped)
  function formatMessage(text) {
    // First escape ALL HTML to prevent XSS
    let result = escapeHtml(text);
    
    // Now safely apply markdown formatting on escaped text
    // Handle links [text](url) - validate URL protocol (http, https, tel, mailto, viber)
    result = result.replace(/\[([^\]]+)\]\(((https?:\/\/|tel:|mailto:|viber:\/\/)[^)]+)\)/g, function(match, text, url) {
      var isExternal = url.startsWith('http');
      return '<a href="' + url + '"' + (isExternal ? ' target="_blank" rel="noopener"' : '') + '>' + text + '</a>';
    });
    
    // Handle bold **text**
    result = result.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    
    // Handle strikethrough ~~text~~
    result = result.replace(/~~(.*?)~~/g, '<s style="color:#888">$1</s>');
    
    // Handle numbered lists (1. 2. 3.) - main product items
    result = result.replace(/^(\d+)\.\s+(.+)$/gm, '<div class="volt-list-item volt-list-main">$1. $2</div>');
    
    // Handle sub-items with dash (- Цена: ...) - these are details
    result = result.replace(/^\s*[\-•]\s+(.+)$/gm, '<div class="volt-list-item volt-list-sub">• $1</div>');
    
    // Handle bullet lists with asterisks at line start (not sub-items)
    result = result.replace(/^\*\s+(.+)$/gm, '<div class="volt-list-item">• $1</div>');
    
    // Line breaks (but not after list items)
    result = result.replace(/\n/g, '<br>');
    
    // Clean up breaks around list items
    result = result.replace(/<br>(<div class="volt-list-item)/g, '$1');
    result = result.replace(/(<\/div>)<br>/g, '$1');
    
    // Clean up multiple consecutive breaks
    result = result.replace(/(<br>){3,}/g, '<br><br>');
    
    return result;
  }

  // Add message to chat (returns the DOM element)
  function addMessage(content, role) {
    const msg = document.createElement('div');
    msg.className = `volt-message ${role}`;
    if (role === 'user') {
      msg.textContent = content;
    } else {
      msg.innerHTML = formatMessage(content);
    }
    messagesContainer.appendChild(msg);
    if (role === 'user') {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    } else {
      msg.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return msg;
  }

  // Show typing indicator
  function showTyping() {
    const typing = document.createElement('div');
    typing.className = 'volt-typing';
    typing.id = 'volt-typing-indicator';
    typing.innerHTML = '<span></span><span></span><span></span>';
    messagesContainer.appendChild(typing);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  // Hide typing indicator
  function hideTyping() {
    const typing = document.getElementById('volt-typing-indicator');
    if (typing) typing.remove();
  }

  // Parse SSE lines from a text buffer, returns { lines: string[], remaining: string }
  function parseSSELines(buffer) {
    var lines = [];
    var remaining = buffer;
    var idx;
    while ((idx = remaining.indexOf('\n')) !== -1) {
      var line = remaining.slice(0, idx);
      remaining = remaining.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      lines.push(line);
    }
    return { lines: lines, remaining: remaining };
  }

  // Try streaming from a single endpoint, updating msgEl progressively
  // onFirstToken is called when the first token arrives (to hide typing indicator)
  async function tryStreamEndpoint(baseUrl, message, label, msgEl, onFirstToken) {
    var url = baseUrl + '/functions/v1/chat-consultant';
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 90000);

    // Clean slots: only send pending, max 3
    var activeSlots = {};
    var slotCount = 0;
    for (var sk in dialogSlots) {
      if (dialogSlots[sk].status === 'pending' && slotCount < 3) {
        activeSlots[sk] = dialogSlots[sk];
        slotCount++;
      }
    }

    var response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + CONFIG.supabaseKey,
        'apikey': CONFIG.supabaseKey
      },
      body: JSON.stringify({
        message: message,
        sessionId: sessionId,
        history: conversationHistory.slice(-10),
        stream: true,
        dialogSlots: activeSlots
      }),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(label + ' HTTP ' + response.status);
    }

    // Check if we actually got a streaming response
    var contentType = response.headers.get('content-type') || '';
    if (contentType.indexOf('event-stream') === -1) {
      // Non-streaming response (proxy might not support SSE) — parse as JSON
      var text = await response.text();
      var data;
      try { data = JSON.parse(text); } catch(e) { throw new Error(label + ' invalid JSON'); }
      if (data.error) throw new Error(label + ': ' + data.error);
      if (!data.content) throw new Error(label + ': empty content');
      onFirstToken();
      return { content: data.content, contacts: data.contacts || null };
    }

    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var textBuffer = '';
    var fullContent = '';
    var contacts = null;
    var done = false;
    var lastScrollTime = 0;
    var firstTokenReceived = false;

    while (!done) {
      var chunk = await reader.read();
      if (chunk.done) break;
      textBuffer += decoder.decode(chunk.value, { stream: true });

      var parsed = parseSSELines(textBuffer);
      textBuffer = parsed.remaining;

      for (var i = 0; i < parsed.lines.length; i++) {
        var line = parsed.lines[i];
        if (line.startsWith(':') || line.trim() === '') continue;
        if (!line.startsWith('data: ')) continue;

        var jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') {
          done = true;
          // Drain remaining data from reader (slot_update may come after [DONE])
          while (true) {
            var extra = await reader.read();
            if (extra.done) break;
            textBuffer += decoder.decode(extra.value, { stream: true });
          }
          break;
        }

        try {
          var obj = JSON.parse(jsonStr);
          // Check for contacts event
          if (obj.contacts) {
            contacts = obj.contacts;
            continue;
          }
          // Handle slot_update event
          if (obj.slot_update) {
            dialogSlots = obj.slot_update;
            saveState();
            continue;
          }
          var delta = obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content;
          if (delta) {
            if (!firstTokenReceived) {
              firstTokenReceived = true;
              onFirstToken();
            }
            fullContent += delta;
            msgEl.innerHTML = formatMessage(fullContent);
            var now = Date.now();
            if (now - lastScrollTime > 300) {
              lastScrollTime = now;
              messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }
          }
        } catch (e) {
          // If JSON parse fails, put this line AND all remaining unparsed lines back into buffer
          var remainingLines = parsed.lines.slice(i).join('\n');
          textBuffer = remainingLines + (textBuffer ? '\n' + textBuffer : '');
          break;
        }
      }
    }

    // Final flush
    if (textBuffer.trim()) {
      var leftover = textBuffer.split('\n');
      for (var j = 0; j < leftover.length; j++) {
        var raw = leftover[j];
        if (!raw) continue;
        if (raw.endsWith('\r')) raw = raw.slice(0, -1);
        if (raw.startsWith(':') || raw.trim() === '') continue;
        if (!raw.startsWith('data: ')) continue;
        var js2 = raw.slice(6).trim();
        if (js2 === '[DONE]') continue;
        try {
          var o2 = JSON.parse(js2);
          if (o2.contacts) { contacts = o2.contacts; continue; }
          if (o2.slot_update) { dialogSlots = o2.slot_update; saveState(); continue; }
          var d2 = o2.choices && o2.choices[0] && o2.choices[0].delta && o2.choices[0].delta.content;
          if (d2) {
            fullContent += d2;
            msgEl.innerHTML = formatMessage(fullContent);
          }
        } catch(e) {}
      }
    }

    if (!fullContent) throw new Error(label + ': empty streaming content');
    return { content: fullContent, contacts: contacts };
  }

  // Fallback: non-streaming fetch
  async function tryNonStreamEndpoint(baseUrl, message, label) {
    var url = baseUrl + '/functions/v1/chat-consultant';
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 60000);

    var response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + CONFIG.supabaseKey,
        'apikey': CONFIG.supabaseKey
      },
      body: JSON.stringify({
        message: message,
        sessionId: sessionId,
        history: conversationHistory.slice(-10),
        stream: false,
        dialogSlots: dialogSlots
      }),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!response.ok) {
      throw new Error(label + ' HTTP ' + response.status);
    }

    var text = await response.text();
    var data;
    try { data = JSON.parse(text); } catch(e) { throw new Error(label + ' invalid JSON'); }
    if (data.error) throw new Error(label + ': ' + data.error);
    if (!data.content) throw new Error(label + ': empty content');
    if (data.slot_update) { dialogSlots = data.slot_update; saveState(); }
    return { content: data.content, contacts: data.contacts || null };
  }

  // Send message with streaming + fallback
  async function sendMessage() {
    var message = input.value.trim();
    if (!message || isLoading) return;

    isLoading = true;
    input.value = '';
    sendBtn.disabled = true;

    addMessage(message, 'user');
    conversationHistory.push({ role: 'user', content: message });
    saveState();

    // Step 1: Show typing animation (dots only) briefly
    var thinkingPhrase = pickThinkingPhrase(message);
    var typingIndicator = document.createElement('div');
    typingIndicator.className = 'volt-message assistant';
    typingIndicator.id = 'volt-typing-indicator';
    typingIndicator.innerHTML = '<div class="volt-typing" style="background:transparent;padding:4px 0;"><span></span><span></span><span></span></div>';
    messagesContainer.appendChild(typingIndicator);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    // Step 2: After brief delay, replace typing with thinking phrase (message 1) + new typing below
    await new Promise(function(r) { setTimeout(r, 800); });
    var typingEl1 = document.getElementById('volt-typing-indicator');
    if (typingEl1) typingEl1.remove();

    // Insert thinking phrase as permanent message 1
    var thinkingMsg = document.createElement('div');
    thinkingMsg.className = 'volt-message assistant';
    thinkingMsg.id = 'volt-thinking-phrase';
    thinkingMsg.innerHTML = formatMessage(thinkingPhrase);
    messagesContainer.appendChild(thinkingMsg);

    // Show new typing animation below for the real response
    var typingIndicator2 = document.createElement('div');
    typingIndicator2.className = 'volt-message assistant';
    typingIndicator2.id = 'volt-typing-indicator-2';
    typingIndicator2.innerHTML = '<div class="volt-typing" style="background:transparent;padding:4px 0;"><span></span><span></span><span></span></div>';
    messagesContainer.appendChild(typingIndicator2);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    // For streaming: try direct Supabase first (supports SSE), proxy buffers SSE
    // For non-streaming fallback: try proxy first (works in Russia)
    var streamEndpoints = [
      { url: 'https://yngoixmvmxdfxokuafjp.supabase.co', label: 'direct' },
      { url: CONFIG.supabaseUrl, label: 'proxy' }
    ];
    var fallbackEndpoints = [
      { url: CONFIG.supabaseUrl, label: 'proxy' },
      { url: 'https://yngoixmvmxdfxokuafjp.supabase.co', label: 'direct' }
    ];

    // Create assistant message element for streaming
    var assistantMsg = document.createElement('div');
    assistantMsg.className = 'volt-message assistant';
    assistantMsg.innerHTML = '';
    var msgInserted = false;

    var result = null;
    var lastError = null;

    // Try streaming first (direct Supabase → proxy)
    for (var i = 0; i < streamEndpoints.length; i++) {
      try {
        result = await tryStreamEndpoint(streamEndpoints[i].url, message, streamEndpoints[i].label, assistantMsg, function() {
          // Called on first token — remove typing indicator, show real message
          var typingEl2 = document.getElementById('volt-typing-indicator-2');
          if (typingEl2) typingEl2.remove();
          if (!msgInserted) {
            messagesContainer.appendChild(assistantMsg);
            assistantMsg.scrollIntoView({ behavior: 'smooth', block: 'start' });
            msgInserted = true;
          }
        });
        break;
      } catch (err) {
        lastError = err;
        // Remove if inserted but failed mid-stream
        if (assistantMsg.parentNode && !assistantMsg.innerHTML) assistantMsg.remove();
        msgInserted = false;
      }
    }

    // Fallback to non-streaming if streaming failed (proxy → direct)
    if (!result) {
      for (var k = 0; k < fallbackEndpoints.length; k++) {
        try {
          result = await tryNonStreamEndpoint(fallbackEndpoints[k].url, message, fallbackEndpoints[k].label);
          break;
        } catch (err) {
          lastError = err;
        }
      }
    }

    var typingEl2 = document.getElementById('volt-typing-indicator-2');
    if (typingEl2) typingEl2.remove();

    if (result) {
      if (!msgInserted) {
        messagesContainer.appendChild(assistantMsg);
        msgInserted = true;
      }
      assistantMsg.innerHTML = formatMessage(result.content);
      assistantMsg.scrollIntoView({ behavior: 'smooth', block: 'start' });
      conversationHistory.push({ role: 'assistant', content: result.content });
      saveState();

      if (result.contacts) {
        addMessage(result.contacts, 'assistant');
      }
    } else {
      hideTyping();
      addMessage('Извините, произошла ошибка соединения. Попробуйте позже.', 'assistant');
    }

    isLoading = false;
    sendBtn.disabled = false;
    try { input.focus(); } catch(e) {}
  }

  // Character counter
  var charCounter = document.getElementById('volt-widget-char-counter');
  input.addEventListener('input', function() {
    var len = input.value.length;
    if (len > 1800) {
      charCounter.textContent = len + '/2000';
      charCounter.style.display = 'block';
      charCounter.className = len >= 2000 ? 'danger' : 'warning';
      sendBtn.disabled = len >= 2000 || !input.value.trim();
    } else {
      charCounter.style.display = 'none';
      sendBtn.disabled = !input.value.trim();
    }
  });

  // Event listeners
  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') {
      sendMessage();
    }
  });

  // Expose API
  window.Widget220volt = {
    open: function() { if (!isOpen) toggleWidget(); },
    close: function() { if (isOpen) toggleWidget(); },
    toggle: toggleWidget
  };
})();
