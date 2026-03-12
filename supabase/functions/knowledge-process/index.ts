import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// ============================================================
// EMBEDDING GENERATION via Google Gemini text-embedding-004
// ============================================================

async function getGoogleApiKey(supabase: any): Promise<string | null> {
  try {
    const { data } = await supabase
      .from('app_settings')
      .select('google_api_key')
      .limit(1)
      .single();
    if (data?.google_api_key) {
      // May have multiple comma-separated keys; use first one
      const keys = data.google_api_key.split(/[,\n]/).map((k: string) => k.trim()).filter((k: string) => k.length > 0);
      return keys[0] || null;
    }
    return null;
  } catch {
    return null;
  }
}

async function generateEmbedding(text: string, googleApiKey: string | null): Promise<number[] | null> {
  if (!googleApiKey) {
    console.log('[Embedding] No Google API key available, skipping embedding generation');
    return null;
  }

  // Truncate to ~8000 tokens (~24000 chars) to stay within model limits
  const truncated = text.substring(0, 24000);
  
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${googleApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/gemini-embedding-001',
          content: {
            parts: [{ text: truncated }]
          },
          taskType: 'RETRIEVAL_DOCUMENT',
          outputDimensionality: 768,
        }),
      }
    );

    if (!response.ok) {
      const errText = await response.text();
      console.error(`[Embedding] API error ${response.status}:`, errText);
      return null;
    }

    const data = await response.json();
    const values = data?.embedding?.values;
    if (!values || !Array.isArray(values)) {
      console.error('[Embedding] Unexpected response format:', JSON.stringify(data).substring(0, 200));
      return null;
    }

    console.log(`[Embedding] Generated ${values.length}-dim embedding for ${truncated.length} chars`);
    return values;
  } catch (error) {
    console.error('[Embedding] Error:', error);
    return null;
  }
}

async function generateQueryEmbedding(text: string, googleApiKey: string | null): Promise<number[] | null> {
  if (!googleApiKey) return null;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${googleApiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'models/gemini-embedding-001',
          content: {
            parts: [{ text: text.substring(0, 2000) }]
          },
          taskType: 'RETRIEVAL_QUERY',
          outputDimensionality: 768,
        }),
      }
    );

    if (!response.ok) {
      console.error(`[Embedding] Query embedding error: ${response.status}`);
      return null;
    }

    const data = await response.json();
    return data?.embedding?.values || null;
  } catch (error) {
    console.error('[Embedding] Query embedding error:', error);
    return null;
  }
}

// ============================================================
// DOCUMENT CHUNKING
// ============================================================

interface Chunk {
  title: string;
  content: string;
}

/**
 * Split large text into semantic chunks.
 * - Splits on paragraph/section boundaries
 * - Each chunk ~1500-2500 chars with ~200 char overlap
 * - Preserves table structures (doesn't split mid-table)
 */
function chunkDocument(title: string, content: string, maxChunkSize: number = 2000): Chunk[] {
  // Small documents don't need chunking
  if (content.length <= maxChunkSize * 1.5) {
    return [{ title, content }];
  }

  const chunks: Chunk[] = [];
  
  // Split into paragraphs/sections
  const sections = content.split(/\n{2,}/);
  
  let currentChunk = '';
  let chunkIndex = 0;
  const overlap = 200;

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i].trim();
    if (!section) continue;

    // If adding this section would exceed limit, finalize current chunk
    if (currentChunk.length > 0 && currentChunk.length + section.length + 2 > maxChunkSize) {
      chunkIndex++;
      chunks.push({
        title: chunks.length === 0 ? title : `${title} — часть ${chunkIndex}`,
        content: currentChunk.trim(),
      });
      
      // Start new chunk with overlap from end of previous
      const overlapText = currentChunk.slice(-overlap);
      currentChunk = overlapText + '\n\n' + section;
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + section;
    }
  }

  // Don't forget the last chunk
  if (currentChunk.trim()) {
    chunkIndex++;
    chunks.push({
      title: chunks.length === 0 ? title : `${title} — часть ${chunkIndex}`,
      content: currentChunk.trim(),
    });
  }

  // If chunking resulted in only 1 chunk, just return as-is
  if (chunks.length <= 1) {
    return [{ title, content }];
  }

  console.log(`[Chunking] Split "${title}" into ${chunks.length} chunks (${content.length} total chars)`);
  return chunks;
}

// ============================================================
// URL SCRAPING
// ============================================================

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

    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : url;

    let content = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');

    const mainContentMatch = content.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ||
                             content.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ||
                             content.match(/<div[^>]*class="[^"]*content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    
    if (mainContentMatch) {
      content = mainContentMatch[1];
    }

    content = content.replace(/<[^>]+>/g, ' ');
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

// ============================================================
// PDF EXTRACTION via Gemini Vision (for server-side processing)
// ============================================================

