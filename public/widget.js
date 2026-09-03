(function() {
  'use strict';

  // Widget version — для диагностики устаревших встраиваний на чужих сайтах
  var WIDGET_VERSION = 'widget-d8da5cc307f128a5';
  try { console.info('[Widget] v=' + WIDGET_VERSION); } catch(e) {}

  // Configuration
  const CONFIG = {
    supabaseUrl: 'https://supabase-proxy.bold-dawn-058f.workers.dev',
    supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InluZ29peG12bXhkZnhva3VhZmpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk2MTg0MzQsImV4cCI6MjA4NTE5NDQzNH0.bJTllxYOlRBqmnKqMAH21OkTBvXjqW4AaBLHz2fK2lQ',
    primaryColor: '#F5A623',
    logo: 'https://clever-client-bot.lovable.app/logo-220volt-widget.svg',
    // Direct origin used both for widget-config (no proxy) and as a streaming target.
    directOrigin: 'https://yngoixmvmxdfxokuafjp.supabase.co'
  };

  // V3-only routing. All widget traffic goes to chat-consultant-v3 unconditionally.
  // V1/V2 are deprecated for the widget — no widget-config call, no fallback, no race.
  var activePipeline = 'v3';
  var activePipelineReady = true;
  function pipelinePath() { return '/functions/v1/chat-consultant-v3'; }
  function fetchActivePipeline() { return Promise.resolve(); }

  // Initial greeting message
  const initialGreeting = 'Здравствуйте! 👋 Я AI-консультант 220volt.kz. Помогу подобрать электроинструменты, расскажу о доставке и оплате. Что вас интересует?';

  // Generate unique session ID — persist across page navigations
  const STORAGE_KEY = 'volt_widget_state';
  // Не переносим скрытый контекст через длительный перерыв или восстановление
  // старой вкладки браузером. Короткая навигация по каталогу сохраняет диалог.
  const SESSION_TTL_MS = 30 * 60 * 1000;
  const SESSION_FUTURE_SKEW_MS = 5 * 60 * 1000;
  let sessionId;
  let conversationHistory;
  let dialogSlots = {};
  let lastActivityAt = 0;
  // Стабильный UUID одного сообщения для валидации, журналирования и будущей дедупликации.
  let currentMessageId = '';
  function generateMessageId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === 'function') {
        return window.crypto.randomUUID();
      }
      var bytes = new Uint8Array(16);
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        window.crypto.getRandomValues(bytes);
      } else {
        for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      }
      bytes[6] = (bytes[6] & 15) | 64;
      bytes[8] = (bytes[8] & 63) | 128;
      var hex = Array.prototype.map.call(bytes, function(byte) {
        return byte.toString(16).padStart(2, '0');
      }).join('');
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
        hex.slice(16, 20) + '-' + hex.slice(20);
    } catch(e) {
      // messageId is an idempotency key, not an authentication secret.
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(char) {
        var random = Math.floor(Math.random() * 16);
        var value = char === 'x' ? random : ((random & 3) | 8);
        return value.toString(16);
      });
    }
  }
  function newSessionId() {
    return 'session_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
  }
  function isValidSessionId(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
      /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
  }
  function isPlainRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    var proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }
  function sanitizeHistory(value) {
    if (!Array.isArray(value)) return [];
    var cleaned = [];
    var totalChars = 0;
    for (var i = value.length - 1; i >= 0 && cleaned.length < 20; i--) {
      var item = value[i];
      if (!isPlainRecord(item) || (item.role !== 'user' && item.role !== 'assistant') ||
          typeof item.content !== 'string') continue;
      var content = item.content.trim();
      var maxChars = item.role === 'user' ? 2000 : 8000;
      if (!content || content.length > maxChars || totalChars + content.length > 32000) continue;
      cleaned.unshift({ role: item.role, content: content });
      totalChars += content.length;
    }
    return cleaned;
  }
  function sanitizeDialogSlots(value) {
    if (!isPlainRecord(value)) return {};
    var forbidden = Object.create(null);
    forbidden.__proto__ = true;
    forbidden.constructor = true;
    forbidden.prototype = true;
    var budget = { nodes: 0 };
    function cloneJson(input, depth) {
      budget.nodes++;
      if (budget.nodes > 1000 || depth > 12) throw new Error('slots too complex');
      if (input === null || typeof input === 'string' || typeof input === 'boolean') return input;
      if (typeof input === 'number' && Number.isFinite(input)) return input;
      if (Array.isArray(input)) return input.map(function(child) { return cloneJson(child, depth + 1); });
      if (!isPlainRecord(input)) throw new Error('slots contain invalid value');
      var keys = Object.keys(input);
      if (keys.length > 100) throw new Error('slots contain too many keys');
      var output = Object.create(null);
      for (var i = 0; i < keys.length; i++) {
        if (forbidden[keys[i]]) throw new Error('slots contain forbidden key');
        output[keys[i]] = cloneJson(input[keys[i]], depth + 1);
      }
      return output;
    }
    try {
      var result = cloneJson(value, 0);
      if (JSON.stringify(result).length > 16000) return {};
      return result;
    } catch(e) {
      return {};
    }
  }
  function hasUserMessages(history) {
    return Array.isArray(history) && history.some(function(message) {
      return message && message.role === 'user';
    });
  }
  function isRecentStoredState(value, now) {
    if (!isPlainRecord(value) || !Number.isFinite(value.updatedAt)) return false;
    if (value.updatedAt <= 0 || value.updatedAt > now + SESSION_FUTURE_SKEW_MS) return false;
    return now - value.updatedAt <= SESSION_TTL_MS;
  }
  function resetConversationState() {
    sessionId = newSessionId();
    conversationHistory = [{ role: 'assistant', content: initialGreeting }];
    dialogSlots = {};
    currentMessageId = '';
    lastActivityAt = Date.now();
  }
  // Try to restore from sessionStorage
  try {
    const saved = sessionStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      const now = Date.now();
      if (isRecentStoredState(parsed, now) && isValidSessionId(parsed.sessionId)) {
        sessionId = parsed.sessionId;
        conversationHistory = sanitizeHistory(parsed.history);
        dialogSlots = sanitizeDialogSlots(parsed.dialogSlots);
        lastActivityAt = parsed.updatedAt;
        if (!conversationHistory.length || !hasUserMessages(conversationHistory)) {
          resetConversationState();
        }
      } else {
        // Legacy-состояние без updatedAt и просроченный диалог сбрасываются.
        sessionStorage.removeItem(STORAGE_KEY);
        resetConversationState();
      }
    }
  } catch(e) {}
  
  if (!sessionId) {
    sessionId = newSessionId();
  }
  if (!conversationHistory) {
    conversationHistory = [{ role: 'assistant', content: initialGreeting }];
  }
  if (!lastActivityAt) {
    lastActivityAt = Date.now();
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
  // Возвращает фразу ТОЛЬКО для каталожных запросов; иначе null (показываем только typing-точки).
  function pickThinkingPhrase(msg) {
    if (!PRODUCT_KEYWORDS.test(msg)) return null;
    return THINKING_CATALOG[Math.floor(Math.random() * THINKING_CATALOG.length)];
  }
  // Save state to sessionStorage
  function saveState() {
    try {
      conversationHistory = sanitizeHistory(conversationHistory);
      dialogSlots = sanitizeDialogSlots(dialogSlots);
      lastActivityAt = Date.now();
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        sessionId: sessionId,
        history: conversationHistory.slice(-20),
        dialogSlots: dialogSlots,
        updatedAt: lastActivityAt
      }));
    } catch(e) {}
  }

  async function createHttpError(response, label) {
    var detail = '';
    var errorCode = '';
    var issues = [];
    try {
      var responseText = (await response.text()).slice(0, 2000);
      detail = responseText;
      try {
        var errorBody = JSON.parse(responseText);
        errorCode = typeof errorBody.code === 'string' ? errorBody.code : '';
        issues = Array.isArray(errorBody.issues) ? errorBody.issues.slice(0, 10) : [];
        detail = typeof errorBody.error === 'string' ? errorBody.error : responseText;
      } catch(e) {}
    } catch(e) {}
    var error = new Error(label + ' HTTP ' + response.status + (detail ? ': ' + detail : ''));
    error.status = response.status;
    error.code = errorCode;
    error.issues = issues;
    return error;
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
    
    #volt-widget-new-chat,
    #volt-widget-close {
      background: none;
      border: none;
      color: white;
      cursor: pointer;
      padding: 4px;
      opacity: 0.8;
      transition: opacity 0.2s;
    }
    
    #volt-widget-new-chat:hover,
    #volt-widget-close:hover {
      opacity: 1;
    }

    #volt-widget-new-chat:disabled {
      cursor: not-allowed;
      opacity: 0.3;
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
    
    .volt-list-product {
      display: flex;
      align-items: baseline;
      gap: 6px;
      margin-top: 14px;
      margin-bottom: 4px;
      padding-left: 0;
      text-indent: 0;
      font-weight: 500;
      overflow-wrap: anywhere;
    }
    .volt-list-product::before {
      content: "•";
      flex: 0 0 auto;
      color: ${CONFIG.primaryColor};
      font-weight: 700;
      line-height: 1.2;
    }

    .volt-list-sub {
      display: flex;
      align-items: baseline;
      gap: 6px;
      margin: 2px 0 2px 16px;
      padding-left: 0;
      text-indent: 0;
      color: #bbb;
      font-size: 13px;
      overflow-wrap: anywhere;
    }
    .volt-list-sub::before {
      content: "•";
      flex: 0 0 auto;
      color: #888;
      line-height: 1.2;
    }

    .volt-card-detail {
      display: block;
      margin: 4px 0 4px 16px;
      padding-left: 0;
      color: #d8d8d8;
      font-size: 15px;
      line-height: 1.55;
    }
    .volt-card-detail .volt-card-label {
      color: #a8a8a8;
      margin-right: 6px;
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

    .volt-topic-divider {
      align-self: stretch;
      display: flex;
      align-items: center;
      gap: 10px;
      color: rgba(255, 255, 255, 0.55);
      font-size: 11px;
      line-height: 1;
      margin: 4px 0;
    }

    .volt-topic-divider::before,
    .volt-topic-divider::after {
      content: '';
      flex: 1;
      height: 1px;
      background: rgba(255, 255, 255, 0.12);
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
          <button id="volt-widget-new-chat" aria-label="Новый диалог" title="Новый диалог">
            <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8"/>
              <path d="M3 3v5h5"/>
            </svg>
          </button>
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
  const newChatBtn = document.getElementById('volt-widget-new-chat');
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
    if (isOpen) expireConversationIfNeeded(false);
    window.classList.toggle('open', isOpen);
    if (isOpen) {
      input.focus();
    }
  }

  button.addEventListener('click', toggleWidget);
  closeBtn.addEventListener('click', toggleWidget);
  newChatBtn.addEventListener('click', function() {
    if (isLoading) return;
    if (hasUserMessages(conversationHistory) && typeof globalThis.confirm === 'function' &&
        !globalThis.confirm('Начать новый диалог? Текущая история будет очищена.')) return;
    resetVisibleConversation(false);
  });

  // Escape HTML to prevent XSS
  function escapeHtml(text) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(text));
    return div.innerHTML;
  }

  // Strip repeated greetings from assistant responses
  function stripGreeting(text) {
    return text.replace(/^(?:Здравствуйте[.!]?\s*|Добрый\s+(?:день|вечер|утро)[.!,]?\s*|Привет[.!,]?\s*|Приветствую[.!,]?\s*)/i, '').trim();
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

    // Handle bold __text__ (underscore variant)
    result = result.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');

    // Handle strikethrough ~~text~~
    result = result.replace(/~~(.*?)~~/g, '<s style="color:#888">$1</s>');

    // Handle numbered lists (1. 2. 3.) - main product items
    result = result.replace(/^(\d+)\.\s+(.+)$/gm, '<div class="volt-list-item volt-list-main">$1. $2</div>');

    // Card detail lines: indented "Цена: ...", "Бренд: ...", "Наличие: ...", "Артикул: ..."
    // рендер вставляет их с 2-пробельным отступом под пунктом карточки
    result = result.replace(/^(?:[ ]{2,}|\t+)(Цена|Бренд|Наличие|Артикул|Мощность|Цвет|Модель|Гарантия|Производитель)\s*:\s*(.+)$/gm,
      '<div class="volt-card-detail"><span class="volt-card-label">$1:</span>$2</div>');

    // Nested sub-items (≥2 leading spaces or tab). Точка добавляется CSS ::before.
    result = result.replace(/^(?:[ ]{2,}|\t+)[\-•]\s+(.+)$/gm, '<div class="volt-list-item volt-list-sub">$1</div>');
    // Root-level dash items — карточка товара. Точка добавляется CSS ::before.
    result = result.replace(/^[\-•]\s+(.+)$/gm, '<div class="volt-list-item volt-list-product">$1</div>');

    // Handle bullet lists with asterisks at line start (not sub-items)
    result = result.replace(/^\*\s+(.+)$/gm, '<div class="volt-list-item">• $1</div>');

    // Handle italic *text* (after bullets, so leading "* " bullets are already consumed).
    // Skip if the asterisk is glued to a word boundary like ** (already handled) — non-greedy, no newlines, no asterisks inside.
    result = result.replace(/(^|[^\*\w])\*([^\*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');

    // Handle italic _text_ (underscore variant) — LLM/ReactMarkdown-style.
    // Match только на не-word границах, чтобы не портить URL/идентификаторы (foo_bar).
    result = result.replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
    
    // Unescape backslash-escaped markdown punctuation that LLM may emit in product names
    // e.g. "\(серия Florence\)" → "(серия Florence)"
    result = result.replace(/\\([()\[\]_*~`\\])/g, '$1');
    
    // Line breaks (but not after list items)
    result = result.replace(/\n/g, '<br>');
    
    // Clean up breaks around list items и card-detail блоков
    result = result.replace(/<br>(<div class="(?:volt-list-item|volt-card-detail))/g, '$1');
    result = result.replace(/(<\/div>)<br>/g, '$1');
    
    // Clean up multiple consecutive breaks
    result = result.replace(/(<br>){3,}/g, '<br><br>');
    
    return result;
  }

  function createMessageElement(content, role) {
    const msg = document.createElement('div');
    msg.className = `volt-message ${role}`;
    if (role === 'user') {
      msg.textContent = content;
    } else {
      msg.innerHTML = formatMessage(content);
    }
    return msg;
  }

  // Add message to chat (returns the DOM element)
  function addMessage(content, role) {
    const msg = createMessageElement(content, role);
    messagesContainer.appendChild(msg);
    if (role === 'user') {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    } else {
      msg.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    return msg;
  }

  function renderConversationHistory() {
    const safeHistory = sanitizeHistory(conversationHistory);
    messagesContainer.textContent = '';
    for (var i = 0; i < safeHistory.length; i++) {
      messagesContainer.appendChild(createMessageElement(safeHistory[i].content, safeHistory[i].role));
    }
    if (!safeHistory.length) {
      messagesContainer.appendChild(createMessageElement(initialGreeting, 'assistant'));
    }
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function resetVisibleConversation(preserveInput) {
    var draft = preserveInput ? input.value : '';
    resetConversationState();
    saveState();
    renderConversationHistory();
    input.value = draft;
    if (charCounter) {
      charCounter.textContent = '';
      charCounter.style.display = 'none';
      charCounter.className = '';
    }
    sendBtn.disabled = !draft.trim();
    return true;
  }

  // The server can isolate a self-contained new request before routing it.
  // Keep old bubbles visible for orientation, but persist and send only the new
  // topic. The user does not need to close incognito or press "Новый диалог".
  function applyAutomaticConversationBoundary(nextSessionId, currentMessage) {
    if (!isValidSessionId(nextSessionId) || nextSessionId === sessionId) return false;
    sessionId = nextSessionId;
    dialogSlots = {};
    conversationHistory = [
      { role: 'assistant', content: initialGreeting },
      { role: 'user', content: currentMessage }
    ];
    saveState();

    var userMessages = messagesContainer.querySelectorAll('.volt-message.user');
    var currentUserBubble = userMessages.length ? userMessages[userMessages.length - 1] : null;
    if (currentUserBubble && currentUserBubble.previousElementSibling &&
        currentUserBubble.previousElementSibling.classList.contains('volt-topic-divider')) return true;
    if (currentUserBubble) {
      var divider = document.createElement('div');
      divider.className = 'volt-topic-divider';
      divider.setAttribute('role', 'separator');
      divider.setAttribute('aria-label', 'Новая тема');
      divider.textContent = 'Новая тема';
      messagesContainer.insertBefore(divider, currentUserBubble);
    }
    return true;
  }

  function expireConversationIfNeeded(preserveInput) {
    if (!hasUserMessages(conversationHistory)) return false;
    var now = Date.now();
    var expired = !Number.isFinite(lastActivityAt) || lastActivityAt <= 0 ||
      lastActivityAt > now + SESSION_FUTURE_SKEW_MS || now - lastActivityAt > SESSION_TTL_MS;
    if (!expired || isLoading) return false;
    return resetVisibleConversation(preserveInput);
  }

  // Восстановленный контекст обязан быть видимым: не отправляем модели историю,
  // которой пользователь не видит в окне чата.
  renderConversationHistory();

  function addDiagnosticLabel(target, logId, isPartial) {
    if (!target || (!logId && !isPartial)) return;
    var label = document.createElement('div');
    label.style.cssText = 'margin-top:8px;padding-top:6px;border-top:1px solid rgba(0,0,0,.08);font-size:10px;line-height:1.3;color:#777;user-select:text;';
    var parts = [];
    if (isPartial) parts.push('Ответ получен не полностью');
    parts.push('Версия: ' + WIDGET_VERSION);
    if (logId) parts.push('Код запроса: ' + logId);
    label.textContent = parts.join(' · ');
    target.appendChild(label);
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
  // onFirstToken — вызывается при первом токене (убрать typing).
  // onProductsBlock — возвращает НОВЫЙ пузырь для карточек (разделение intro и списка).
  async function tryStreamEndpoint(baseUrl, message, label, msgEl, onFirstToken, onProductsBlock, resumeOnly) {
    if (!activePipelineReady) await fetchActivePipeline();
    var url = baseUrl + pipelinePath();
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 90000);

    // Clean slots: only send pending, max 3
    var activeSlots = {};
    var slotCount = 0;
    for (var sk in dialogSlots) {
      if (isPlainRecord(dialogSlots[sk]) && dialogSlots[sk].status === 'pending' && slotCount < 3) {
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
        messageId: currentMessageId,
        history: conversationHistory.slice(-10),
        stream: true,
        resumeOnly: Boolean(resumeOnly),
        dialogSlots: activeSlots
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      clearTimeout(timer);
      throw await createHttpError(response, label);
    }

    // Check if we actually got a streaming response
    var contentType = response.headers.get('content-type') || '';
    var reader;
    if (contentType.indexOf('event-stream') === -1) {
      // Some intermediaries preserve the SSE payload but rewrite its content
      // type. Detect the protocol from the body before treating it as JSON.
      var text = await response.text();
      if (!/^\s*(?::[^\n]*\n|data:\s*)/u.test(text)) {
        clearTimeout(timer);
        var data;
        try { data = JSON.parse(text); } catch(e) { throw new Error(label + ' invalid JSON'); }
        if (data.error) throw new Error(label + ': ' + data.error);
        if (!data.content) throw new Error(label + ': empty content');
        onFirstToken();
        return { content: data.content, contacts: data.contacts || null };
      }
      var preloaded = text;
      reader = {
        read: async function() {
          if (preloaded === null) return { done: true, value: undefined };
          var value = preloaded;
          preloaded = null;
          return { done: false, value: value };
        }
      };
    } else {
      reader = response.body.getReader();
    }

    var decoder = new TextDecoder();
    var textBuffer = '';
    var introContent = '';
    var productsContent = '';
    var currentEl = msgEl;
    var mode = 'intro'; // 'intro' → 'products' после первого products_block
    var contacts = null;
    var done = false;
    var lastScrollTime = 0;
    var firstTokenReceived = false;
    var diagnosticLogId = null;
    var diagnosticComplete = false;
    var diagnosticProductsCount = null;

    function appendDelta(delta) {
      if (mode === 'intro') {
        introContent += delta;
        currentEl.innerHTML = formatMessage(stripGreeting(introContent));
      } else {
        productsContent += delta;
        currentEl.innerHTML = formatMessage(stripGreeting(productsContent));
      }
    }

    function handleProductsBlock(md) {
      // Первый products_block — если есть intro-текст, открываем НОВЫЙ пузырь для карточек
      if (mode === 'intro') {
        mode = 'products';
        if (introContent.trim() && typeof onProductsBlock === 'function') {
          var newEl = onProductsBlock();
          if (newEl) currentEl = newEl;
        }
      }
      productsContent += (productsContent ? '\n\n' : '') + md;
      currentEl.innerHTML = formatMessage(stripGreeting(productsContent));
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    var streamReadError = null;
    try {
      while (!done) {
        var chunk = await reader.read();
        if (chunk.done) break;
        textBuffer += typeof chunk.value === 'string'
          ? chunk.value
          : decoder.decode(chunk.value, { stream: true });

        var parsed = parseSSELines(textBuffer);
        textBuffer = parsed.remaining;

        for (var i = 0; i < parsed.lines.length; i++) {
        var line = parsed.lines[i];
        if (line.startsWith(':') || line.trim() === '') continue;
        if (!line.startsWith('data: ')) continue;

        var jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') {
          done = true;
          while (true) {
            var extra = await reader.read();
            if (extra.done) break;
            textBuffer += decoder.decode(extra.value, { stream: true });
          }
          break;
        }

        try {
          var obj = JSON.parse(jsonStr);
          if (obj.v3_event) {
            var ev = obj.v3_event;
            if (ev.type === 'diagnostic') {
              diagnosticLogId = ev.log_id || diagnosticLogId;
              if (ev.phase === 'complete') {
                diagnosticComplete = true;
                diagnosticProductsCount = typeof ev.products_count === 'number' ? ev.products_count : null;
              }
              try { console.info('[Widget] request=' + (diagnosticLogId || 'unavailable') + ' phase=' + ev.phase + ' products=' + (diagnosticProductsCount == null ? '?' : diagnosticProductsCount)); } catch(e) {}
              continue;
            }
            if (ev.type === 'contacts') { contacts = ev.html; continue; }
            if (ev.type === 'conversation_boundary' && ev.mode === 'new_task') {
              applyAutomaticConversationBoundary(ev.session_id, message);
              continue;
            }
            if (ev.type === 'slot_update') { dialogSlots = ev.slots || {}; saveState(); continue; }
            if (ev.type === 'products_block' && ev.markdown) {
              if (!firstTokenReceived) { firstTokenReceived = true; onFirstToken(); }
              handleProductsBlock(ev.markdown);
              continue;
            }
            if (ev.type === 'assistant_turn_break' || ev.type === 'tool_event' || ev.type === 'quick_replies') continue;
          }
          if (obj.contacts) { contacts = obj.contacts; continue; }
          if (obj.slot_update) { dialogSlots = obj.slot_update; saveState(); continue; }
          var delta = obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content;
          if (delta) {
            if (!firstTokenReceived) { firstTokenReceived = true; onFirstToken(); }
            appendDelta(delta);
            var now = Date.now();
            if (now - lastScrollTime > 300) {
              lastScrollTime = now;
              messagesContainer.scrollTop = messagesContainer.scrollHeight;
            }
          }
        } catch (e) {
          var remainingLines = parsed.lines.slice(i).join('\n');
          textBuffer = remainingLines + (textBuffer ? '\n' + textBuffer : '');
          break;
        }
        }
      }
    } catch (readError) {
      streamReadError = readError;
    }
    clearTimeout(timer);

    // Final flush
    try {
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
            if (o2.v3_event) {
              var ev2 = o2.v3_event;
              if (ev2.type === 'diagnostic') {
                diagnosticLogId = ev2.log_id || diagnosticLogId;
                if (ev2.phase === 'complete') {
                  diagnosticComplete = true;
                  diagnosticProductsCount = typeof ev2.products_count === 'number' ? ev2.products_count : null;
                }
                continue;
              }
              if (ev2.type === 'contacts') { contacts = ev2.html; continue; }
              if (ev2.type === 'conversation_boundary' && ev2.mode === 'new_task') {
                applyAutomaticConversationBoundary(ev2.session_id, message);
                continue;
              }
              if (ev2.type === 'slot_update') { dialogSlots = ev2.slots || {}; saveState(); continue; }
              if (ev2.type === 'products_block' && ev2.markdown) {
                handleProductsBlock(ev2.markdown);
                continue;
              }
              if (ev2.type === 'assistant_turn_break' || ev2.type === 'tool_event' || ev2.type === 'quick_replies') continue;
            }
            if (o2.contacts) { contacts = o2.contacts; continue; }
            if (o2.slot_update) { dialogSlots = o2.slot_update; saveState(); continue; }
            var d2 = o2.choices && o2.choices[0] && o2.choices[0].delta && o2.choices[0].delta.content;
            if (d2) appendDelta(d2);
          } catch(e) {}
        }
      }
    } catch (flushErr) {
      try { console.warn('[Widget] stream flush error: ' + (flushErr && flushErr.message)); } catch(e) {}
    }

    var combined = [introContent, productsContent].filter(function(s){ return s && s.trim(); }).join('\n\n');
    if (!combined) {
      // A diagnostic start is an explicit server acknowledgement. Retrying the
      // same message through another route would start a second catalog/LLM
      // execution and can return a contradictory answer. Surface one traceable
      // partial result instead; retries remain allowed only before acceptance.
      if (diagnosticLogId) {
        return {
          content: '',
          contacts: contacts,
          partial: true,
          accepted: true,
          split: true,
          logId: diagnosticLogId,
          serverProductsCount: diagnosticProductsCount,
          transportError: streamReadError ? String(streamReadError.message || streamReadError) : null
        };
      }
      if (streamReadError) throw streamReadError;
      if (!firstTokenReceived) throw new Error(label + ': empty streaming content');
      return { content: '', contacts: contacts, partial: true, split: true };
    }
    return {
      content: combined,
      contacts: contacts,
      partial: !done || !diagnosticComplete,
      split: true,
      introContent: introContent,
      productsContent: productsContent,
      logId: diagnosticLogId,
      serverProductsCount: diagnosticProductsCount
    };
  }

  // Send one message with streaming + idempotent replay recovery
  async function sendMessage() {
    if (isLoading) return;
    expireConversationIfNeeded(true);
    var message = input.value.trim();
    if (!message) return;

    isLoading = true;
    input.value = '';
    sendBtn.disabled = true;
    newChatBtn.disabled = true;

    // При любом ретрае в рамках одного sendMessage отправляется тот же UUID.
    currentMessageId = generateMessageId();

    addMessage(message, 'user');
    conversationHistory.push({ role: 'user', content: message });
    saveState();

    // Показываем typing-точки. Никаких «Сейчас подберу варианты» — LLM сама пишет вступление.
    var typingIndicator = document.createElement('div');
    typingIndicator.className = 'volt-message assistant';
    typingIndicator.id = 'volt-typing-indicator';
    typingIndicator.innerHTML = '<div class="volt-typing" style="background:transparent;padding:4px 0;"><span></span><span></span><span></span></div>';
    messagesContainer.appendChild(typingIndicator);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;

    // Streaming endpoints
    var streamEndpoints = [
      { url: 'https://yngoixmvmxdfxokuafjp.supabase.co', label: 'direct' },
      { url: CONFIG.supabaseUrl, label: 'proxy' }
    ];

    // Create assistant message element for streaming (intro-пузырь)
    var assistantMsg = document.createElement('div');
    assistantMsg.className = 'volt-message assistant';
    assistantMsg.innerHTML = '';
    var msgInserted = false;
    var firstTokenArrived = false;
    var productsMsg = null; // второй пузырь — только когда пришёл products_block
    var streamEnded = false;
    var pendingProductsTimer = null;

    // Callback: интро закончилось, пришли карточки — открываем НОВЫЙ пузырь
    function openProductsBubble() {
      var live = document.getElementById('volt-live-typing');
      if (live) live.remove();

      var pauseTyping = document.createElement('div');
      pauseTyping.className = 'volt-message assistant';
      pauseTyping.id = 'volt-products-typing';
      pauseTyping.innerHTML = '<div class="volt-typing" style="background:transparent;padding:4px 0;"><span></span><span></span><span></span></div>';
      messagesContainer.appendChild(pauseTyping);
      messagesContainer.scrollTop = messagesContainer.scrollHeight;

      productsMsg = document.createElement('div');
      productsMsg.className = 'volt-message assistant';
      productsMsg.innerHTML = '';
      pendingProductsTimer = setTimeout(function() {
        pendingProductsTimer = null;
        var pt = document.getElementById('volt-products-typing');
        if (pt) pt.remove();
        messagesContainer.appendChild(productsMsg);
        productsMsg.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Live-typing под products-пузырём — только если стрим ещё не закончился
        if (!streamEnded) {
          var live2 = document.createElement('div');
          live2.className = 'volt-message assistant';
          live2.id = 'volt-live-typing';
          live2.innerHTML = '<div class="volt-typing" style="background:transparent;padding:4px 0;"><span></span><span></span><span></span></div>';
          messagesContainer.appendChild(live2);
        }
      }, 350);
      return productsMsg;
    }

    var result = null;
    var lastError = null;

    // Fire API request immediately (typing-точки уже крутятся)
    var streamPromise = (async function() {
      for (var i = 0; i < streamEndpoints.length; i++) {
        try {
          result = await tryStreamEndpoint(
            streamEndpoints[i].url, message, streamEndpoints[i].label, assistantMsg,
            function() {
              firstTokenArrived = true;
              var typingEl1 = document.getElementById('volt-typing-indicator');
              if (typingEl1) typingEl1.remove();
              if (!msgInserted) {
                messagesContainer.appendChild(assistantMsg);
                assistantMsg.scrollIntoView({ behavior: 'smooth', block: 'start' });
                msgInserted = true;
              }
              // Live typing-точки ПОД пузырём: пока стрим идёт — юзер видит, что бот ещё печатает.
              var live = document.getElementById('volt-live-typing');
              if (!live) {
                live = document.createElement('div');
                live.className = 'volt-message assistant';
                live.id = 'volt-live-typing';
                live.innerHTML = '<div class="volt-typing" style="background:transparent;padding:4px 0;"><span></span><span></span><span></span></div>';
                messagesContainer.appendChild(live);
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
              }
            },
            openProductsBubble,
            false
          );
          return;
        } catch (err) {
          lastError = err;
          try { console.warn('[Widget] stream ' + streamEndpoints[i].label + ' failed: ' + (err && err.message)); } catch(e) {}
          if (firstTokenArrived) break;
          if (assistantMsg.parentNode && !assistantMsg.innerHTML) assistantMsg.remove();
          msgInserted = false;
        }
      }
    })();

    // Wait for stream to complete
    await streamPromise;

    // If the server acknowledged the request but the transport broke before
    // any answer text arrived, reconnect in replay-only mode. The backend uses
    // the same messageId as an idempotency key and is forbidden to start a
    // second catalog/model execution.
    if (result && result.accepted && result.partial && !result.content) {
      var acceptedPartial = result;
      var resumeEndpoints = [streamEndpoints[1], streamEndpoints[0]];
      for (var r = 0; r < resumeEndpoints.length; r++) {
        try {
          var replayed = await tryStreamEndpoint(
            resumeEndpoints[r].url, message, resumeEndpoints[r].label + '-resume', assistantMsg,
            function() {
              firstTokenArrived = true;
              var typingElReplay = document.getElementById('volt-typing-indicator');
              if (typingElReplay) typingElReplay.remove();
              if (!msgInserted) {
                messagesContainer.appendChild(assistantMsg);
                assistantMsg.scrollIntoView({ behavior: 'smooth', block: 'start' });
                msgInserted = true;
              }
            },
            openProductsBubble,
            true
          );
          if (replayed && replayed.content) {
            result = replayed;
            break;
          }
        } catch (resumeError) {
          lastError = resumeError;
          try { console.warn('[Widget] resume ' + resumeEndpoints[r].label + ' failed: ' + (resumeError && resumeError.message)); } catch(e) {}
        }
      }
      if (!result || !result.content) result = acceptedPartial;
    }

    // Стрим завершён — блокируем отложенное появление live-typing и снимаем все индикаторы
    streamEnded = true;
    if (pendingProductsTimer) {
      clearTimeout(pendingProductsTimer);
      pendingProductsTimer = null;
      // Стрим завершился раньше, чем сработал 350ms-таймер вставки products-пузыря.
      // Если карточки уже пришли (productsMsg наполнен) — вставляем СРАЗУ,
      // иначе они молча потеряются и юзер увидит только intro.
      if (productsMsg && !productsMsg.parentNode && productsMsg.innerHTML) {
        var ptEarly = document.getElementById('volt-products-typing');
        if (ptEarly) ptEarly.remove();
        messagesContainer.appendChild(productsMsg);
        productsMsg.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
    var liveDone = document.getElementById('volt-live-typing');
    if (liveDone) liveDone.remove();
    var stalePt = document.getElementById('volt-products-typing');
    if (stalePt) stalePt.remove();
    var stale1 = document.getElementById('volt-typing-indicator');
    if (stale1) stale1.remove();
    // Двойная страховка: если какой-то таймер всё же успел вставить live-typing позже — снять на следующем тике
    setTimeout(function() {
      var late = document.getElementById('volt-live-typing');
      if (late) late.remove();
      var lateProducts = document.getElementById('volt-products-typing');
      if (lateProducts) lateProducts.remove();
    }, 400);

    if (result) {
      var cleanContent = stripGreeting(result.content);
      var hasContent = Boolean(cleanContent && cleanContent.trim());
      // Если стрим НЕ дал split (non-stream fallback) — рендерим всё в один пузырь.
      if (hasContent && (!result.split || !firstTokenArrived)) {
        if (!msgInserted) {
          messagesContainer.appendChild(assistantMsg);
          msgInserted = true;
        }
        assistantMsg.innerHTML = formatMessage(cleanContent);
        assistantMsg.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      // Если split уже произошёл — пузыри уже отрисованы прогрессивно, не перерисовываем.
      if (hasContent) {
        conversationHistory.push({ role: 'assistant', content: cleanContent });
        saveState();
      }

      if (result.contacts) {
        addMessage(result.contacts, 'assistant');
      }
      var diagnosticTarget = (productsMsg && productsMsg.parentNode) ? productsMsg : (hasContent ? assistantMsg : null);
      if (result.partial && !hasContent) {
        if (assistantMsg.parentNode) assistantMsg.remove();
        diagnosticTarget = addMessage('Сервер принял запрос, но соединение прервалось до получения ответа. Повторите запрос и сообщите менеджеру код запроса ниже.', 'assistant');
      }
      addDiagnosticLabel(diagnosticTarget, result.logId, result.partial);
      if (result.partial && hasContent) {
        addMessage('Соединение прервалось до завершения ответа. Повторите запрос и сообщите менеджеру код запроса, указанный выше.', 'assistant');
      } else if (typeof result.serverProductsCount === 'number' && result.serverProductsCount > 0 && !result.productsContent) {
        addMessage('Сервер нашёл товары, но карточки не отобразились. Повторите запрос и сообщите менеджеру код запроса, указанный выше.', 'assistant');
      }
    } else if (firstTokenArrived && assistantMsg.textContent && assistantMsg.textContent.trim()) {
      // Стрим оборвался посреди ответа, но в UI уже есть текст — сохраняем его в историю
      // вместо показа «ошибки соединения». Лучше частичный ответ, чем пустота.
      var partialContent = stripGreeting(assistantMsg.textContent);
      conversationHistory.push({ role: 'assistant', content: partialContent });
      saveState();
      try { console.warn('[Widget] showing partial stream content (no fallback triggered)'); } catch(e) {}
    } else {
      hideTyping();
      if (lastError && lastError.status === 400) {
        addMessage('Не удалось продолжить диалог из-за некорректных или устаревших данных. Обновите страницу и повторите запрос.', 'assistant');
      } else {
        addMessage('Извините, произошла ошибка соединения. Попробуйте позже.', 'assistant');
      }
    }

    isLoading = false;
    sendBtn.disabled = false;
    newChatBtn.disabled = false;
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
    toggle: toggleWidget,
    newConversation: function() {
      if (isLoading) return false;
      if (hasUserMessages(conversationHistory) && typeof globalThis.confirm === 'function' &&
          !globalThis.confirm('Начать новый диалог? Текущая история будет очищена.')) return false;
      return resetVisibleConversation(false);
    }
  };
})();
