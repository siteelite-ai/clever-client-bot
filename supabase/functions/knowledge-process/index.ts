import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// Generate embeddings - tries Google API keys first, falls back to OpenRouter
async function generateEmbedding(text: string, supabase: any): Promise<number[]> {
  console.log(`[Embedding] Generating embedding for text (${text.length} chars)...`);
  const truncated = text.substring(0, 8000);

  // Try Google API keys from app_settings first
  const { data: settings } = await supabase
    .from('app_settings')
    .select('google_api_key, openrouter_api_key')
    .limit(1)
    .single();

  const googleKeys = (settings?.google_api_key || '')
    .split(/[,\n]/)
    .map((k: string) => k.trim())
    .filter((k: string) => k.length > 0);

  // Try Google API keys
  for (let i = 0; i < googleKeys.length; i++) {
    const apiKey = googleKeys[i];
    const keyLabel = googleKeys.length > 1 ? `key ${i + 1}/${googleKeys.length}` : 'key';
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'models/gemini-embedding-001',
            content: { parts: [{ text: truncated }] },
            outputDimensionality: 768,
          }),
        }
      );
      if (response.ok) {
        const data = await response.json();
        const embedding = data.embedding?.values;
        if (embedding && embedding.length > 0) {
          console.log(`[Embedding] Generated ${embedding.length}-dim embedding with Google ${keyLabel}`);
          return embedding;
        }
      }
      const isRetryable = response.status === 429 || response.status === 500 || response.status === 503;
      if (isRetryable && i < googleKeys.length - 1) {
        console.log(`[Embedding] ${response.status} with Google ${keyLabel}, trying next key...`);
        continue;
      }
      if (!isRetryable || i === googleKeys.length - 1) {
        const errorText = await response.text();
        console.warn(`[Embedding] Google ${keyLabel} error ${response.status}: ${errorText}`);
      }
    } catch (error) {
      console.warn(`[Embedding] Google ${keyLabel} network error:`, error);
      if (i < googleKeys.length - 1) continue;
    }
  }

  // Fallback: OpenRouter embedding API
  if (settings?.openrouter_api_key) {
    console.log('[Embedding] Falling back to OpenRouter embeddings...');
    try {
      const response = await fetch('https://openrouter.ai/api/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${settings.openrouter_api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'google/gemini-embedding-001',
          input: truncated,
          dimensions: 768,
        }),
      });
      if (response.ok) {
        const data = await response.json();
        const embedding = data.data?.[0]?.embedding;
        if (embedding && embedding.length > 0) {
          console.log(`[Embedding] Generated ${embedding.length}-dim embedding via OpenRouter`);
          return embedding;
        }
      }
      const errorText = await response.text();
      console.error(`[Embedding] OpenRouter error ${response.status}: ${errorText}`);
    } catch (error) {
      console.error('[Embedding] OpenRouter network error:', error);
    }
  }

  // Last resort: Lovable Gateway
  const lovableKey = Deno.env.get('LOVABLE_API_KEY');
  if (lovableKey) {
    console.log('[Embedding] Falling back to Lovable Gateway...');
    try {
      const response = await fetch('https://ai.gateway.lovable.dev/v1/embeddings', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${lovableKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gemini-embedding-001',
          input: truncated,
          dimensions: 768,
        }),
      });
      if (response.ok) {
        const data = await response.json();
        const embedding = data.data?.[0]?.embedding;
        if (embedding && embedding.length > 0) {
          console.log(`[Embedding] Generated ${embedding.length}-dim embedding via Lovable Gateway`);
          return embedding;
        }
      }
    } catch (error) {
      console.error('[Embedding] Lovable Gateway error:', error);
    }
  }

  throw new Error('Не удалось сгенерировать эмбеддинг. Настройте Google API ключ или OpenRouter API ключ в Настройках.');
}

