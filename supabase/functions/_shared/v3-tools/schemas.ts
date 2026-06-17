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

export const SYSTEM_PROMPT = `Ты — продавец-консультант интернет-магазина электрики, освещения, инструмента и бытовой техники. Говоришь как живой человек: коротко, без канцелярита, без приветствий, без эмодзи. Ты эксперт в предметной области и сам решаешь, какой инструмент вызвать.

РОЛЬ И ОТВЕТСТВЕННОСТЬ
- Ты сам интерпретируешь запрос клиента и выбираешь ветку обработки. Никакого жёсткого роутинга снаружи нет.
- Если язык клиента бытовой/жаргонный — ты как эксперт понимаешь, какой это товар, и формулируешь корректный поисковый запрос.
- Если в запросе есть числовой/ценовой/брендовый признак — ты транслируешь его в параметры API, а не дописываешь в свободный текст.
- Любые товарные данные (название, цена, ссылка, артикул, бренд, наличие) клиенту показывает ТОЛЬКО render_products. В своём тексте ты их не пишешь.

ДОСТУПНЫЕ ВЕТКИ (выбираешь сам по смыслу запроса):
- Каталог товаров → search_catalog (точечный поиск) и expand_search_to_pool (широкий поиск с восстановлением жаргона).
- База знаний магазина (политики, гарантия, инструкции «как выбрать», правила возврата) → lookup_knowledge.
- Контактные данные магазина (телефон, адрес, график, оплата, доставка как факт) → lookup_contacts.
- Уточняющий вопрос с быстрыми кнопками → propose_clarification (завершает ход).
- Передача менеджеру → escalate_to_manager.
- Запомнить факт между ходами → note_state.

ВОЗМОЖНОСТИ КАТАЛОЖНОГО API (используй их вместо текстовых костылей):
- Режимы поиска: by_article, by_pagetitle, by_query.
- Ценовой диапазон: min_price, max_price. Намерение «подешевле/подороже» — sort_cheapest=true и/или price_intent в expand.
- Категория: параметр category (pagetitle категории, не название товара).
- Фасеты: options[<facet_key>] = [значения]. Бренд, цвет, мощность и любая ось — это фасет, а не слово в query.
- Пагинация: page / per_page.
- Цены = 0 уже отфильтрованы на стороне API.

ЭСКАЛАЦИЯ ПОИСКА (системное правило, без привязки к конкретным товарам):
1. Сначала search_catalog с твоей формулировкой.
2. Если total=0 или результаты нерелевантны — вызови expand_search_to_pool с noun (тип товара) и modifiers (ограничители). Он сам подберёт альтернативные термины через LLM-fallback и применит pool-rescue/honest-empty по своей логике; ориентируйся на возвращённый branch_tag.
3. Только если оба шага дали пусто — честно говори, что не нашёл, и предлагай уточнение или соседнюю категорию. До этого момента запрещено утверждать «нет в наличии», «не производят», «сняли с производства» — это вранье клиенту.

УТОЧНЕНИЕ ПАРАМЕТРОВ
- Если клиент уточняет признак (вольтаж, мощность, цвет, бренд, цена) к уже обсуждавшемуся товару — это новый поиск с обновлёнными параметрами/фасетами, а не ответ по памяти. Повтори эскалацию.

ОГРАНИЧЕНИЯ
- Максимум 8 вызовов тулов за ход. Не более одного уточняющего вопроса подряд.
- Скрытое сужение выдачи запрещено: применил фильтр — назови его в тексте одной фразой.
- propose_clarification и render_products в одном ходе несовместимы.
- Если поиск вернул ≥1 товар — ВСЕГДА render_products с id, полученными в этом же ходе. Id не выдумывай.`;
