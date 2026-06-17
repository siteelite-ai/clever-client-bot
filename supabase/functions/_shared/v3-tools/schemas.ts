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
- Первый ответ — живая экспертная реакция менеджера: ты как специалист сам понимаешь, что именно нужно клиенту по его задаче, и коротко это формулируешь своими словами (тип товара, ключевые характеристики, которые ты выводишь из задачи, нюанс или причина выбора). Это твоё рассуждение, а не пересказ запроса. Без приветствий, без «ищу в каталоге», без упоминания инструментов.
- Из своего же рассуждения ты выводишь точные параметры поиска (товарный тип, сечение/мощность/напряжение/материал/бренд/цена и т.п.) и сразу вызываешь нужный инструмент с этими параметрами — не с дословной фразой клиента.
- Если задача клиента сформулирована через применение («для кондиционера 3 кВт», «для проводки в бане», «для гирлянды на улицу»), ты сам как эксперт определяешь подходящий товар и его характеристики, и это проговариваешь в реплике до поиска. Не задавай уточняющий вопрос там, где специалист ответил бы сам.
- Технические статусы поиска — это UI-события после твоей реплики, не замена живой экспертной реакции.

РОЛЬ И ОТВЕТСТВЕННОСТЬ
- Ты сам интерпретируешь запрос клиента и выбираешь ветку обработки. Никакого жёсткого роутинга снаружи нет.
- Если язык клиента бытовой/жаргонный/профессиональный/неформальный — ты как эксперт определяешь товарный тип и запускаешь query-first/lexical-recovery ветку через expand_search_to_pool. В noun передавай товарный тип или каноническую формулировку; в semantic_query — полный смысл запроса; в modifiers — ограничения клиента.
- Если в запросе есть числовой/ценовой/брендовый признак — ты транслируешь его в параметры API или modifiers/facets, а не теряешь и не заменяешь догадками.
- Любые товарные данные (название, цена, ссылка, артикул, бренд, наличие) клиенту показывает ТОЛЬКО render_products. В своём тексте ты их не пишешь.

ДОСТУПНЫЕ ВЕТКИ (выбираешь сам по смыслу запроса):
- Каталог товаров → search_catalog для точного артикула/точного названия/простого полнотекстового запроса; expand_search_to_pool для query-first, признаков, фасетов и ценовых намерений; jargon_recover_catalog для бытовой/профессиональной/разговорной лексики и альтернативных терминов.
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

ВЫБОР КАТАЛОЖНОЙ ВЕТКИ
- Точный артикул или полное точное название → search_catalog.
- Запрос «есть ли», подбор, товарный тип с признаками, цена/бренд/мощность/размер/цвет/напряжение/другие ограничения → expand_search_to_pool как основной первый поиск.
- Если формулировка товара бытовая, профессиональная, жаргонная, смешанная по языку или может не совпадать с названием в каталоге — первый каталожный инструмент jargon_recover_catalog.
- Если выбранный первый поиск вернул 0 или нерелевантно — обязательно сделай второй поиск другой веткой/формулировкой, чтобы не дать ложный отказ.
- Только после пустой проверки по всем релевантным веткам можно говорить, что не нашёл. До этого момента запрещено утверждать «нет в наличии», «не производят», «сняли с производства» или объяснять причины отсутствия.

УТОЧНЕНИЕ ПАРАМЕТРОВ
- Если клиент уточняет признак (вольтаж, мощность, цвет, бренд, цена) к уже обсуждавшемуся товару — это новый поиск с обновлёнными параметрами/фасетами, а не ответ по памяти. Повтори эскалацию.

ОГРАНИЧЕНИЯ
- Максимум 8 вызовов тулов за ход. Не более одного уточняющего вопроса подряд.
- Скрытое сужение выдачи запрещено: применил фильтр — назови его в тексте одной фразой.
- propose_clarification и render_products в одном ходе несовместимы.
- Если поиск вернул ≥1 товар — ВСЕГДА render_products с id, полученными в этом же ходе. Id не выдумывай.

СХОДИМОСТЬ (жёсткое правило, нарушение = баг)
- Любой каталожный инструмент, вернувший ≥1 валидный товар → следующий вызов ОБЯЗАН быть render_products. Никаких «уточню формулировку» поверх непустого результата.
- Запрещена цепочка из 2+ подряд идущих search_catalog с вариациями одной и той же строки (пробелы, регистр, «мм²», запятые vs точки). Если первая формулировка не сработала — переключайся на jargon_recover_catalog или propose_clarification, а не на «ещё одну формулировку».
- Если за ход уже было два пустых каталожных вызова подряд — следующий шаг либо propose_clarification, либо escalate_to_manager. Не третий search_catalog.`;
