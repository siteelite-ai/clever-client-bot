import { useState, useRef, useEffect } from 'react';
import { MessageSquare, X, Send, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatMessage, Product } from '@/types';

interface ChatWidgetProps {
  isPreview?: boolean;
}

export function ChatWidget({ isPreview = false }: ChatWidgetProps) {
  const [isOpen, setIsOpen] = useState(isPreview);
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: '1',
      role: 'assistant',
      content: 'Здравствуйте! 👋 Я консультант 220volt.kz. Помогу подобрать электротехническое оборудование, расскажу о доставке и оплате. Что вас интересует?',
      timestamp: new Date()
    }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
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

    // Simulate AI response (will be replaced with actual API call)
    setTimeout(() => {
      const botMessage: ChatMessage = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: 'Спасибо за ваш вопрос! Сейчас я работаю в демо-режиме. После подключения к Lovable Cloud я смогу искать товары в каталоге и отвечать на вопросы о компании.',
        timestamp: new Date()
      };
      setMessages(prev => [...prev, botMessage]);
      setIsLoading(false);
    }, 1000);
  };

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
              <img 
                src="https://220volt.kz/assets/templates/img/logo.svg" 
                alt="220volt" 
                className="h-8"
              />
              <div>
                <p className="text-sm font-semibold text-widget-text">Консультант</p>
                <div className="flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-success pulse-dot" />
                  <span className="text-xs text-widget-text/60">Онлайн</span>
                </div>
              </div>
            </div>
            {!isPreview && (
              <button
                onClick={() => setIsOpen(false)}
                className="p-2 rounded-lg hover:bg-sidebar-accent transition-colors text-widget-text/60"
              >
                <X className="w-5 h-5" />
              </button>
            )}
          </div>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 widget-scrollbar h-[400px]">
            {messages.map((message) => (
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
                  <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                  
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
            ))}

            {isLoading && (
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

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="p-4 border-t border-sidebar-border">
            <div className="flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSend()}
                placeholder="Напишите сообщение..."
                className="flex-1 bg-sidebar-accent rounded-xl px-4 py-3 text-sm text-widget-text placeholder:text-widget-text/40 focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || isLoading}
                className="w-12 h-12 rounded-xl bg-primary text-primary-foreground flex items-center justify-center transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? (
                  <Loader2 className="w-5 h-5 animate-spin" />
                ) : (
                  <Send className="w-5 h-5" />
                )}
              </button>
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
