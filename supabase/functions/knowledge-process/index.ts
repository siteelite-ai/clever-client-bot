import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// Generate real embeddings using Google's text-embedding-004 model
// Uses Google API keys from app_settings (with multi-key fallback)
async function generateEmbedding(text: string, googleApiKeys: string[]): Promise<number[]> {
  console.log(`[Embedding] Generating real embedding for text (${text.length} chars)...`);
  
  // Truncate text to ~8000 chars to stay within token limits
  const truncated = text.substring(0, 8000);
  
  for (let i = 0; i < googleApiKeys.length; i++) {
    const apiKey = googleApiKeys[i];
    const keyLabel = googleApiKeys.length > 1 ? `key ${i + 1}/${googleApiKeys.length}` : 'key';
    
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'models/text-embedding-004',
            content: { parts: [{ text: truncated }] },
            outputDimensionality: 768,
          }),
        }
      );

      if (response.ok) {
        const data = await response.json();
        const embedding = data.embedding?.values;
        if (!embedding || embedding.length === 0) {
          throw new Error('Empty embedding returned');
        }
        console.log(`[Embedding] Generated ${embedding.length}-dim embedding with ${keyLabel}`);
        return embedding;
      }

      const isRetryable = response.status === 429 || response.status === 500 || response.status === 503;
      if (isRetryable && i < googleApiKeys.length - 1) {
        console.log(`[Embedding] ${response.status} with ${keyLabel}, trying next key...`);
        continue;
      }

      const errorText = await response.text();
      throw new Error(`Embedding API error ${response.status}: ${errorText}`);
    } catch (error) {
      if (i < googleApiKeys.length - 1 && error instanceof TypeError) {
        console.log(`[Embedding] Network error with ${keyLabel}, trying next key...`);
        continue;
      }
      throw error;
    }
  }
  
  throw new Error('All Google API keys exhausted for embedding generation');
}

// Helper to get Google API keys from app_settings
async function getGoogleApiKeys(supabase: any): Promise<string[]> {
  const { data, error } = await supabase
    .from('app_settings')
    .select('google_api_key')
    .limit(1)
    .single();

  if (error || !data?.google_api_key) {
    throw new Error('Google API key не настроен в Настройках. Нужен для генерации эмбеддингов.');
  }

  const keys = data.google_api_key
    .split(/[,\n]/)
    .map((k: string) => k.trim())
    .filter((k: string) => k.length > 0);

  if (keys.length === 0) {
    throw new Error('Google API key пустой. Добавьте ключ в Настройках.');
  }

  return keys;
}

// Extract text content from URL
async function scrapeUrl(url: string): Promise<{ title: string; content: string }> {
  console.log(`[Scrape] Fetching URL: ${url}`);
  
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const html = await response.text();
    console.log(`[Scrape] Received ${html.length} bytes of HTML`);

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : url;

    // Remove scripts, styles, and comments
    let content = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');

    // Extract text from main content areas
    const mainContentMatch = content.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
                             content.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                             content.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    
    if (mainContentMatch) {
      content = mainContentMatch[1];
    }

    // Remove all HTML tags
    content = content.replace(/<[^>]+>/g, ' ');
    
    // Clean up whitespace and special characters
    content = content
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#?\w+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    console.log(`[Scrape] Extracted ${content.length} chars of text, title: "${title}"`);
    
    return { title, content };
  } catch (error) {
    console.error(`[Scrape] Error fetching ${url}:`, error);
    throw new Error(`Не удалось загрузить страницу: ${error instanceof Error ? error.message : 'Неизвестная ошибка'}`);
  }
}

