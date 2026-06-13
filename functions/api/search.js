// Cloudflare Pages Functions — 育儿大师搜索API v1.1
// 支持双书选择 + 多书合并回答 + 答案直截了当

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

    // 根据选书过滤
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
    if (allChapters.length === 0) {
      return new Response(JSON.stringify({ error: '所选书籍暂无内容' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 找出最相关的章节（跨书时会找多本书各1章）
    const matchedChapters = await classifyQuestion(question.trim(), filteredIndex, apiKey);
    if (!matchedChapters || matchedChapters.length === 0) {
      return new Response(JSON.stringify({
        answer: '**这个问题暂时超出我的知识范围**，换个方式问问看？',
        sources: [],
        tokens: {}
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 收集所有匹配章节的内容
    let combinedContent = [];
    let sources = [];
    for (const match of matchedChapters) {
      for (const bookObj of filteredBooks) {
        const b = bundle[bookObj.name];
        if (b && b[match.file]) {
          const maxLen = 6000;
          const content = b[match.file].length > maxLen
            ? b[match.file].substring(0, maxLen) + '\n\n[内容较长，已截取关键部分]'
            : b[match.file];
          combinedContent.push({
            bookName: bookObj.name,
            chapterTitle: match.chapter.title,
            content: content
          });
          sources.push(`${bookObj.name} - ${match.chapter.title}`);
          break;
        }
      }
    }

    if (combinedContent.length === 0) {
      return new Response(JSON.stringify({ error: '知识库内容未找到' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 生成回答
    const answer = await generateAnswer(question.trim(), combinedContent, apiKey);

    return new Response(JSON.stringify({
      answer: answer.text,
      sources: sources,
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

/* 分类：找出最相关的章节（每本书1个） */
async function classifyQuestion(question, index, apiKey) {
  const books = index.books;
  const results = [];

  for (const book of books) {
    const chapters = book.chapters;
    if (chapters.length === 0) continue;

    const chapterList = chapters.map((c, i) =>
      `${i + 1}. ${c.title}`
    ).join('\n');

    const messages = [
      {
        role: 'system',
        content: `你是一个育儿知识分类助手。从以下章节列表中选出最相关的**1个**章节编号。只输出数字，不要多余内容。`
      },
      {
        role: 'user',
        content: `问题：${question}\n\n《${book.name}》章节：\n${chapterList}\n\n最相关章节编号：`
      }
    ];

    try {
      const result = await callDeepSeek(messages, 'deepseek-v4-flash', apiKey, 0.1);
      const text = result.choices[0].message.content;
      const numbers = text.match(/\d+/g);
      if (numbers) {
        const idx = parseInt(numbers[0], 10) - 1;
        if (idx >= 0 && idx < chapters.length) {
          results.push({ file: chapters[idx].file, chapter: chapters[idx] });
        }
      }
    } catch (e) {
      console.error(`Classify error for ${book.name}:`, e);
    }
  }

  return results.length > 0 ? results : null;
}

/* 生成回答 */
async function generateAnswer(question, combinedContent, apiKey) {
  // 组装多书资料
  let contextParts = [];
  for (const item of combinedContent) {
    contextParts.push(
      `【来源：《${item.bookName}》- ${item.chapterTitle}】\n${item.content}`
    );
  }
  const fullContext = contextParts.join('\n\n---\n\n');

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
7. 如果有多本书的资料，综合各书观点回答，注明各来源`
    },
    {
      role: 'user',
      content: `用户：${question}\n\n相关资料（可能来自多本书）：\n${fullContext}\n\n回答：`
    }
  ];

  const result = await callDeepSeek(messages, 'deepseek-v4-pro', apiKey, 0.4);
  const answerText = result.choices[0].message.content;

  return {
    text: answerText,
    tokens: result.usage
  };
}