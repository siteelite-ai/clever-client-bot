(function() {
  'use strict';

  // Configuration
  const CONFIG = {
    supabaseUrl: 'https://yngoixmvmxdfxokuafjp.supabase.co',
    supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InluZ29peG12bXhkZnhva3VhZmpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk2MTg0MzQsImV4cCI6MjA4NTE5NDQzNH0.bJTllxYOlRBqmnKqMAH21OkTBvXjqW4AaBLHz2fK2lQ',
    primaryColor: '#F5A623',
    logo: 'https://220volt.kz/assets/templates/img/logo.svg'
  };

  // Generate unique session ID
  const sessionId = 'session_' + Math.random().toString(36).substr(2, 9) + '_' + Date.now();
  let conversationHistory = [];
  let isOpen = false;
  let isLoading = false;

  // Inject styles
  const styles = document.createElement('style');
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
      background: linear-gradient(135deg, ${CONFIG.primaryColor} 0%, #E8941F 100%);
      padding: 16px;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    
    #volt-widget-logo {
      height: 32px;
      filter: brightness(0) invert(1);
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
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      -webkit-overflow-scrolling: touch;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: #1a1a1a;
      scroll-behavior: smooth;
    }
    
    #volt-widget-messages::-webkit-scrollbar {
      width: 6px;
    }
    
    #volt-widget-messages::-webkit-scrollbar-track {
      background: transparent;
    }
    
    #volt-widget-messages::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.2);
      border-radius: 3px;
    }
    
    #volt-widget-messages::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.3);
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
      gap: 8px;
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
        <img id="volt-widget-logo" src="${CONFIG.logo}" alt="220volt">
        <span id="volt-widget-title">Консультант</span>
        <button id="volt-widget-close" aria-label="Закрыть">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
      
      <div id="volt-widget-messages">
        <div class="volt-message assistant">
          Здравствуйте! 👋 Я AI-консультант 220volt.kz. Помогу подобрать электроинструменты, расскажу о доставке и оплате. Что вас интересует?
        </div>
      </div>
      
      <div id="volt-widget-input-area">
        <input 
          type="text" 
          id="volt-widget-input" 
          placeholder="Напишите сообщение..."
          autocomplete="off"
        >
        <button id="volt-widget-send" aria-label="Отправить">
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
          </svg>
        </button>
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

  // Parse markdown-like formatting
  function formatMessage(text) {
    let result = text;
    
    // Handle numbered lists (1. 2. 3.)
    result = result.replace(/^(\d+)\.\s+(.+)$/gm, '<div style="margin-left: 8px; margin-bottom: 4px;">$1. $2</div>');
    
    // Handle bullet lists with asterisks or dashes
    result = result.replace(/^[\*\-]\s+(.+)$/gm, '<div style="margin-left: 8px; margin-bottom: 4px;">• $1</div>');
    
    // Bold
    result = result.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    
    // Single asterisks that are not bold (leftover)
    result = result.replace(/(?<!\*)\*(?!\*)([^*]+)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    
    // Links
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    
    // Line breaks (but not after list items)
    result = result.replace(/\n(?!<div)/g, '<br>');
    
    return result;
  }

  // Add message to chat
  function addMessage(content, role) {
    const msg = document.createElement('div');
    msg.className = `volt-message ${role}`;
    msg.innerHTML = role === 'assistant' ? formatMessage(content) : content;
    messagesContainer.appendChild(msg);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
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

  // Send message
  async function sendMessage() {
    const message = input.value.trim();
    if (!message || isLoading) return;

    isLoading = true;
    input.value = '';
    sendBtn.disabled = true;

    // Add user message
    addMessage(message, 'user');
    conversationHistory.push({ role: 'user', content: message });

    showTyping();

    try {
      const response = await fetch(`${CONFIG.supabaseUrl}/functions/v1/chat-consultant`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${CONFIG.supabaseKey}`
        },
        body: JSON.stringify({
          message,
          sessionId,
          history: conversationHistory.slice(-10) // Last 10 messages for context
        })
      });

      hideTyping();

      if (!response.ok) {
        throw new Error('Network error');
      }

      // Handle streaming response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantMessage = '';
      let messageElement = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]' || data === '') continue;
            
            try {
              const parsed = JSON.parse(data);
              // Support both formats: direct content and OpenAI-style delta
              const content = parsed.content || parsed.choices?.[0]?.delta?.content;
              
              if (content) {
                assistantMessage += content;
                
                if (!messageElement) {
                  messageElement = document.createElement('div');
                  messageElement.className = 'volt-message assistant';
                  messagesContainer.appendChild(messageElement);
                }
                
                messageElement.innerHTML = formatMessage(assistantMessage);
                messagesContainer.scrollTop = messagesContainer.scrollHeight;
              }
            } catch (e) {
              // Skip parse errors
            }
          }
        }
      }

      if (assistantMessage) {
        conversationHistory.push({ role: 'assistant', content: assistantMessage });
      }

    } catch (error) {
      hideTyping();
      console.error('220volt Widget Error:', error);
      addMessage('Извините, произошла ошибка. Попробуйте позже.', 'assistant');
    }

    isLoading = false;
    sendBtn.disabled = false;
    input.focus();
  }

  // Event listeners
  sendBtn.addEventListener('click', sendMessage);
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      sendMessage();
    }
  });

  // Expose API
  window.Widget220volt = {
    open: () => { if (!isOpen) toggleWidget(); },
    close: () => { if (isOpen) toggleWidget(); },
    toggle: toggleWidget
  };

  console.log('220volt Widget loaded');
})();