// Extract validity dates from content (e.g. "с 01.05.2021 по 30.06.2023")
function extractValidityDates(content: string): { valid_from: string | null; valid_until: string | null } {
  // Pattern: с DD.MM.YYYY по DD.MM.YYYY (various separators)
  const datePattern = /(?:с|от|начало|действует\s+с)\s*(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})\s*(?:г\.?\s*)?(?:по|до|—|–|-|конец)\s*(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/i;
  const match = content.match(datePattern);
  
  if (match) {
    const [, d1, m1, y1, d2, m2, y2] = match;
    const from = `${y1}-${m1.padStart(2, '0')}-${d1.padStart(2, '0')}T00:00:00Z`;
    const until = `${y2}-${m2.padStart(2, '0')}-${d2.padStart(2, '0')}T23:59:59Z`;
    console.log(`[Dates] Extracted validity: ${from} → ${until}`);
    return { valid_from: from, valid_until: until };
  }
  
  return { valid_from: null, valid_until: null };
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
    const requestBody = await req.json();
    const { action, url, text, title, pdfBase64, entryId, entryType, offset, batch_size } = requestBody;
    
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
    
    console.log(`[Knowledge] Action: ${action}`);

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

      // Extract validity dates from content
      const { valid_from, valid_until } = extractValidityDates(content);

      // Generate embedding
      const embedding = await generateEmbedding(content, supabase);

      // Insert into database
      const insertData: any = {
        type: 'url',
        title: extractedTitle,
        content: content.substring(0, 200000),
        source_url: url,
        embedding,
      };
      if (valid_from) insertData.valid_from = valid_from;
      if (valid_until) insertData.valid_until = valid_until;

      const { data, error } = await supabase
        .from('knowledge_entries')
        .insert(insertData)
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
      const embedding = await generateEmbedding(text, supabase);

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

    if (action === 'update_text') {
      // Update content of an existing knowledge entry and regenerate embedding
      if (!entryId || !text) {
        throw new Error('entryId and text are required for update_text');
      }

      console.log(`[Knowledge] Updating text for entry ${entryId} (${text.length} chars)`);

      // Generate new embedding
      const embedding = await generateEmbedding(text, supabase);

      // Update content + embedding
      const { data, error } = await supabase
        .from('knowledge_entries')
        .update({
          content: text.substring(0, 200000),
          embedding,
          ...(title ? { title } : {}),
        })
        .eq('id', entryId)
        .select()
        .single();

      if (error) {
        console.error('[Knowledge] Update error:', error);
        throw new Error(`Ошибка обновления: ${error.message}`);
      }

      console.log(`[Knowledge] Updated entry: ${data.id}`);

      return new Response(
        JSON.stringify({
          success: true,
          entry: {
            id: data.id,
            type: data.type,
            title: data.title,
            content: data.content.substring(0, 200) + '...',
            updated_at: data.updated_at,
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
      const embedding = await generateEmbedding(content, supabase);

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
      const embedding = await generateEmbedding(content, supabase);

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
        .select('id, type, title, content, source_url, created_at, updated_at, valid_from, valid_until')
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
      const { query, limit = 5 } = requestBody;
      
      if (!query) {
        throw new Error('Query is required');
      }

      // Generate query embedding
      const queryEmbedding = await generateEmbedding(query, supabase);

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

    if (action === 'regenerate_embeddings') {
      // Regenerate embeddings using Google gemini-embedding-001
      // Supports offset/limit for batching to avoid edge function timeouts
      const batchOffset = offset || 0;
      const batchSize = batch_size || 20;
      console.log(`[Knowledge] Regenerating embeddings batch: offset=${batchOffset}, batch_size=${batchSize}`);

      const { data: entries, error: listError } = await supabase
        .from('knowledge_entries')
        .select('id, title, content')
        .order('created_at', { ascending: true })
        .range(batchOffset, batchOffset + batchSize - 1);

      if (listError) throw new Error(`Ошибка загрузки записей: ${listError.message}`);
      if (!entries || entries.length === 0) {
        return new Response(
          JSON.stringify({ success: true, message: 'Все записи обработаны', processed: 0, done: true }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      let processed = 0;
      let errors = 0;

      for (const entry of entries) {
        try {
          const embedding = await generateEmbedding(entry.content, supabase);
          
          const { error: updateError } = await supabase
            .from('knowledge_entries')
            .update({ embedding })
            .eq('id', entry.id);

          if (updateError) {
            console.error(`[Knowledge] Update error for ${entry.id}:`, updateError);
            errors++;
          } else {
            processed++;
            console.log(`[Knowledge] ✓ ${batchOffset + processed}/${batchOffset + entries.length}: "${entry.title.substring(0, 50)}"`);
          }
        } catch (e) {
          console.error(`[Knowledge] Embedding error for ${entry.id}:`, e);
          errors++;
        }
      }

      const nextOffset = batchOffset + batchSize;
      const done = entries.length < batchSize;
      console.log(`[Knowledge] Batch complete: ${processed} success, ${errors} errors. Done: ${done}`);

      return new Response(
        JSON.stringify({ success: true, processed, errors, batch_size: batchSize, offset: batchOffset, next_offset: done ? null : nextOffset, done }),
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