// Extract text from PDF using AI
async function extractPdfText(base64Content: string, apiKey: string): Promise<{ title: string; content: string }> {
  console.log(`[PDF] Extracting text from PDF (${base64Content.length} base64 chars)...`);
  
  // Use Gemini's vision capabilities to read PDF
  const response = await fetch('https://ai.gateway.lovable.dev/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'google/gemini-3-flash-preview',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Извлеки весь текст из этого PDF документа. Верни структурированный текст с сохранением заголовков и параграфов. В начале укажи заголовок документа если он есть.'
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:application/pdf;base64,${base64Content}`
              }
            }
          ]
        }
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[PDF] API error: ${response.status}`, errorText);
    throw new Error(`Ошибка обработки PDF: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  
  // Try to extract title from first line
  const lines = content.split('\n').filter((l: string) => l.trim());
  const title = lines[0]?.substring(0, 100) || 'PDF документ';
  
  console.log(`[PDF] Extracted ${content.length} chars, title: "${title}"`);
  
  return { title, content };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { action, url, text, title, pdfBase64, entryId, entryType } = await req.json();
    
    const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
    const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    
    if (!LOVABLE_API_KEY) {
      throw new Error('LOVABLE_API_KEY is not configured');
    }
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      throw new Error('Supabase configuration missing');
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    
    // Load Google API keys for embedding generation
    const googleApiKeys = await getGoogleApiKeys(supabase);

    console.log(`[Knowledge] Action: ${action}, Google keys: ${googleApiKeys.length}`);

    if (action === 'fetch_sitemap') {
      // Fetch and parse sitemap XML
      if (!url) {
        throw new Error('URL is required');
      }

      let sitemapUrl = url.trim();
      if (!sitemapUrl.startsWith('http')) {
        sitemapUrl = 'https://' + sitemapUrl;
      }

      console.log(`[Sitemap] Fetching: ${sitemapUrl}`);

      const response = await fetch(sitemapUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SitemapParser/1.0)',
          'Accept': 'application/xml, text/xml, */*',
        },
      });

      if (!response.ok) {
        throw new Error(`Ошибка загрузки sitemap: HTTP ${response.status}`);
      }

      const xml = await response.text();
      console.log(`[Sitemap] Received ${xml.length} bytes`);

      // Parse URLs from sitemap XML
      const urls: string[] = [];
      
      // Check if it's a sitemap index (contains other sitemaps)
      const sitemapIndexMatches = xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>/gi);
      const subSitemaps: string[] = [];
      for (const match of sitemapIndexMatches) {
        subSitemaps.push(match[1].trim());
      }

      if (subSitemaps.length > 0) {
        // It's a sitemap index - fetch each sub-sitemap
        console.log(`[Sitemap] Found sitemap index with ${subSitemaps.length} sub-sitemaps`);
        for (const subUrl of subSitemaps.slice(0, 10)) { // Limit to 10 sub-sitemaps
          try {
            const subResponse = await fetch(subUrl, {
              headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SitemapParser/1.0)' },
            });
            if (subResponse.ok) {
              const subXml = await subResponse.text();
              const locMatches = subXml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>/gi);
              for (const m of locMatches) {
                urls.push(m[1].trim());
              }
            }
          } catch (e) {
            console.error(`[Sitemap] Error fetching sub-sitemap ${subUrl}:`, e);
          }
        }
      } else {
        // Regular sitemap
        const locMatches = xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>/gi);
        for (const match of locMatches) {
          urls.push(match[1].trim());
        }
      }

      // Also try simple <loc> tags (some sitemaps don't wrap in <url>)
      if (urls.length === 0) {
        const simpleLocs = xml.matchAll(/<loc>([^<]+)<\/loc>/gi);
        for (const match of simpleLocs) {
          const u = match[1].trim();
          if (u.startsWith('http') && !u.endsWith('.xml')) {
            urls.push(u);
          }
        }
      }

      // Deduplicate
      const uniqueUrls = [...new Set(urls)];
      console.log(`[Sitemap] Found ${uniqueUrls.length} unique URLs`);

      return new Response(
        JSON.stringify({ success: true, urls: uniqueUrls }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'scrape_url') {
      // Scrape URL and add to knowledge base
      if (!url) {
        throw new Error('URL is required');
      }

      const { title: extractedTitle, content } = await scrapeUrl(url);
      
      if (content.length < 50) {
        throw new Error('Страница содержит слишком мало текста');
      }

      // Generate embedding
      const embedding = await generateEmbedding(content, googleApiKeys);

      // Insert into database
      const { data, error } = await supabase
        .from('knowledge_entries')
        .insert({
          type: 'url',
          title: extractedTitle,
          content: content.substring(0, 200000), // Limit content size
          source_url: url,
          embedding,
        })
        .select()
        .single();

      if (error) {
        console.error('[Knowledge] Insert error:', error);
        throw new Error(`Ошибка сохранения: ${error.message}`);
      }

      console.log(`[Knowledge] Added URL entry: ${data.id}`);

      return new Response(
        JSON.stringify({ 
          success: true, 
          entry: {
            id: data.id,
            type: data.type,
            title: data.title,
            content: data.content.substring(0, 200) + '...',
            source_url: data.source_url,
            created_at: data.created_at,
          }
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'add_text') {
      // Add manual text entry
      if (!text || !title) {
        throw new Error('Text and title are required');
      }

      // Generate embedding
      const embedding = await generateEmbedding(text, googleApiKeys);

      // Insert into database
      const { data, error } = await supabase
        .from('knowledge_entries')
        .insert({
          type: entryType || 'text',
          title,
          content: text.substring(0, 200000),
          embedding,
        })
        .select()
        .single();

      if (error) {
        console.error('[Knowledge] Insert error:', error);
        throw new Error(`Ошибка сохранения: ${error.message}`);
      }

      console.log(`[Knowledge] Added text entry: ${data.id}`);

      return new Response(
        JSON.stringify({ 
          success: true, 
          entry: {
            id: data.id,
            type: data.type,
            title: data.title,
            content: data.content.substring(0, 200) + '...',
            created_at: data.created_at,
          }
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'process_pdf') {
      // Process PDF and add to knowledge base
      if (!pdfBase64) {
        throw new Error('PDF content is required');
      }

      const { title: extractedTitle, content } = await extractPdfText(pdfBase64, LOVABLE_API_KEY);
      
      if (content.length < 50) {
        throw new Error('PDF содержит слишком мало текста');
      }

      // Generate embedding
      const embedding = await generateEmbedding(content, googleApiKeys);

      // Insert into database
      const { data, error } = await supabase
        .from('knowledge_entries')
        .insert({
          type: 'pdf',
          title: title || extractedTitle,
          content: content.substring(0, 200000),
          embedding,
        })
        .select()
        .single();

      if (error) {
        console.error('[Knowledge] Insert error:', error);
        throw new Error(`Ошибка сохранения: ${error.message}`);
      }

      console.log(`[Knowledge] Added PDF entry: ${data.id}`);

      return new Response(
        JSON.stringify({ 
          success: true, 
          entry: {
            id: data.id,
            type: data.type,
            title: data.title,
            content: data.content.substring(0, 200) + '...',
            created_at: data.created_at,
          }
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'refresh_url') {
      // Re-scrape URL and update entry
      if (!entryId) {
        throw new Error('Entry ID is required');
      }

      // Get current entry
      const { data: entry, error: fetchError } = await supabase
        .from('knowledge_entries')
        .select('*')
        .eq('id', entryId)
        .single();

      if (fetchError || !entry) {
        throw new Error('Запись не найдена');
      }

      if (!entry.source_url) {
        throw new Error('У записи нет URL для обновления');
      }

      const { title: extractedTitle, content } = await scrapeUrl(entry.source_url);
      
      // Generate new embedding
      const embedding = generateEmbedding(content);

      // Update entry
      const { data, error } = await supabase
        .from('knowledge_entries')
        .update({
          title: extractedTitle,
          content: content.substring(0, 200000),
          embedding,
          updated_at: new Date().toISOString(),
        })
        .eq('id', entryId)
        .select()
        .single();

      if (error) {
        console.error('[Knowledge] Update error:', error);
        throw new Error(`Ошибка обновления: ${error.message}`);
      }

      console.log(`[Knowledge] Refreshed URL entry: ${data.id}`);

      return new Response(
        JSON.stringify({ 
          success: true, 
          entry: {
            id: data.id,
            type: data.type,
            title: data.title,
            content: data.content.substring(0, 200) + '...',
            source_url: data.source_url,
            updated_at: data.updated_at,
          }
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'delete') {
      // Delete entry
      if (!entryId) {
        throw new Error('Entry ID is required');
      }

      const { error } = await supabase
        .from('knowledge_entries')
        .delete()
        .eq('id', entryId);

      if (error) {
        console.error('[Knowledge] Delete error:', error);
        throw new Error(`Ошибка удаления: ${error.message}`);
      }

      console.log(`[Knowledge] Deleted entry: ${entryId}`);

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'list') {
      // List all entries
      const { data, error } = await supabase
        .from('knowledge_entries')
        .select('id, type, title, content, source_url, created_at, updated_at')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('[Knowledge] List error:', error);
        throw new Error(`Ошибка загрузки: ${error.message}`);
      }

      // Truncate content for list view
      const entries = (data || []).map(e => ({
        ...e,
        content: e.content.substring(0, 200) + (e.content.length > 200 ? '...' : ''),
      }));

      console.log(`[Knowledge] Listed ${entries.length} entries`);

      return new Response(
        JSON.stringify({ success: true, entries }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (action === 'search') {
      // Semantic search in knowledge base
      const { query, limit = 5 } = await req.json();
      
      if (!query) {
        throw new Error('Query is required');
      }

      // Generate query embedding
      const queryEmbedding = generateEmbedding(query);

      // Search using the database function
      const { data, error } = await supabase.rpc('search_knowledge', {
        query_embedding: queryEmbedding,
        match_threshold: 0.5,
        match_count: limit,
      });

      if (error) {
        console.error('[Knowledge] Search error:', error);
        throw new Error(`Ошибка поиска: ${error.message}`);
      }

      console.log(`[Knowledge] Found ${data?.length || 0} results for "${query}"`);

      return new Response(
        JSON.stringify({ success: true, results: data || [] }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    throw new Error(`Unknown action: ${action}`);

  } catch (error) {
    console.error('[Knowledge] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Неизвестная ошибка';
    
    return new Response(
      JSON.stringify({ success: false, error: errorMessage }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
