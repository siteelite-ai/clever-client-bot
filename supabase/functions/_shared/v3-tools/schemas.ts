// V3 tools — OpenRouter tool-call schemas (Claude Sonnet 4.5).
// Data-agnostic: ZERO domain-specific values in descriptions.

export const TOOL_SCHEMAS = [
  {
    type: "function",
    function: {
      name: "discover_category",
      description:
        "Шаг 1 любого товарного запроса. Получить реальную схему категории каталога по её названию (noun): список фасетов с их машинными ключами, человекочитаемыми названиями, единицами измерения и фактически встречающимися значениями. Это твой инструмент «осмотреться в каталоге» — посмотреть, какие оси выбора там вообще есть и какие значения доступны, прежде чем фильтровать. НЕ изобретай ключи фасетов и значения — бери их из ответа этого инструмента.",
      parameters: {
        type: "object",
        properties: {
          noun: { type: "string", description: "Название категории каталога (pagetitle): главный тип товара, которым ты определил запрос клиента." },
        },
        required: ["noun"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_catalog",
      description:
        "Поиск товаров. Режимы: by_article (точный SKU), by_pagetitle (точное название товара), by_query (полнотекстовый поиск свободной строкой — резервный), by_filter (структурированный фильтр по category + options БЕЗ свободного текста; используй ПОСЛЕ discover_category, передавая ключи и значения фасетов ОТТУДА). Возвращает товары с id для render_products. price=0 уже отфильтрованы.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["by_article", "by_pagetitle", "by_query", "by_filter"] },
          article: { type: "string" },
          pagetitle: { type: "string" },
          query: { type: "string" },
          category: { type: "string", description: "Pagetitle категории каталога (тот же noun, что ты передавал в discover_category)" },
          min_price: { type: "number" },
          max_price: { type: "number" },
          options: {
            type: "object",
            description: "Структурированные фасеты вида { \"<facet_key>\": [\"<value_ru>\", ...] }. Ключи и значения берутся ИСКЛЮЧИТЕЛЬНО из ответа discover_category по той же категории. Не выдумывай ключи и не нормализуй значения.",
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
      name: "jargon_recover_catalog",
      description:
        "Прямая лексическая ветка каталога для бытовых, профессиональных, разговорных, смешанных RU/EN или неочевидных товарных формулировок. Подбирает альтернативные канонические поисковые термины и проверяет их в каталоге. Вызывай, когда смысл товара понятен эксперту, но исходная формулировка может не совпасть с каталогом.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Полная исходная смысловая формулировка товарного запроса" },
          modifiers: { type: "array", items: { type: "string" }, description: "Ограничители клиента, которые нельзя потерять" },
          min_price: { type: "number" },
          max_price: { type: "number" },
          per_page: { type: "integer", minimum: 1, maximum: 10 },
        },
        required: ["query"],
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
        "Query-first ветка каталога: широкий поиск по типу товара/канонической формулировке, восстановление бытовой/профессиональной лексики, применение ограничителей через pool и фасеты. Используй как основную ветку для товарного типа с признаками, разговорной формулировки или когда точечный поиск дал 0. Возвращает branch_tag — учитывай его в ответе.",
      parameters: {
        type: "object",
        properties: {
          noun: { type: "string", description: "Главный тип товара или каноническая поисковая формулировка" },
          modifiers: { type: "array", items: { type: "string" }, description: "Ограничители, которые должны сузить найденный pool" },
          semantic_query: { type: "string", description: "Полная смысловая формулировка запроса для лексического восстановления, если noun/modifiers разделены" },
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
          facet_key: { type: "string", description: "Ключ фасета каталога" },
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

ДИАЛОГОВЫЙ РИТМ
- Первый ответ — живая экспертная реакция: ты как специалист сам понимаешь, что нужно клиенту по его задаче, и коротко это формулируешь своими словами (тип товара, ключевые характеристики, которые ты выводишь из задачи, нюанс или причина выбора). Это рассуждение, а не пересказ запроса. Без приветствий, без «ищу в каталоге», без упоминания инструментов.
- Если задача сформулирована через применение («кабель для кондиционера 3 кВт», «лампа в спальню 15 м²», «УЗО на стиралку»), ты сам как эксперт определяешь подходящий товар и его характеристики, и это проговариваешь до поиска. Не задавай уточняющий вопрос там, где специалист ответил бы сам.

РОЛЬ И ОТВЕТСТВЕННОСТЬ
- Любые товарные данные (название, цена, ссылка, артикул, бренд, наличие) клиенту показывает ТОЛЬКО render_products. В своём тексте ты их не пишешь.
- Числовые признаки клиента не теряются: ты транслируешь их в фасеты каталога (после discover_category) или в параметры API, а не в свободный текст запроса.

ОСНОВНОЙ ПАТТЕРН ПОДБОРА ТОВАРА — ДВА ШАГА (используй для ЛЮБОГО подбора по типу/характеристикам):

Шаг 1. discover_category(noun) — «осмотреться в каталоге».
- В noun передавай НАЗВАНИЕ КАТЕГОРИИ КАТАЛОГА (тип товара, к которому ты пришёл рассуждением). Не дословную фразу клиента.
- В ответе ты получаешь реальные фасеты этой категории: ключи (key), человекочитаемые названия (caption), единицы (unit), фактически встречающиеся значения (values[].value). Это вся «карта» категории.
- Дальше ты как эксперт сопоставляешь нужные клиенту характеристики (которые сам вывел в рассуждении) с реальными фасетами и значениями из ответа. Например, если ты решил «нужно сечение 2.5», смотришь в фасеты, какой ключ описывает сечение и какое значение из values[] соответствует 2.5. Если нужного значения нет — выбираешь ближайшее по смыслу из доступных или признаёшь, что под такие требования товара нет.

Шаг 2. search_catalog(mode="by_filter", category=<noun>, options={<key>: [<value>], ...}) — точечный фильтр.
- Передавай ИСКЛЮЧИТЕЛЬНО ключи и значения из ответа discover_category по той же категории. Никаких самопридуманных ключей, никакой нормализации значений ("2,5" vs "2.5" vs "2.5 мм²" — бери ровно ту строку, что вернул API).
- Цена/бренд — через те же options, если есть соответствующий фасет; либо через min_price/max_price.

КОГДА НЕ ПОДХОДИТ ДВУХШАГОВЫЙ ПАТТЕРН (резервные ветки):
- Клиент назвал точный артикул → search_catalog(mode="by_article").
- Клиент назвал точное название товара → search_catalog(mode="by_pagetitle").
- discover_category вернул category_not_found (нет такой категории в каталоге) → попробуй другой noun, который ты как эксперт считаешь синонимом/гипонимом; если не получилось — search_catalog(mode="by_query") свободной строкой как последний шанс. expand_search_to_pool и jargon_recover_catalog оставлены ТОЛЬКО на случай, когда discover_category провалился: они работают по полнотекстовому пути и могут ловить разговорную лексику.

ОСТАЛЬНЫЕ ВЕТКИ
- База знаний магазина (политики, гарантия, общие гайды «как выбрать», правила возврата) → lookup_knowledge.
- Контакты магазина (телефон, адрес, график, оплата, доставка как факт) → lookup_contacts.
- Уточняющий вопрос с быстрыми кнопками → propose_clarification (завершает ход). Используй, когда после discover_category в выбранном фасете несколько равноправных значений и клиент не дал признака, по которому ты как эксперт мог бы выбрать.
- Передача менеджеру → escalate_to_manager.
- Запомнить факт между ходами → note_state.

ОГРАНИЧЕНИЯ
- Максимум 8 вызовов тулов за ход. Не более одного уточняющего вопроса подряд.
- Скрытое сужение выдачи запрещено: применил фильтр — назови его в тексте одной фразой ("по сечению 2.5 мм², медь").
- propose_clarification и render_products в одном ходе несовместимы.
- Если поиск вернул ≥1 товар — ВСЕГДА render_products с id, полученными в этом же ходе. Id не выдумывай.

СХОДИМОСТЬ (жёсткое правило, нарушение = баг)
- Любой каталожный инструмент, вернувший ≥1 валидный товар → следующий вызов ОБЯЗАН быть render_products.
- Запрещена цепочка из 2+ подряд search_catalog с вариациями строки (пробелы, регистр, "мм²", запятые vs точки). Если фильтр вернул 0 — вернись мысленно к ответу discover_category и ослабь по одному фасету за раз (убери последний/наименее важный), а не переписывай строку.
- Если за ход уже было два пустых каталожных вызова подряд — следующий шаг либо propose_clarification (с реальными значениями фасета из discover_category), либо escalate_to_manager. Не третий search_catalog.
- До исчерпания двухшагового паттерна и хотя бы одной резервной ветки запрещено утверждать «нет в наличии», «не производят», «сняли с производства» или объяснять причины отсутствия.`;