async function extractPdfText(base64Content: string, apiKey: string): Promise<{ title: string; content: string }> {
  console.log(`[PDF] Extracting text from PDF (${base64Content.length} base64 chars)...`);
  
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
              text: `Извлеки весь текст из этого PDF документа. КРИТИЧЕСКИ ВАЖНО для таблиц:
- Сохрани структуру таблиц в формате markdown (| столбец1 | столбец2 |)
- Каждая строка таблицы на отдельной строке
- Сохрани заголовки столбцов
- Сохрани ВСЕ числовые данные и единицы измерения
- Для обычного текста сохрани заголовки и абзацы`
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
  
  const lines = content.split('\n').filter((l: string) => l.trim());
  const title = lines[0]?.substring(0, 100) || 'PDF документ';
  
  console.log(`[PDF] Extracted ${content.length} chars, title: "${title}"`);
  
  return { title, content };
}

// ============================================================
// HELPER: Save entry with chunking + embedding
// ============================================================

async function saveWithChunksAndEmbeddings(
  supabase: any,
  type: string,
  title: string,
  content: string,
  sourceUrl: string | null,
  googleApiKey: string | null,
): Promise<{ id: string; type: string; title: string; content: string; source_url?: string; created_at: string }> {
  
  const chunks = chunkDocument(title, content);
  
  let firstEntry: any = null;
  
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    
    // Generate embedding for each chunk
    const embedding = await generateEmbedding(chunk.content, googleApiKey);
    
    const insertData: any = {
      type,
      title: chunk.title,
      content: chunk.content.substring(0, 200000),
      source_url: sourceUrl,
    };
    
    if (embedding) {
      insertData.embedding = JSON.stringify(embedding);
    }
    
    const { data, error } = await supabase
      .from('knowledge_entries')
      .insert(insertData)
      .select()
      .single();

    if (error) {
      console.error(`[Knowledge] Insert error for chunk ${i}:`, error);
      throw new Error(`Ошибка сохранения: ${error.message}`);
    }

    if (i === 0) firstEntry = data;
    console.log(`[Knowledge] Saved chunk ${i + 1}/${chunks.length}: ${data.id}`);
  }

  return {
    id: firstEntry.id,
    type: firstEntry.type,
    title: firstEntry.title,
    content: firstEntry.content.substring(0, 200) + '...',
    source_url: firstEntry.source_url || undefined,
    created_at: firstEntry.created_at,
  };
}

