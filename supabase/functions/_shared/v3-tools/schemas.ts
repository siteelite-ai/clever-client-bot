// V3 tools — OpenRouter tool-call schemas (Claude Sonnet 4.5).
// Data-agnostic: ZERO domain-specific values in descriptions.

export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "search_catalog",
      description:
        "Поиск товаров в каталоге магазина. Используй ОДИН из трёх режимов: by_article (точный SKU), by_pagetitle (точное название товара), by_query (полнотекстовый поиск). Можно ограничить по category (pagetitle категории), цене (min_price/max_price) и фасетам (options). Возвращает массив товаров с id — эти id потом передавай в render_products. price=0 уже отфильтрованы.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["by_article", "by_pagetitle", "by_query"] },
          article: { type: "string" },
          pagetitle: { type: "string" },
          query: { type: "string" },
          category: { type: "string", description: "Pagetitle категории каталога (НЕ название товара)" },
          min_price: { type: "number" },
          max_price: { type: "number" },
          options: {
            type: "object",
            description: "Фасеты вида { \"<facet_key>\": [\"value1\", \"value2\"] }",
            additionalProperties: { type: "array", items: { type: "string" } },
          },
          page: { type: "integer", minimum: 1 },
          per_page: { type: "integer", minimum: 1, maximum: 50 },
          sort_cheapest: { type: "boolean", description: "Серверная сортировка по возрастанию цены" },
        },
        required: ["mode"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_knowledge",
      description:
        "Поиск в базе знаний магазина (FAQ, доставка, политики, гайды «как выбрать»). Используй когда пользователь спрашивает НЕ о конкретных товарах, а об условиях/правилах/общих вопросах. Возвращает релевантные сниппеты.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Поисковый запрос на русском" },
          top_k: { type: "integer", minimum: 1, maximum: 10, default: 5 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "expand_search_to_pool",
      description:
        "«Широкий» поиск когда search_catalog дал 0 или нужен промпт-зависимый pool. Принимает noun (тип товара) и modifiers (ограничители). Возвращает branch_tag: qfv2_final / qfv2_pool_rescue / qfv2_honest_empty / qfv2_jargon_recovery — учитывай его в ответе.",
      parameters: {
        type: "object",
        properties: {
          noun: { type: "string", description: "Главный тип товара (например «фонарь», «розетка»)" },
          modifiers: { type: "array", items: { type: "string" } },
          price_intent: { type: "string", enum: ["cheapest", "most_expensive"] },
          min_price: { type: "number" },
          max_price: { type: "number" },
          brand: { type: "string" },
        },
        required: ["noun"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_contacts",
      description:
        "Прямая ветка инфо о магазине: телефон, адрес, график, оплата, доставка. Используй ВМЕСТО lookup_knowledge когда вопрос ИМЕННО о контактах/реквизитах. Эмитит карточку контактов в виджет — не дублируй цифры в тексте.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", enum: ["phone", "address", "hours", "payment", "delivery", "general"] },
        },
        required: ["topic"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "render_products",
      description:
        "ЕДИНСТВЕННЫЙ способ показать карточки товаров клиенту. Принимает массив id, ранее полученных от search_catalog или expand_search_to_pool в этом же ходе. НЕ изобретай id. После render_products — можешь добавить короткий комментарий-cross-sell (1-3 предложения, без артикулов/цен/ссылок).",
      parameters: {
        type: "object",
        properties: {
          product_ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10 },
          total_available: { type: "integer", minimum: 0 },
        },
        required: ["product_ids"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "propose_clarification",
      description:
        "Задать структурированный уточняющий вопрос с быстрыми ответами (chip-кнопками). Используй когда выдача слишком широкая и одного фасета достаточно чтобы сузить. После вызова ОБЯЗАТЕЛЬНО завершай ход (не показывай товары в том же ходе).",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string" },
          facet_key: { type: "string", description: "Ключ фасета каталога (например price_range, vendor, color)" },
          options: {
            type: "array",
            minItems: 2,
            maxItems: 5,
            items: {
              type: "object",
              properties: {
                value: { type: "string" },
                label: { type: "string" },
                count: { type: "integer" },
              },
              required: ["value"],
              additionalProperties: false,
            },
          },
        },
        required: ["question", "facet_key", "options"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "escalate_to_manager",
      description:
        "Передать клиента менеджеру. Используй когда: запрос вне профиля магазина (повторно), сложный технический вопрос/жалоба, явная просьба клиента, два пустых поиска подряд. Эмитит карточку контактов.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string", enum: ["not_found", "out_of_domain", "error", "user_request"] },
          note: { type: "string" },
        },
        required: ["reason"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "note_state",
      description:
        "Сохранить факт для следующего хода (например «клиент попросил китайские бренды»). Сохраняется в server-side slot-state на 30 мин. Не виден клиенту.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string" },
          value: { },
          ttl_turns: { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["key", "value"],
        additionalProperties: false,
      },
    },
  },
] as const;

export const SYSTEM_PROMPT = `Ты — продавец-консультант интернет-магазина 220volt.kz. Говоришь как живой человек: короткими фразами, без канцелярита, без приветствий, без эмодзи. Ты эксперт в своей области (электрика, освещение, инструменты, бытовая техника).

ПРИНЦИПЫ ОБЩЕНИЯ:
- Сначала отвечай на вопрос пользователя своими словами как эксперт.
- Если запрос требует данных из каталога — коротко скажи «Сейчас гляну что есть» и вызови search_catalog. Если он дал 0 — попробуй expand_search_to_pool (широкий поиск).
- Если запрос о контактах/адресе/графике/доставке/оплате — сразу вызови lookup_contacts (НЕ lookup_knowledge).
- Если запрос об общих условиях магазина (политики, гарантия, гайды «как выбрать») — lookup_knowledge.
- Если запрос вне профиля магазина (повторно) или клиент просит человека — escalate_to_manager.
- Если нужно одно уточнение чтобы сузить выдачу — propose_clarification (и заверши ход).
- Хочешь запомнить факт на следующий ход — note_state.

АНТИ-ГАЛЛЮЦИНАЦИИ (КРИТИЧНО):
- НИКОГДА не пиши URL, цены, артикулы, бренды или название товара в тексте сам.
- Все товары показываются ТОЛЬКО через render_products с id из search_catalog / expand_search_to_pool.
- Если поиск вернул 0 — честно скажи что не нашёл, не выдумывай.
- Если поиск вернул ≥1 товар — ВСЕГДА вызывай render_products. stock — справочно; "in_stock"/"low"/"unknown" валидны.
- Контакты, телефоны, адреса не цитируй текстом — их покажет карточка lookup_contacts.

ОГРАНИЧЕНИЯ:
- Максимум 8 вызовов тулов за ход.
- Не задавай больше одного уточняющего вопроса подряд.
- Не сужай выдачу скрытыми фильтрами. Применил фильтр (категория/цена/бренд) — назови это в тексте.
- propose_clarification и render_products в одном ходе НЕЛЬЗЯ.

ПОРЯДОК В ОДНОМ ХОДЕ (типичный):
1. Короткая фраза-ответ (1-3 предложения экспертного мнения).
2. (опц.) Короткая фраза «Сейчас посмотрю в каталоге».
3. search_catalog → render_products.
4. (опц.) 1-3 предложения cross-sell (без артикулов/цен/ссылок).`;
