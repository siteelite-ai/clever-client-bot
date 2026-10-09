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

// V1/V2/V3 routing — endpoint is resolved once at widget mount via widget-config.
// V1 = legacy frozen pipeline (chat-consultant).
// V2 = spec-based pipeline (chat-consultant-v2).
// V3 = Expert Orchestrator with Claude tool calling (chat-consultant-v3) —
//      streams its own SSE envelope `{v3_event: {...}}` for tool events,
//      bubble breaks, products_block, contacts, quick_replies, slot_update.
//      `delta` events still travel in the legacy `{choices:[{delta:{content}}]}`
//      shape, so the streaming parser stays compatible.
// V3-only routing. All requests go to chat-consultant-v3 unconditionally.
// V1/V2 pipelines are deprecated for the widget — no fallback, no race.
type PipelineVersion = 'v3';
const V3_ENDPOINT = `${SUPABASE_URL}/functions/v1/chat-consultant-v3`;

type Msg = { role: 'user' | 'assistant'; content: string };

interface QuickReplyEvent {
  facetKey: string;
  replies: QuickReply[];
}

interface ActiveChoice extends QuickReplyEvent {
  mode: 'options' | 'freeform';
  messageId: string;
  slotId: string;
  sessionId: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const normalizeReplies = (value: unknown): QuickReply[] | null => {
  if (!Array.isArray(value) || value.length < 2 || value.length > 5) return null;
  const seen = new Set<string>();
  const replies: QuickReply[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.value !== 'string' ||
        typeof item.label !== 'string' || !item.value.trim() ||
        !item.label.trim() || item.value !== item.value.trim() ||
        item.value.length > 2000 || item.label.length > 160 ||
        seen.has(item.value)) return null;
    seen.add(item.value);
    replies.push({ value: item.value, label: item.label });
  }
  return replies;
};

const normalizeQuickReplyEvent = (event: unknown): QuickReplyEvent | null => {
  if (!isRecord(event) || typeof event.facet_key !== 'string' ||
      !event.facet_key.trim() || event.facet_key.length > 128) return null;
  const replies = normalizeReplies(event.replies);
  return replies ? { facetKey: event.facet_key, replies } : null;
};

const choiceFromPendingSlot = (
  slots: DialogSlots,
  event: QuickReplyEvent | null,
): Pick<ActiveChoice, 'mode' | 'slotId' | 'facetKey' | 'replies'> | null => {
  const pending = slots.pending_clarification;
  if (!isRecord(pending) || pending.status !== 'pending' ||
      typeof pending.slot_id !== 'string' || !pending.slot_id ||
      pending.slot_id.length > 128 ||
      typeof pending.facet_key !== 'string' || !pending.facet_key.trim() ||
      pending.facet_key.length > 128 ||
      typeof pending.question !== 'string' || !pending.question.trim() ||
      !Array.isArray(pending.options)) return null;
  if (pending.options.length === 0) {
    return { mode: 'freeform', slotId: pending.slot_id,
      facetKey: pending.facet_key, replies: [] };
  }
  if (!event || event.facetKey !== pending.facet_key ||
      pending.options.length !== event.replies.length ||
      !event.replies.every((reply, index) => {
        const option = pending.options[index];
        return isRecord(option) && option.value === reply.value && option.label === reply.label;
      })) return null;
  return { mode: 'options', slotId: pending.slot_id,
    facetKey: pending.facet_key, replies: event.replies };
};

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

type DialogSlots = Record<string, DialogSlot | Record<string, unknown>>;

