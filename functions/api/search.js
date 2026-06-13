// Cloudflare Pages Functions — 育儿大师搜索API v1.1
// 支持双书选择 + 答案直截了当

const API_BASE = 'https://api.deepseek.com';

let _bundle = null;
let _index = null;

async function getBundle(env, request) {
  if (_bundle) return _bundle;
  const url = new URL('/knowledge-bundle.json', request.url);
  const resp = await env.ASSETS.fetch(url);
  _bundle = await resp.json();
  return _bundle;
}

async function getIndex(env, request) {
  if (_index) return _index;
  const url = new URL('/knowledge-index.json', request.url);
  const resp = await env.ASSETS.fetch(url);
  _index = await resp.json();
  return _index;
}

export async function onRequest(context) {
  const { request, env } = context;

  // CORS
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: '只支持POST请求' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: '服务配置未完成' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: '请求格式错误' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const { question, book } = body || {};
  if (!question || !question.trim()) {
    return new Response(JSON.stringify({ error: '请输入问题' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const index = await getIndex(env, request);
    const bundle = await getBundle(env, request);

    // 根据选书过滤索引
    let filteredBooks = index.books;
    if (book && book !== 'all') {
      filteredBooks = index.books.filter(b => b.name === book);
      if (filteredBooks.length === 0) {
        return new Response(JSON.stringify({ error: '未找到所选书籍' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    const filteredIndex = { books: filteredBooks };
    const allChapters = filteredBooks.flatMap(b => b.chapters);

    // 分类——找最相关章节
    const matched = await classifyQuestion(question.trim(), filteredIndex, apiKey);
    if (!matched) {
      return new Response(JSON.stringify({
        answer: '**这个问题暂时超出我的知识范围**，换个方式问问看？',
        sources: [],
        tokens: {}
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 找章节内容
    let chapterContent = null;
    let foundBook = null;
    for (const bookObj of filteredBooks) {
      const b = bundle[bookObj.name];
      if (b && b[matched.file]) {
        chapterContent = b[matched.file];
        foundBook = bookObj;
        break;
      }
    }

    if (!chapterContent) {
      return new Response(JSON.stringify({ error: '知识库文件未找到' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 生成回答
    const answer = await generateAnswer(question.trim(), chapterContent, foundBook, apiKey);

    return new Response(JSON.stringify({
      answer: answer.text,
      sources: answer.sources,
      tokens: answer.tokens
    }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('Search error:', err);
    return new Response(JSON.stringify({ error: '服务暂时不可用，请稍后再试' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

async function callDeepSeek(messages, model, apiKey, temperature = 0.3) {
  const resp = await fetch(`${API_BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: 4096
    })
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`DeepSeek API (${resp.status}): ${errText}`);
  }

  return resp.json();
}

async function classifyQuestion(question, index, apiKey) {
  const allChapters = index.books.flatMap(b => b.chapters);
  if (allChapters.length === 0) return null;

  const chapterList = allChapters.map((c, i) =>
    `${i + 1}. [${c.book_short}] ${c.title}`
  ).join('\n');

  const messages = [
    {
      role: 'system',
      content: `选出最相关的1个章节编号。章节列表格式为「[书名] 标题」。只输出数字。`
    },
    {
      role: 'user',
      content: `问题：${question}\n\n章节：\n${chapterList}\n\n最相关章节编号：`
    }
  ];

  const result = await callDeepSeek(messages, 'deepseek-v4-flash', apiKey, 0.1);
  const text = result.choices[0].message.content;
  const numbers = text.match(/\d+/g);
  if (!numbers) return null;

  const idx = parseInt(numbers[0], 10) - 1;
  if (idx < 0 || idx >= allChapters.length) return null;

  return {
    file: allChapters[idx].file,
    chapter: allChapters[idx]
  };
}

async function generateAnswer(question, chapterContent, book, apiKey) {
  const maxLen = 8000;
  const content = chapterContent.length > maxLen
    ? chapterContent.substring(0, maxLen) + '\n\n[内容较长，已截取关键部分]'
    : chapterContent;

  const titleMatch = chapterContent.match(/^#\s+(.+)/m);
  const chapterTitle = titleMatch ? titleMatch[1] : '育儿知识';
  const bookName = book?.name || '育儿百科';

  const messages = [
    {
      role: 'system',
      content: `你是"布拉万育儿大师"助手。回答规则：
1. **直接了当** — 开门见山给答案，不要"你好""请问"等客套
2. **重点放前面** — 先说结论/核心措施，再补充说明
3. **关键内容用** **加粗** 强调（症状、温度、数值、药物名、危险信号等）
4. **重要提醒用** __下划线__ 标注（如需要立即就医的情况）
5. **每条回答控制在5-8行以内**，简明扼要
6. 严格基于提供的资料，不编造
7. 末尾注明来源，格式：📖 来源：《书名》- 章节名`
    },
    {
      role: 'user',
      content: `用户：${question}\n\n资料：\n${content}\n\n回答：`
    }
  ];

  const result = await callDeepSeek(messages, 'deepseek-v4-pro', apiKey, 0.4);
  const answerText = result.choices[0].message.content;

  return {
    text: answerText,
    sources: [`${bookName} - ${chapterTitle}`],
    tokens: result.usage
  };
}