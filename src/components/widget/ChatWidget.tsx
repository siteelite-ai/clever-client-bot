import { useState, useRef, useEffect, useCallback } from 'react';
import { MessageSquare, X, Send, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatMessage, Product, QuickReply } from '@/types';
import ReactMarkdown from 'react-markdown';

interface ChatWidgetProps {
  isPreview?: boolean;
}

const SUPABASE_URL = "https://yngoixmvmxdfxokuafjp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InluZ29peG12bXhkZnhva3VhZmpwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njk2MTg0MzQsImV4cCI6MjA4NTE5NDQzNH0.bJTllxYOlRBqmnKqMAH21OkTBvXjqW4AaBLHz2fK2lQ";

// V1 vs V2 routing — endpoint is resolved once at widget mount via widget-config.
// V1 (chat-consultant) is the legacy frozen pipeline; V2 (chat-consultant-v2)
// is the new spec implementation. Switching is admin-only, manual, no auto-fallback.
type PipelineVersion = 'v1' | 'v2';
const ENDPOINT_BY_PIPELINE: Record<PipelineVersion, string> = {
  v1: `${SUPABASE_URL}/functions/v1/chat-consultant`,
  v2: `${SUPABASE_URL}/functions/v1/chat-consultant-v2`,
};

async function resolvePipelineEndpoint(): Promise<{ pipeline: PipelineVersion; url: string }> {
  try {
    const r = await fetch(`${SUPABASE_URL}/functions/v1/widget-config`, {
      headers: { 'apikey': SUPABASE_ANON_KEY },
    });
    if (r.ok) {
      const j = await r.json();
      const pipeline: PipelineVersion = j?.active_pipeline === 'v2' ? 'v2' : 'v1';
      return { pipeline, url: ENDPOINT_BY_PIPELINE[pipeline] };
    }
  } catch (e) {
    console.warn('[Widget] widget-config fetch failed, defaulting to v1', e);
  }
  return { pipeline: 'v1', url: ENDPOINT_BY_PIPELINE.v1 };
}

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
  onQuickReplies,
  conversationId,
  dialogSlots,
  endpointUrl,
}: {
  messages: Msg[];
  onDelta: (deltaText: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
  onContacts?: (contacts: string) => void;
  onSlotUpdate?: (slots: DialogSlots) => void;
  onQuickReplies?: (replies: QuickReply[]) => void;
  conversationId: string;
  dialogSlots: DialogSlots;
  endpointUrl: string;
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

    const resp = await fetch(endpointUrl, {
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
          // Check for quick_replies event (Plan V7 — category disambiguation)
          if (Array.isArray(parsed.quick_replies) && onQuickReplies) {
            onQuickReplies(parsed.quick_replies);
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
          if (Array.isArray(parsed.quick_replies) && onQuickReplies) {
            onQuickReplies(parsed.quick_replies);
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

// Generate a unique chat message ID. We keep an optional human-readable
// prefix (typing-, stream-, etc.) for the existing prefix-based filters, but
// always append a crypto.randomUUID so two messages created in the same
// millisecond never collide. This is the single source of truth for ids.
const mid = (prefix?: string): string => {
  const uuid = crypto.randomUUID();
  return prefix ? `${prefix}-${uuid}` : uuid;
};

export function ChatWidget({ isPreview = false }: ChatWidgetProps) {
  const [isOpen, setIsOpen] = useState(isPreview);
  // Виджет открывается с пустой лентой. Core-правило «ABSOLUTE BAN on greetings»:
  // никаких приветствий, бот ведёт себя как эксперт-продавец. Первый ход — пользователя.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [dialogSlots, setDialogSlots] = useState<DialogSlots>({});
  const conversationIdRef = useRef(crypto.randomUUID());
  // Synchronous re-entrancy guard. setIsLoading(true) is async, so two rapid
  // clicks can both pass the `isLoading` check before React re-renders. A ref
  // flips immediately and blocks any second call.
  const sendingRef = useRef(false);
  // Tracks which quick-reply value is currently in-flight so the chosen chip
  // can show a pressed state while all others are visibly disabled.
  const [pendingQuickReply, setPendingQuickReply] = useState<string | null>(null);

  // Active pipeline endpoint, resolved at mount via widget-config.
  // Default to v1 so the widget works even if the config call is delayed.
  const [endpoint, setEndpoint] = useState<{ pipeline: PipelineVersion; url: string }>({
    pipeline: 'v1',
    url: ENDPOINT_BY_PIPELINE.v1,
  });
  useEffect(() => {
    let cancelled = false;
    resolvePipelineEndpoint().then((resolved) => {
      if (!cancelled) {
        setEndpoint(resolved);
        console.log(`[Widget] active pipeline = ${resolved.pipeline}`);
      }
    });
    return () => { cancelled = true; };
  }, []);

  const handleSend = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || isLoading || sendingRef.current) return;
    sendingRef.current = true;

    const userMessage: ChatMessage = {
      id: mid('user'),
      role: 'user',
      content: text,
      timestamp: new Date()
    };

    // Capture, in this send's closure, the ID of the assistant message whose
    // chips the user is currently responding to. We then clear chips strictly
    // by that captured ID — not by index or "last assistant" lookup at
    // commit time. This eliminates races where two rapid sends each compute
    // "last with chips" against an already-mutated array, or where a new
    // assistant message has slipped in between dispatch and commit.
    let chipsToClearId: string | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'assistant' && m.quickReplies && m.quickReplies.length > 0) {
        chipsToClearId = m.id;
        break;
      }
    }

    setMessages(prev => {
      const next = chipsToClearId === null
        ? prev
        : prev.map(m => (m.id === chipsToClearId ? { ...m, quickReplies: undefined } : m));
      return [...next, userMessage];
    });
    if (!overrideText) setInput('');
    setIsLoading(true);

    // Step 1: Show typing dots animation
    const typingId = mid('typing');
    setMessages(prev => [...prev, {
      id: typingId,
      role: 'assistant' as const,
      content: '__TYPING__',
      timestamp: new Date()
    }]);

    const thinkingPhrase = pickThinkingPhrase(text);

    // Prepare messages for API (do this BEFORE the delay so we can fire in parallel)
    const apiMessages: Msg[] = messages
      .filter(m => 
        m.content !== '__TYPING__' && 
        !m.id.startsWith('thinking-') && 
        !m.id.startsWith('typing')
      )
      .map(m => ({ role: m.role, content: m.content }));
    apiMessages.push({ role: 'user', content: text });

    let assistantContent = '';
    let typing2Removed = false;
    let streamMsgId: string | null = null;

    const upsertAssistant = (
      updater: (prev: ChatMessage[]) => ChatMessage[]
    ) => setMessages(updater);

    const updateAssistant = (chunk: string) => {
      assistantContent += chunk;
      let displayContent = assistantContent.replace(/\[CONTACT_MANAGER\]/g, '');
      displayContent = displayContent.replace(/<think>[\s\S]*?<\/think>/g, '');
      displayContent = displayContent.replace(/ТИХОЕ РАЗМЫШЛЕНИЕ[\s\S]*?(?:КОНЕЦ РАЗМЫШЛЕНИ[ЯЙ]|$)/gs, '');
      // Remove repeated greetings from the response
      displayContent = displayContent.replace(/^(?:Здравствуйте[.!]?\s*|Добрый\s+(?:день|вечер|утро)[.!,]?\s*|Привет[.!,]?\s*|Приветствую[.!,]?\s*)/i, '');
      displayContent = displayContent.trim();
      upsertAssistant(prev => {
        let updated = prev;
        if (!typing2Removed) {
          typing2Removed = true;
          updated = prev.filter(m => !m.id.startsWith('typing2-'));
          const id = mid('stream');
          streamMsgId = id;
          return [...updated, {
            id,
            role: 'assistant' as const,
            content: displayContent,
            timestamp: new Date()
          }];
        }
        const last = updated[updated.length - 1];
        if (last?.role === 'assistant' && last.id.startsWith('stream-')) {
          streamMsgId = last.id;
          return updated.map((m, i) => 
            i === updated.length - 1 
              ? { ...m, content: displayContent } 
              : m
          );
        }
        const id = mid('stream');
        streamMsgId = id;
        return [...updated, {
          id,
          role: 'assistant' as const,
          content: displayContent,
          timestamp: new Date()
        }];
      });
    };

    // Fire API request immediately (in parallel with animation)
    console.log(`[Widget] Sending via ${endpoint.pipeline} dialogSlots:`, JSON.stringify(dialogSlots));
    const streamPromise = streamChat({
      messages: apiMessages,
      conversationId: conversationIdRef.current,
      dialogSlots,
      endpointUrl: endpoint.url,
      onDelta: updateAssistant,
      onSlotUpdate: (updatedSlots) => {
        console.log('[Widget] Received slot_update:', JSON.stringify(updatedSlots));
        setDialogSlots(updatedSlots);
      },
      onQuickReplies: (replies) => {
        console.log('[Widget] Received quick_replies:', JSON.stringify(replies));
        // If we already have a streaming message, attach chips to it.
        // Otherwise (disambiguation short-circuit may emit content+quick_replies
        // back-to-back; the content event creates the message in updateAssistant),
        // fall back to attaching to the last assistant message.
        setMessages(prev => {
          const targetId = streamMsgId;
          // First try the tracked stream message id
          if (targetId) {
            const idx = prev.findIndex(m => m.id === targetId);
            if (idx !== -1) {
              return prev.map((m, i) =>
                i === idx ? { ...m, quickReplies: replies } : m
              );
            }
          }
          // Fallback: last assistant message that isn't typing
          for (let i = prev.length - 1; i >= 0; i--) {
            const m = prev[i];
            if (m.role === 'assistant' && m.content !== '__TYPING__') {
              return prev.map((mm, j) =>
                j === i ? { ...mm, quickReplies: replies } : mm
              );
            }
          }
          return prev;
        });
      },
      onContacts: (contacts) => {
        setMessages(prev => [...prev, {
          id: mid('contacts'),
          role: 'assistant' as const,
          content: contacts,
          timestamp: new Date()
        }]);
      },
      onDone: () => {
        setMessages(prev => prev.filter(m => !m.id.startsWith('typing2-')));
        setIsLoading(false);
        sendingRef.current = false;
        setPendingQuickReply(null);
      },
      onError: (error) => {
        setMessages(prev => {
          const filtered = prev.filter(m => !m.id.startsWith('typing2-'));
          return [...filtered, {
            id: mid('error'),
            role: 'assistant',
            content: `Извините, произошла ошибка: ${error}. Попробуйте повторить вопрос.`,
            timestamp: new Date()
          }];
        });
        setIsLoading(false);
        sendingRef.current = false;
        setPendingQuickReply(null);
      }
    });

    // Step 2: Show thinking phrase after longer typing animation (runs in parallel with API)
    await new Promise(r => setTimeout(r, 3000));
    const thinkingId = mid('thinking');
    setMessages(prev => {
      const withoutTyping = prev.filter(m => m.id !== typingId);
      // Only add thinking phrase + typing2 if stream hasn't already started delivering
      if (!typing2Removed) {
        return [...withoutTyping, {
          id: thinkingId,
          role: 'assistant' as const,
          content: thinkingPhrase,
          timestamp: new Date()
        }, {
          id: mid('typing2'),
          role: 'assistant' as const,
          content: '__TYPING__',
          timestamp: new Date()
        }];
      }
      return withoutTyping;
    });

    // Wait for stream to complete
    await streamPromise;
  }, [input, isLoading, messages, dialogSlots, endpoint]);

  const handleQuickReply = useCallback((value: string) => {
    // Re-entrancy guard: ignore clicks while a request is in flight. The ref
    // catches double-clicks that fire before isLoading flips, the state check
    // covers the rendered-disabled case.
    if (isLoading || sendingRef.current || pendingQuickReply !== null) return;
    setPendingQuickReply(value);
    handleSend(value);
  }, [isLoading, pendingQuickReply, handleSend]);


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
            {messages.filter(m => m.content !== '__TYPING__').map((message, index) => {
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
                            <a {...props} target="_blank" rel="noopener noreferrer" className="text-primary hover:text-primary/80 font-medium no-underline" />
                          ),
                          p: ({ node, ...props }) => <p {...props} className="mb-2 last:mb-0" />,
                          ul: ({ node, ...props }) => <ul {...props} className="list-disc pl-4 mb-2" />,
                          ol: ({ node, ...props }) => <ol {...props} className="list-decimal pl-4 mb-2" />,
                          li: ({ node, ...props }) => <li {...props} className="mb-1" />,
                          strong: ({ node, ...props }) => <strong {...props} className="font-bold text-widget-text" />,
                        }}
                      >
                        {message.content.replace(/\\([()\[\]_*~`])/g, '$1')}
                      </ReactMarkdown>
                    </div>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                  )}
                  
                  {message.products && message.products.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {message.products.map((product) => (
                        <ProductCard key={product.id} product={product} />
                      ))}
                    </div>
                  )}

                  {message.role === 'assistant' && message.quickReplies && message.quickReplies.length > 0 && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      {message.quickReplies.map((qr, i) => {
                        const isPending = pendingQuickReply === qr.value;
                        const isBlocked = isLoading || pendingQuickReply !== null;
                        return (
                          <button
                            key={`${message.id}-qr-${i}`}
                            type="button"
                            onClick={() => handleQuickReply(qr.value)}
                            disabled={isBlocked}
                            aria-busy={isPending}
                            className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors disabled:cursor-not-allowed ${
                              isPending
                                ? 'bg-primary text-primary-foreground border-primary opacity-90'
                                : 'bg-primary/15 text-primary border-primary/30 hover:bg-primary/25 disabled:opacity-50'
                            }`}
                          >
                            {isPending ? (
                              <span className="inline-flex items-center gap-1.5">
                                <span className="w-3 h-3 border-2 border-primary-foreground/40 border-t-primary-foreground rounded-full animate-spin" />
                                {qr.label}
                              </span>
                            ) : qr.label}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
              );
            })}

            {messages.some(m => m.content === '__TYPING__') && (
              <div className="flex justify-start">
                <div className="chat-message-bot rounded-2xl px-4 py-3">
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
                onClick={() => handleSend()}
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