// ============================================================
// MAIN HANDLER
// ============================================================

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
    
    // Get Google API key for embeddings
    const googleApiKey = await getGoogleApiKey(supabase);
    if (!googleApiKey) {
      console.log('[Knowledge] Warning: No Google API key, embeddings will be skipped');
    }

    console.log(`[Knowledge] Action: ${action}`);

    // ==================== FETCH SITEMAP ====================
    if (action === 'fetch_sitemap') {
      if (!url) throw new Error('URL is required');

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
      const urls: string[] = [];
      
      const sitemapIndexMatches = xml.matchAll(/<sitemap>\s*<loc>([^<]+)<\/loc>/gi);
      const subSitemaps: string[] = [];
      for (const match of sitemapIndexMatches) {
        subSitemaps.push(match[1].trim());
      }

      if (subSitemaps.length > 0) {
        console.log(`[Sitemap] Found sitemap index with ${subSitemaps.length} sub-sitemaps`);
        for (const subUrl of subSitemaps.slice(0, 10)) {
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
        const locMatches = xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>/gi);
        for (const match of locMatches) {
          urls.push(match[1].trim());
        }
      }

      if (urls.length === 0) {
        const simpleLocs = xml.matchAll(/<loc>([^<]+)<\/loc>/gi);
        for (const match of simpleLocs) {
          const u = match[1].trim();
          if (u.startsWith('http') && !u.endsWith('.xml')) {
            urls.push(u);
          }
        }
      }

      const uniqueUrls = [...new Set(urls)];
      console.log(`[Sitemap] Found ${uniqueUrls.length} unique URLs`);

      return new Response(
        JSON.stringify({ success: true, urls: uniqueUrls }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ==================== SCRAPE URL ====================
    if (action === 'scrape_url') {
      if (!url) throw new Error('URL is required');

      const { title: extractedTitle, content } = await scrapeUrl(url);
      
      if (content.length < 50) {
        throw new Error('Страница содержит слишком мало текста');
      }

      const entry = await saveWithChunksAndEmbeddings(supabase, 'url', extractedTitle, content, url, googleApiKey);

      return new Response(
        JSON.stringify({ success: true, entry }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ==================== ADD TEXT ====================
    if (action === 'add_text') {
      if (!text || !title) throw new Error('Text and title are required');

      const entry = await saveWithChunksAndEmbeddings(
        supabase, entryType || 'text', title, text, null, googleApiKey
      );

      return new Response(
        JSON.stringify({ success: true, entry }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ==================== PROCESS PDF (server-side via Gemini Vision) ====================
    if (action === 'process_pdf') {
      if (!pdfBase64) throw new Error('PDF content is required');

      const { title: extractedTitle, content } = await extractPdfText(pdfBase64, LOVABLE_API_KEY);
      
      if (content.length < 50) {
        throw new Error('PDF содержит слишком мало текста');
      }

      const entry = await saveWithChunksAndEmbeddings(
        supabase, 'pdf', title || extractedTitle, content, null, googleApiKey
      );

      return new Response(
        JSON.stringify({ success: true, entry }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ==================== REFRESH URL ====================
    if (action === 'refresh_url') {
      if (!entryId) throw new Error('Entry ID is required');

      const { data: existingEntry, error: fetchError } = await supabase
        .from('knowledge_entries')
        .select('*')
        .eq('id', entryId)
        .single();

      if (fetchError || !existingEntry) throw new Error('Запись не найдена');
      if (!existingEntry.source_url) throw new Error('У записи нет URL для обновления');

      const { title: extractedTitle, content } = await scrapeUrl(existingEntry.source_url);
      
      // Generate new embedding
      const embedding = await generateEmbedding(content, googleApiKey);

      const updateData: any = {
        title: extractedTitle,
        content: content.substring(0, 200000),
        updated_at: new Date().toISOString(),
      };
      if (embedding) {
        updateData.embedding = JSON.stringify(embedding);
      }

      const { data, error } = await supabase
        .from('knowledge_entries')
        .update(updateData)
        .eq('id', entryId)
        .select()
        .single();

      if (error) throw new Error(`Ошибка обновления: ${error.message}`);

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

    // ==================== DELETE ====================
    if (action === 'delete') {
      if (!entryId) throw new Error('Entry ID is required');

      const { error } = await supabase
        .from('knowledge_entries')
        .delete()
        .eq('id', entryId);

      if (error) throw new Error(`Ошибка удаления: ${error.message}`);

      console.log(`[Knowledge] Deleted entry: ${entryId}`);

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ==================== LIST ====================
    if (action === 'list') {
      const { data, error } = await supabase
        .from('knowledge_entries')
        .select('id, type, title, content, source_url, created_at, updated_at')
        .order('created_at', { ascending: false });

      if (error) throw new Error(`Ошибка загрузки: ${error.message}`);

      const entries = (data || []).map((e: any) => ({
        ...e,
        content: e.content.substring(0, 200) + (e.content.length > 200 ? '...' : ''),
      }));

      console.log(`[Knowledge] Listed ${entries.length} entries`);

      return new Response(
        JSON.stringify({ success: true, entries }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ==================== SEARCH (hybrid) ====================
    if (action === 'search') {
      const { query, limit = 5 } = await req.json();
      
      if (!query) throw new Error('Query is required');

      // Generate query embedding for vector search
      const queryEmbedding = await generateQueryEmbedding(query, googleApiKey);

      // Use hybrid search
      const rpcParams: any = {
        search_query: query,
        match_count: limit,
      };
      if (queryEmbedding) {
        rpcParams.query_embedding = JSON.stringify(queryEmbedding);
      }

      const { data, error } = await supabase.rpc('search_knowledge_hybrid', rpcParams);

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

    // ==================== REGENERATE EMBEDDINGS ====================
    if (action === 'regenerate_embeddings') {
      if (!googleApiKey) {
        throw new Error('Google API key не настроен. Добавьте его в настройках.');
      }

      // Fetch all entries without embeddings (or all if force=true)
      const { data: entries, error: fetchErr } = await supabase
        .from('knowledge_entries')
        .select('id, title, content')
        .is('embedding', null)
        .order('created_at', { ascending: true });

      if (fetchErr) throw new Error(`Ошибка загрузки: ${fetchErr.message}`);

      const total = entries?.length || 0;
      console.log(`[Embeddings] Regenerating for ${total} entries without embeddings`);

      let processed = 0;
      let errors = 0;

      for (const entry of (entries || [])) {
        try {
          const embedding = await generateEmbedding(entry.content, googleApiKey);
          if (embedding) {
            const { error: updErr } = await supabase
              .from('knowledge_entries')
              .update({ embedding: JSON.stringify(embedding) })
              .eq('id', entry.id);
            if (updErr) {
              console.error(`[Embeddings] Update error for ${entry.id}:`, updErr);
              errors++;
            } else {
              processed++;
            }
          } else {
            errors++;
          }
        } catch (e) {
          console.error(`[Embeddings] Error for ${entry.id}:`, e);
          errors++;
        }
      }

      console.log(`[Embeddings] Done: ${processed} processed, ${errors} errors out of ${total}`);

      return new Response(
        JSON.stringify({ success: true, total, processed, errors }),
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
