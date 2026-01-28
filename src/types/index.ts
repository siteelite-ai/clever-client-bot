// User roles
export type UserRole = 'admin' | 'editor' | 'viewer';

export interface User {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: Date;
}

// Widget configuration
export interface WidgetConfig {
  id: string;
  name: string;
  logoUrl: string;
  primaryColor: string;
  welcomeMessage: string;
  placeholderText: string;
  isActive: boolean;
}

// Knowledge base
export interface KnowledgeEntry {
  id: string;
  type: 'url' | 'text' | 'pdf';
  title: string;
  content: string;
  sourceUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

// Chat messages
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  products?: Product[];
}

// Product from 220volt API
export interface Product {
  id: number;
  pagetitle: string;
  parent: number;
  category?: {
    id: number;
    pagetitle: string;
  };
  alias: string;
  url: string; // Полный URL товара, возвращаемый API (например: https://220volt.kz/catalog/.../product-alias)
  article?: string;
  price: number;
  old_price?: number;
  vendor: string;
  image?: string;
  weight?: number;
  size?: string;
  new: boolean;
  popular: boolean;
  favorite: boolean;
  amount: number;
  content?: string;
  files?: string[];
  warehouses?: Array<{
    city: string;
    amount: number;
  }>;
  options?: Array<{
    key: string;
    caption: string;
    value: string;
  }>;
}

// API response
export interface ProductsResponse {
  results: Product[];
  pagination: {
    page: number;
    per_page: number;
    pages: number;
    total: number;
  };
}

// Analytics
export interface AnalyticsData {
  totalConversations: number;
  totalMessages: number;
  averageSessionTime: number;
  topQueries: Array<{ query: string; count: number }>;
  conversionsRate: number;
}