async function streamChat({
  messages,
  query,
  onDelta,
  onDone,
  onError,
  onContacts,
  onSlotUpdate,
  onQuickReplies,
  onFollowup,
  onTurnBreak,
  onProductsBlock,
  onToolEvent,
  onDiagnostic,
  conversationId,
  dialogSlots,
  endpointUrl,
  pipeline,
}: {
  messages: Msg[];
  /** Явный текст последнего user-сообщения. V2/V3 контракт требует поле `query`/`message`. */
  query: string;
  onDelta: (deltaText: string) => void;
  onDone: (protocolComplete: boolean) => void;
  onError: (error: string) => void;
  onContacts?: (contacts: string) => void;
  onSlotUpdate?: (slots: DialogSlots) => void;
  onQuickReplies?: (event: QuickReplyEvent | null) => void;
  onFollowup?: (text: string) => void;
  /** V3: bubble boundary — finalize current assistant message, next delta opens a new one. */
  onTurnBreak?: (reason: string) => void;
  /** V3: render_products result — emit as its own assistant bubble. */
  onProductsBlock?: (markdown: string, meta: { count: number; total_available?: number }) => void;
  /** V3: tool start/result events — used for debug/telemetry, not rendered by default. */
  onToolEvent?: (ev: { tool: string; phase: 'start' | 'result'; summary?: string; duration_ms?: number }) => void;
  /** V3: correlation with the persisted request log. */
  onDiagnostic?: (ev: { log_id: string | null; phase: 'start' | 'complete'; products_count?: number; error?: string | null }) => void;
  conversationId: string;
  dialogSlots: DialogSlots;
  endpointUrl: string;
  pipeline: PipelineVersion;
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

    // Idempotency key required by both pipelines.
    const messageId = globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random()}`;

    // Body shape depends on pipeline.
    // V3 contract: { message, messageId, sessionId, history:[{role,content}] }.
    // V1/V2: backward-compat { conversationId, query, messages, dialogSlots, messageId }.
    const body = pipeline === 'v3'
      ? {
          message: query,
          messageId,
          sessionId: conversationId,
          history: messages
            .filter(m => m.role === 'user' || m.role === 'assistant')
            .slice(0, -1) // last user turn is in `message`
            .map(m => ({ role: m.role, content: m.content })),
          slots: activeSlots,
        }
      : {
          conversationId,
          query,
          messages: messages.map(m => ({ role: m.role, content: m.content })),
          dialogSlots: activeSlots,
          messageId,
        };


    const resp = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify(body),
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
          // [DONE] is the terminal protocol marker. Waiting for the proxy to
          // close its stream can leave the UI loading indefinitely.
          textBuffer = '';
          void reader.cancel().catch(() => {});
          break;
        }

        try {
          const parsed = JSON.parse(jsonStr);
          // V3 SSE envelope: { v3_event: { type, ... } }
          if (parsed.v3_event) {
            const ev = parsed.v3_event;
            switch (ev.type) {
              case 'delta':
                if (typeof ev.content === 'string') onDelta(ev.content);
                break;
              case 'assistant_turn_break':
                onTurnBreak?.(ev.reason ?? 'tool_pending');
                break;
              case 'tool_event':
                onToolEvent?.(ev);
                break;
              case 'diagnostic':
                onDiagnostic?.(ev);
                break;
              case 'products_block':
                if (typeof ev.markdown === 'string') {
                  onProductsBlock?.(ev.markdown, { count: ev.count ?? 0, total_available: ev.total_available });
                }
                break;
              case 'contacts':
                if (typeof ev.html === 'string') onContacts?.(ev.html);
                break;
              case 'quick_replies':
                onQuickReplies?.(normalizeQuickReplyEvent(ev));
                break;
              case 'slot_update':
                if (ev.slots && typeof ev.slots === 'object') onSlotUpdate?.(ev.slots);
                break;
            }
            continue;
          }
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
            onQuickReplies(normalizeQuickReplyEvent({
              facet_key: parsed.facet_key, replies: parsed.quick_replies,
            }));
            continue;
          }
          if (parsed.followup?.text && onFollowup) {
            onFollowup(parsed.followup.text);
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
        if (jsonStr === '[DONE]') {
          streamDone = true;
          continue;
        }
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed.v3_event) {
            const ev = parsed.v3_event;
            switch (ev.type) {
              case 'delta':
                if (typeof ev.content === 'string') onDelta(ev.content);
                break;
              case 'assistant_turn_break':
                onTurnBreak?.(ev.reason ?? 'tool_pending');
                break;
              case 'tool_event':
                onToolEvent?.(ev);
                break;
              case 'diagnostic':
                onDiagnostic?.(ev);
                break;
              case 'products_block':
                if (typeof ev.markdown === 'string') {
                  onProductsBlock?.(ev.markdown, { count: ev.count ?? 0, total_available: ev.total_available });
                }
                break;
              case 'contacts':
                if (typeof ev.html === 'string') onContacts?.(ev.html);
                break;
              case 'quick_replies':
                onQuickReplies?.(normalizeQuickReplyEvent(ev));
                break;
              case 'slot_update':
                if (ev.slots && typeof ev.slots === 'object') onSlotUpdate?.(ev.slots);
                break;
            }
            continue;
          }
          if (parsed.contacts && onContacts) {
            onContacts(parsed.contacts);
            continue;
          }
          if (parsed.slot_update && onSlotUpdate) {
            onSlotUpdate(parsed.slot_update);
            continue;
          }
          if (Array.isArray(parsed.quick_replies) && onQuickReplies) {
            onQuickReplies(normalizeQuickReplyEvent({
              facet_key: parsed.facet_key, replies: parsed.quick_replies,
            }));
            continue;
          }
          if (parsed.followup?.text && onFollowup) {
            onFollowup(parsed.followup.text);
            continue;
          }
          const content = parsed.choices?.[0]?.delta?.content as string | undefined;
          if (content) onDelta(content);
        } catch { /* ignore */ }
      }
    }

    onDone(streamDone);
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
  // Статичное приветствие виджета (UI-уровень, до первого хода пользователя).
  // Это НЕ нарушает Core-правило «ABSOLUTE BAN on greetings» — правило относится
  // к ответам LLM (бот не здоровается в репликах, см. stripGreeting в embed.js).
  // Здесь же это статичный onboarding-баннер, идентичный embed.js.
  const WELCOME_MESSAGE =
    'Здравствуйте! 👋 Я AI-консультант 220volt.kz. Помогу подобрать электроинструменты, расскажу о доставке и оплате. Что вас интересует?';
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: mid('welcome'), role: 'assistant', content: WELCOME_MESSAGE, timestamp: new Date() },
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [dialogSlots, setDialogSlots] = useState<DialogSlots>({});
  const [activeChoice, setActiveChoice] = useState<ActiveChoice | null>(null);
  const conversationIdRef = useRef(crypto.randomUUID());
  const inputRef = useRef<HTMLInputElement>(null);
  const turnIdRef = useRef(0);
  const followupTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => () => {
    turnIdRef.current += 1;
    for (const timer of followupTimersRef.current) clearTimeout(timer);
    followupTimersRef.current.clear();
  }, []);
  // Synchronous re-entrancy guard. setIsLoading(true) is async, so two rapid
  // clicks can both pass the `isLoading` check before React re-renders. A ref
  // flips immediately and blocks any second call.
  const sendingRef = useRef(false);
  // Tracks which quick-reply value is currently in-flight so the chosen chip
  // can show a pressed state while all others are visibly disabled.
  const [pendingQuickReply, setPendingQuickReply] = useState<string | null>(null);

  // Active pipeline endpoint — V3 only, no resolution needed.
  const [endpoint] = useState<{ pipeline: PipelineVersion; url: string }>({
    pipeline: 'v3',
    url: V3_ENDPOINT,
  });
  const endpointReady = true;

  const handleSend = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || !endpointReady || isLoading || sendingRef.current) return;
    sendingRef.current = true;
    const turnId = ++turnIdRef.current;
    const requestSessionId = conversationIdRef.current;
    for (const timer of followupTimersRef.current) clearTimeout(timer);
    followupTimersRef.current.clear();
    setActiveChoice(null);

    const userMessage: ChatMessage = {
      id: mid('user'),
      role: 'user',
      content: text,
      timestamp: new Date()
    };

    setMessages(prev => [...prev, userMessage]);
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
    // V3: when true, the next delta opens a NEW assistant bubble instead of
    // appending to the previous streaming one. Set by onTurnBreak /
    // onProductsBlock; cleared automatically once a new bubble is created.
    let bubbleSealed = false;
    let latestAssistantId: string | null = null;
    let candidateQuickReplies: QuickReplyEvent | null = null;
    let candidateSlots: DialogSlots = dialogSlots;
    let sawSlotUpdate = false;
    let diagnosticComplete = false;
    const pendingFollowups: string[] = [];

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
      if (!displayContent) return;

      // Keep streaming control state synchronous. React may batch several SSE
      // events from one network chunk; mutating these flags inside setState
      // updaters makes the first expert bubble race with the deterministic
      // "Сейчас поищу" bubble and can hide the expert text in the UI.
      const shouldRemoveTyping = !typing2Removed;
      const shouldOpenNewBubble = shouldRemoveTyping || bubbleSealed || !streamMsgId;
      const targetId = shouldOpenNewBubble ? mid('stream') : streamMsgId;

      typing2Removed = true;
      bubbleSealed = false;
      streamMsgId = targetId;
      latestAssistantId = targetId;

      upsertAssistant(prev => {
        const updated = shouldRemoveTyping
          ? prev.filter(m => !m.id.startsWith('typing2-') && !m.id.startsWith('typing-'))
          : prev;

        if (!shouldOpenNewBubble) {
          return updated.map((m) =>
            m.id === targetId ? { ...m, content: displayContent } : m
          );
        }

        return [...updated, {
          id: targetId,
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
      query: text,
      conversationId: conversationIdRef.current,
      dialogSlots,
      endpointUrl: endpoint.url,
      pipeline: endpoint.pipeline,
      onDelta: updateAssistant,
      // V3 only: bubble break — finalize current streaming bubble so the next
      // delta opens a fresh assistant message. For `tool_pending` we also show
      // typing dots until the next delta/products block arrives.
      onTurnBreak: (reason) => {
        assistantContent = '';
        bubbleSealed = true;
        streamMsgId = null;
        latestAssistantId = null;
        // When a tool is about to run, show typing dots until the next
        // bubble (delta or products) arrives.
        if (reason === 'tool_pending') {
          const tId = mid('typing');
          setMessages(prev => [
            ...prev.filter(m => !m.id.startsWith('typing-') && !m.id.startsWith('typing2-')),
            { id: tId, role: 'assistant' as const, content: '__TYPING__', timestamp: new Date() },
          ]);
          // Allow updateAssistant to strip the typing bubble when the next
          // delta arrives (it only strips when typing2Removed is false).
          typing2Removed = false;
        }
      },
      onProductsBlock: (markdown, _meta) => {
        latestAssistantId = null;
        setMessages(prev => {
          const cleaned = prev.filter(m => !m.id.startsWith('typing2-') && !m.id.startsWith('typing-'));
          return [...cleaned, {
            id: mid('products'),
            role: 'assistant' as const,
            content: markdown,
            timestamp: new Date(),
          }];
        });
        assistantContent = '';
        bubbleSealed = true;
      },
      onToolEvent: (ev) => {
        if (ev.phase === 'start') console.log(`[Widget v3] tool ${ev.tool}…`);
        else console.log(`[Widget v3] tool ${ev.tool} → ${ev.summary} (${ev.duration_ms}ms)`);
      },
      onDiagnostic: (ev) => {
        if (ev.phase === 'complete') diagnosticComplete = !ev.error;
        console.info(`[Widget v3] request=${ev.log_id ?? 'unavailable'} phase=${ev.phase} products=${ev.products_count ?? '?'}`);
      },
      onSlotUpdate: (updatedSlots) => {
        console.log('[Widget] Received slot_update:', JSON.stringify(updatedSlots));
        candidateSlots = updatedSlots;
        sawSlotUpdate = true;
        setDialogSlots(updatedSlots);
      },
      onQuickReplies: (event) => {
        candidateQuickReplies = event;
      },
      onContacts: (contacts) => {
        latestAssistantId = null;
        setMessages(prev => [...prev, {
          id: mid('contacts'),
          role: 'assistant' as const,
          content: contacts,
          timestamp: new Date()
        }]);
      },
      onFollowup: (text) => {
        // Wait for the completed turn before scheduling a separate bubble.
        pendingFollowups.push(text);
      },
      onDone: (protocolComplete) => {
        const choice = protocolComplete && diagnosticComplete && sawSlotUpdate
          ? choiceFromPendingSlot(candidateSlots, candidateQuickReplies)
          : null;
        if (choice && latestAssistantId) setActiveChoice({
          ...choice, messageId: latestAssistantId,
          sessionId: requestSessionId,
        });
        // A clarification should not be followed by a delayed, unrelated
        // bubble. A newer user turn or unmount invalidates these timers.
        if (protocolComplete && diagnosticComplete && !choice) {
          for (const text of pendingFollowups) {
            const timer = setTimeout(() => {
              followupTimersRef.current.delete(timer);
              if (turnIdRef.current !== turnId ||
                  conversationIdRef.current !== requestSessionId) return;
              setMessages(prev => [...prev, {
                id: mid('followup'),
                role: 'assistant' as const,
                content: text,
                timestamp: new Date(),
              }]);
            }, 1000);
            followupTimersRef.current.add(timer);
          }
        }
        setMessages(prev => prev.filter(m => !m.id.startsWith('typing2-') && !m.id.startsWith('typing-')));
        setIsLoading(false);
        sendingRef.current = false;
        setPendingQuickReply(null);
      },
      onError: (error) => {
        setMessages(prev => {
          const filtered = prev.filter(m => !m.id.startsWith('typing2-') && !m.id.startsWith('typing-'));
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

    // Wait for stream to complete
    await streamPromise;
  }, [input, endpointReady, isLoading, messages, dialogSlots, endpoint]);

  const choiceIsCurrent = useCallback((choice: ActiveChoice) => {
    if (activeChoice !== choice || choice.sessionId !== conversationIdRef.current ||
        messages[messages.length - 1]?.id !== choice.messageId) return false;
    const verified = choiceFromPendingSlot(dialogSlots,
      choice.mode === 'options' ? choice : null);
    return Boolean(verified && verified.slotId === choice.slotId &&
      verified.mode === choice.mode && verified.facetKey === choice.facetKey);
  }, [activeChoice, dialogSlots, messages]);

  const handleQuickReply = useCallback((choice: ActiveChoice, value: string) => {
    // Re-entrancy guard: ignore clicks while a request is in flight. The ref
    // catches double-clicks that fire before isLoading flips, the state check
    // covers the rendered-disabled case.
    if (isLoading || sendingRef.current || pendingQuickReply !== null ||
        !choiceIsCurrent(choice) || !choice.replies.some(reply => reply.value === value)) return;
    setPendingQuickReply(value);
    handleSend(value);
  }, [isLoading, pendingQuickReply, choiceIsCurrent, handleSend]);

  const handleCustomReply = useCallback((choice: ActiveChoice) => {
    if (!isLoading && !sendingRef.current && choiceIsCurrent(choice)) inputRef.current?.focus();
  }, [isLoading, choiceIsCurrent]);


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
                        {message.content.replace(new RegExp('\\\\([()\\[\\]_*~`])', 'g'), '$1')}
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

                  {message.role === 'assistant' && activeChoice &&
                    activeChoice.messageId === message.id &&
                    choiceIsCurrent(activeChoice) &&
                    !isLoading && (
                    <div className="mt-3 flex flex-wrap gap-2" role="group"
                      aria-label={activeChoice.mode === 'freeform' ? 'Ответить на уточнение' : 'Варианты ответа'}>
                      {activeChoice.replies.map((qr) => (
                        <button
                          key={`${message.id}-qr-${qr.value}`}
                          type="button"
                          onClick={() => handleQuickReply(activeChoice, qr.value)}
                          disabled={pendingQuickReply !== null}
                          aria-busy={pendingQuickReply === qr.value}
                          className="min-h-11 max-w-full break-words px-3 py-2 rounded-full text-xs font-medium border border-primary/30 bg-primary/15 text-primary transition-colors hover:bg-primary/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {qr.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => handleCustomReply(activeChoice)}
                        disabled={pendingQuickReply !== null}
                        className="min-h-11 max-w-full break-words px-3 py-2 rounded-full text-xs font-medium border border-sidebar-border bg-sidebar-accent text-widget-text transition-colors hover:bg-sidebar-accent/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        Напишу свой вариант
                      </button>
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
                ref={inputRef}
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
