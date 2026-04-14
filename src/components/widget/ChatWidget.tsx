import { useState, useRef, useEffect, useCallback } from 'react';
import { MessageSquare, X, Send, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatMessage, Product } from '@/types';
import ReactMarkdown from 'react-markdown';

interface ChatWidgetProps {
  isPreview?: boolean;
}

const SUPABASE_URL = "https://yngoixmvmxdfxokuafjp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InluZ29peG12bXhkZnhva3VhZmpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk2MTg0MzQsImV4cCI6MjA4NTE5NDQzNH0.bJTllxYOlRBqmnKqMAH21OkTBvXjqW4AaBLHz2fK2lQ";

type Msg = { role: 'user' | 'assistant'; content: string };

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

function pickThinkingPhrase(message: string): string {
  const pool = PRODUCT_KEYWORDS.test(message) ? THINKING_CATALOG : THINKING_INFO;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Dialog slot types for persistent intent memory
interface DialogSlot {
  intent: 'price_extreme' | 'product_search';
  price_dir?: 'most_expensive' | 'cheapest';
  base_category: string;
  refinement?: string;
  status: 'pending' | 'done';
  created_turn: number;
  turns_since_touched: number;
}

type DialogSlots = Record<string, DialogSlot>;

async function streamChat({
  messages,
  onDelta,
  onDone,
  onError,
  onContacts,
  onSlotUpdate,
  conversationId,
  dialogSlots,
}: {
  messages: Msg[];
  onDelta: (deltaText: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
  onContacts?: (contacts: string) => void;
  onSlotUpdate?: (slots: DialogSlots) => void;
  conversationId: string;
  dialogSlots: DialogSlots;
}) {
  try {
    // Clean: only send pending slots, max 3
    const activeSlots: DialogSlots = {};
    let count = 0;
    for (const [key, slot] of Object.entries(dialogSlots)) {
      if (slot.status === 'pending' && count < 3) {
        activeSlots[key] = slot;
        count++;
      }
    }

    const resp = await fetch(`${SUPABASE_URL}/functions/v1/chat-consultant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ 
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        conversationId,
        dialogSlots: activeSlots,
      }),
    });

    if (!resp.ok) {
      const errorData = await resp.json().catch(() => ({}));
      onError(errorData.error || `Ошибка: ${resp.status}`);
      return;
    }

    if (!resp.body) {
      onError('Нет ответа от сервера');
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let textBuffer = '';
    let streamDone = false;

    while (!streamDone) {
      const { done, value } = await reader.read();
      if (done) break;
      textBuffer += decoder.decode(value, { stream: true });

      let newlineIndex: number;
      while ((newlineIndex = textBuffer.indexOf('\n')) !== -1) {
        let line = textBuffer.slice(0, newlineIndex);
        textBuffer = textBuffer.slice(newlineIndex + 1);

        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (line.startsWith(':') || line.trim() === '') continue;
        if (!line.startsWith('data: ')) continue;

        const jsonStr = line.slice(6).trim();
        if (jsonStr === '[DONE]') {
          streamDone = true;
          // Drain remaining data from reader (slot_update may come after [DONE])
          while (true) {
            const { done: readerDone, value: extraValue } = await reader.read();
            if (readerDone) break;
            textBuffer += decoder.decode(extraValue, { stream: true });
          }
          break;
        }

        try {
          const parsed = JSON.parse(jsonStr);
          // Check for contacts event
          if (parsed.contacts && onContacts) {
            onContacts(parsed.contacts);
            continue;
          }
          // Check for slot_update event
          if (parsed.slot_update && onSlotUpdate) {
            onSlotUpdate(parsed.slot_update);
            continue;
          }
          const content = parsed.choices?.[0]?.delta?.content as string | undefined;
          if (content) onDelta(content);
        } catch {
          textBuffer = line + '\n' + textBuffer;
          break;
        }
      }
    }

    // Final flush
    if (textBuffer.trim()) {
      for (let raw of textBuffer.split('\n')) {
        if (!raw) continue;
        if (raw.endsWith('\r')) raw = raw.slice(0, -1);
        if (raw.startsWith(':') || raw.trim() === '') continue;
        if (!raw.startsWith('data: ')) continue;
        const jsonStr = raw.slice(6).trim();
        if (jsonStr === '[DONE]') continue;
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed.contacts && onContacts) {
            onContacts(parsed.contacts);
            continue;
          }
          if (parsed.slot_update && onSlotUpdate) {
            onSlotUpdate(parsed.slot_update);
            continue;
          }
          const content = parsed.choices?.[0]?.delta?.content as string | undefined;
          if (content) onDelta(content);
        } catch { /* ignore */ }
      }
    }

    onDone();
  } catch (error) {
    console.error('Stream error:', error);
    onError(error instanceof Error ? error.message : 'Ошибка подключения');
  }
}

export function ChatWidget({ isPreview = false }: ChatWidgetProps) {
  const [isOpen, setIsOpen] = useState(isPreview);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: '1',
      role: 'assistant',
      content: 'Здравствуйте! 👋 Я AI-консультант 220volt.kz. Помогу подобрать электроинструменты, расскажу о доставке и оплате. Что вас интересует?',
      timestamp: new Date()
    }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [dialogSlots, setDialogSlots] = useState<DialogSlots>({});
  const conversationIdRef = useRef(crypto.randomUUID());

  const handleSend = useCallback(async () => {
    if (!input.trim() || isLoading) return;

    const userMessage: ChatMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    // Show thinking phrase immediately (0ms perceived latency)
    const thinkingId = `thinking-${Date.now()}`;
    const thinkingPhrase = pickThinkingPhrase(input);
    setMessages(prev => [...prev, {
      id: thinkingId,
      role: 'assistant' as const,
      content: thinkingPhrase,
      timestamp: new Date()
    }]);

    let assistantContent = '';
    let thinkingReplaced = false;

    const updateAssistant = (chunk: string) => {
      assistantContent += chunk;
      // Filter thinking tokens from Gemini 2.5 Flash and contact markers
      let displayContent = assistantContent.replace(/\[CONTACT_MANAGER\]/g, '');
      displayContent = displayContent.replace(/<think>[\s\S]*?<\/think>/g, '');
      displayContent = displayContent.replace(/ТИХОЕ РАЗМЫШЛЕНИЕ[\s\S]*?(?:КОНЕЦ РАЗМЫШЛЕНИ[ЯЙ]|$)/gs, '');
      displayContent = displayContent.trim();
      setMessages(prev => {
        if (!thinkingReplaced) {
          // Replace thinking message with first real content
          thinkingReplaced = true;
          return prev.map(m => 
            m.id === thinkingId
              ? { ...m, id: `stream-${Date.now()}`, content: displayContent }
              : m
          );
        }
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && last.id.startsWith('stream-')) {
          return prev.map((m, i) => 
            i === prev.length - 1 
              ? { ...m, content: displayContent } 
              : m
          );
        }
        return [...prev, {
          id: `stream-${Date.now()}`,
          role: 'assistant' as const,
          content: displayContent,
          timestamp: new Date()
        }];
      });
    };

    // Prepare messages for API
    const apiMessages: Msg[] = messages.map(m => ({
      role: m.role,
      content: m.content
    }));
    apiMessages.push({ role: 'user', content: input });

    console.log('[Widget] Sending dialogSlots:', JSON.stringify(dialogSlots));
    await streamChat({
      messages: apiMessages,
      conversationId: conversationIdRef.current,
      dialogSlots,
      onDelta: updateAssistant,
      onSlotUpdate: (updatedSlots) => {
        console.log('[Widget] Received slot_update:', JSON.stringify(updatedSlots));
        setDialogSlots(updatedSlots);
      },
      onContacts: (contacts) => {
        setMessages(prev => [...prev, {
          id: `contacts-${Date.now()}`,
          role: 'assistant' as const,
          content: contacts,
          timestamp: new Date()
        }]);
      },
      onDone: () => setIsLoading(false),
      onError: (error) => {
        setMessages(prev => [...prev, {
          id: `error-${Date.now()}`,
          role: 'assistant',
          content: `Извините, произошла ошибка: ${error}. Попробуйте повторить вопрос.`,
          timestamp: new Date()
        }]);
        setIsLoading(false);
      }
    });
  }, [input, isLoading, messages, dialogSlots]);

  const ProductCard = ({ product }: { product: Product }) => (
    <a
      href={`https://220volt.kz${product.url}`}
      target="_blank"
      rel="noopener noreferrer"
      className="product-card-widget"
    >
      {product.image && (
        <img 
          src={product.image} 
          alt={product.pagetitle}
          className="w-16 h-16 object-cover rounded-lg flex-shrink-0"
        />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-widget-text line-clamp-2">{product.pagetitle}</p>
        <p className="text-sm font-bold text-primary mt-1">
          {product.price.toLocaleString('ru-RU')} ₸
        </p>
        {product.amount > 0 && (
          <p className="text-xs text-success mt-0.5">В наличии</p>
        )}
      </div>
    </a>
  );

  return (
    <div className={cn("widget-container", isPreview && "relative bottom-0 right-0")}>
      {/* Chat Window */}
      {isOpen && (
        <div className={cn("widget-chat", isPreview && "relative bottom-0 right-0")}>
          {/* Header */}
          <div className="h-16 px-4 flex items-center justify-between border-b border-sidebar-border">
            <div className="flex items-center gap-3">
              <div>
                <p className="text-sm font-semibold text-widget-text">AI Консультант</p>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-success pulse-dot" />
                  <span className="text-xs text-widget-text/60">Онлайн</span>
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <img 
                src="/logo-220volt-widget.svg" 
                alt="220volt" 
                className="h-8"
              />
              {!isPreview && (
                <button
                  onClick={() => setIsOpen(false)}
                  className="p-2 rounded-lg hover:bg-sidebar-accent transition-colors text-widget-text/60"
                >
                  <X className="w-5 h-5" />
                </button>
              )}
            </div>
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 widget-scrollbar h-[400px]">
            {messages.map((message, index) => {
              return (
              <div
                key={message.id}
                className={cn(
                  "flex",
                  message.role === 'user' ? "justify-end" : "justify-start"
                )}
              >
                <div
                  className={cn(
                    "max-w-[85%] rounded-2xl px-4 py-2.5",
                    message.role === 'user' ? "chat-message-user" : "chat-message-bot"
                  )}
                >
                  {message.role === 'assistant' ? (
                    <div className="text-sm prose prose-sm prose-invert max-w-none">
                      <ReactMarkdown
                        components={{
                          a: ({ node, ...props }) => (
                            <a {...props} target="_blank" rel="noopener noreferrer" className="text-primary underline hover:text-primary/80 font-medium" />
                          ),
                          p: ({ node, ...props }) => <p {...props} className="mb-2 last:mb-0" />,
                          ul: ({ node, ...props }) => <ul {...props} className="list-disc pl-4 mb-2" />,
                          ol: ({ node, ...props }) => <ol {...props} className="list-decimal pl-4 mb-2" />,
                          li: ({ node, ...props }) => <li {...props} className="mb-1" />,
                          strong: ({ node, ...props }) => <strong {...props} className="font-bold text-widget-text" />,
                        }}
                      >
                        {message.content}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                  )}
                  
                  {/* Product cards */}
                  {message.products && message.products.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {message.products.map((product) => (
                        <ProductCard key={product.id} product={product} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
              );
            })}

            {isLoading && messages[messages.length - 1]?.id.startsWith('thinking-') && (
              <div className="flex justify-start">
                <div className="chat-message-bot rounded-2xl px-4 py-3">
                  <div className="text-sm mb-2 text-widget-text/70">
                    {messages[messages.length - 1]?.content}
                  </div>
                  <div className="flex gap-1">
                    <span className="w-2 h-2 rounded-full bg-widget-text/40 animate-typing" style={{ animationDelay: '0s' }} />
                    <span className="w-2 h-2 rounded-full bg-widget-text/40 animate-typing" style={{ animationDelay: '0.2s' }} />
                    <span className="w-2 h-2 rounded-full bg-widget-text/40 animate-typing" style={{ animationDelay: '0.4s' }} />
                  </div>
                </div>
              </div>
            )}

            <div />
          </div>

          {/* Input */}
          <div className="p-4 border-t border-sidebar-border">
          <div className="flex flex-col gap-1">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value.slice(0, 2000))}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder="Напишите сообщение..."
                maxLength={2000}
                className="flex-1 bg-sidebar-accent rounded-xl px-4 py-3 text-sm text-widget-text placeholder:text-widget-text/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
                disabled={isLoading}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || isLoading || input.length > 2000}
                className="w-12 h-12 rounded-xl bg-primary text-primary-foreground flex items-center justify-center transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Send className="w-5 h-5" />
                )}
              </button>
            </div>
            {input.length > 1800 && (
              <span className={cn("text-xs text-right pr-14", input.length >= 2000 ? "text-destructive" : "text-widget-text/50")}>
                {input.length}/2000
              </span>
            )}
          </div>
          </div>
        </div>
      )}

      {/* Toggle Button */}
      {!isPreview && (
        <button
          onClick={() => setIsOpen(!isOpen)}
          className="widget-bubble"
        >
          {isOpen ? (
            <X className="w-6 h-6 text-primary-foreground" />
          ) : (
            <MessageSquare className="w-6 h-6 text-primary-foreground" />
          )}
        </button>
      )}
    </div>
  );
}
