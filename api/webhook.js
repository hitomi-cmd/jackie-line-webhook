// ============================================================
// じゃっきー公式LINE Webhook - Vercel版
// api/webhook.js として配置する
// ============================================================

const LINE_TOKEN     = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// 特典マッピング
const GIFTS = {
  day0: { title: '初心者が最初の3か月で"溶かす"5つの典型パターンと回避法', url: 'https://drive.google.com/file/d/1ZsuyNqTwhmgKzy2CDT922UoAzreI9fAm/view?usp=sharing' },
  day1: { title: '唯一守っている資金管理ルール（1枚シート）',               url: 'https://drive.google.com/file/d/1dx75Vi5IVAxlF50OI6DdmdEFWpf2EiUI/view?usp=sharing' },
  day3: { title: 'トレードを辞めずに続ける7つの心構え',                     url: 'https://drive.google.com/file/d/1ANmkTtKNlZG2TcFBLDFrgal7SYMCgXXn/view?usp=sharing' },
  day5: { title: 'ゼロから"自分なりの勝ち方"を作る90日ロードマップ',        url: 'https://drive.google.com/file/d/1AwYMlwvP8f_7TsepA8TRoo5irQzV9l3U/view?usp=sharing' },
};

const STEP_SCHEDULE  = [1, 3, 5];
const REPLY_MODE     = 'manual';
const DIAGNOSIS_ENABLED = true;
const ACK_TEXT = 'メッセージありがとうございます。本人が順次お返事しますので、少しお待ちください。';

const SHEET_FRIENDS    = '友だちDB';
const SHEET_LOGS       = '会話ログ';
const SHEET_BROADCASTS = '配信予約';

// ============================================================
// Googleスプレッドシート ヘルパー
// ============================================================
async function getSheets() {
  const { google } = await import('googleapis');
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getSheetData(sheetName) {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: sheetName,
  });
  return res.data.values || [];
}

async function appendRow(sheetName, row) {
  const sheets = await getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: sheetName,
    valueInputOption: 'RAW',
    requestBody: { values: [row] },
  });
}

async function updateCell(sheetName, rowIndex, colIndex, value) {
  const sheets = await getSheets();
  const col = String.fromCharCode(65 + colIndex);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!${col}${rowIndex + 1}`,
    valueInputOption: 'RAW',
    requestBody: { values: [[value]] },
  });
}

function headerIndex(header) {
  const map = {};
  header.forEach((h, i) => map[h] = i);
  return map;
}

async function getFriend(userId) {
  const rows = await getSheetData(SHEET_FRIENDS);
  if (rows.length === 0) return null;
  const col = headerIndex(rows[0]);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][col['userId']] === userId) {
      const o = {};
      Object.keys(col).forEach(k => o[k] = rows[i][col[k]]);
      return { data: o, rowIndex: i };
    }
  }
  return null;
}

async function upsertFriend(userId, obj) {
  const rows = await getSheetData(SHEET_FRIENDS);
  if (rows.length === 0) return;
  const col = headerIndex(rows[0]);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][col['userId']] === userId) {
      await updateFriend(userId, obj);
      return;
    }
  }
  const newRow = rows[0].map(h => (h in obj ? String(obj[h]) : ''));
  await appendRow(SHEET_FRIENDS, newRow);
}

async function updateFriend(userId, obj) {
  const rows = await getSheetData(SHEET_FRIENDS);
  if (rows.length === 0) return;
  const col = headerIndex(rows[0]);
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][col['userId']] === userId) {
      for (const k of Object.keys(obj)) {
        if (k in col) await updateCell(SHEET_FRIENDS, i, col[k], String(obj[k]));
      }
      return;
    }
  }
}

async function appendTag(userId, tag) {
  const friend = await getFriend(userId);
  if (!friend) return tag;
  const cur = String(friend.data['タグ'] || '');
  const list = cur.split(',').map(s => s.trim()).filter(Boolean);
  if (list.includes(tag)) return cur;
  list.push(tag);
  return list.join(',');
}

async function logChat(userId, direction, text) {
  await appendRow(SHEET_LOGS, [new Date().toISOString(), userId, direction, text]);
}

// 診断状態をスプレッドシートで管理
async function getDiagState(userId) {
  const friend = await getFriend(userId);
  if (!friend) return null;
  const raw = friend.data['診断状態'] || '';
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

async function setDiagState(userId, state) {
  await updateFriend(userId, { '診断状態': JSON.stringify(state) });
}

async function clearDiagState(userId) {
  await updateFriend(userId, { '診断状態': '' });
}

// ============================================================
// LINE API ヘルパー
// ============================================================
async function callLineApi(endpoint, payload) {
  const res = await fetch(`https://api.line.me/v2/bot/message/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) console.error('LINE API error:', await res.text());
}

async function replyMessage(replyToken, messages) {
  await callLineApi('reply', { replyToken, messages });
}

async function pushMessage(to, messages) {
  await callLineApi('push', { to, messages });
}

function textMsg(text) {
  return { type: 'text', text };
}

function buttonsTemplate(text, actions) {
  return {
    type: 'template',
    altText: text.replace(/\n/g, ' '),
    template: { type: 'buttons', text, actions },
  };
}

async function getLineProfile(userId) {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/profile/${userId}`, {
      headers: { Authorization: `Bearer ${LINE_TOKEN}` },
    });
    return await res.json();
  } catch { return {}; }
}

// ============================================================
// 8タイプ診断
// ============================================================
// ============================================================
// 事前アンケート（4問）→ 完了後に8タイプ診断へ
// ============================================================
const SURVEY_QUESTIONS = [
  {
    text: 'まず4つの質問にお答えください！\n①あなたの年齢を教えてください',
    options: ['10〜20代', '30代', '40代', '50代以上'],
    key: '年齢層',
  },
  {
    text: '②性別を教えてください',
    options: ['男性', '女性', 'その他', '回答しない'],
    key: '性別',
  },
  {
    text: '③現在の年収を教えてください',
    options: ['〜300万円', '300〜500万円', '500〜800万円', '800万円以上'],
    key: '現年収',
  },
  {
    text: '④理想の副業収入は？\n今の月収にプラスしていくら？',
    options: ['＋1万〜3万円', '＋3万〜5万円', '＋5万〜10万円', '＋10万円以上'],
    key: '理想副業収入',
  },
];

function surveyQuestionMsg(qNum, prevAns = []) {
  const q = SURVEY_QUESTIONS[qNum - 1];
  const actions = q.options.map((label, i) => ({
    type: 'postback',
    label: label,
    data: `action=survey_ans&q=${qNum}&opt=${i}&surveyAns=${JSON.stringify(prevAns)}`,
    displayText: label,
  }));
  return buttonsTemplate(q.text, actions);
}

async function startSurvey(userId, replyToken) {
  // ユーザーがDBにいない場合は先に登録
  const existing = await getFriend(userId);
  if (!existing) {
    const profile = await getLineProfile(userId);
    await upsertFriend(userId, {
      userId,
      '表示名': profile.displayName || '',
      '登録日時': new Date().toISOString(),
      'ステータス': '友だち',
      '現在ステップ': 0,
      'タグ': '診断',
      'optOut': false,
      '診断タイプ': '',
      '診断状態': '',
      '最終接触': new Date().toISOString(),
    });
  }
  await replyMessage(replyToken, [
    textMsg(
      '【好きな時に好きな場所で働くための、在宅診断】\n\n' +
      'あなたに合った在宅副業のスタイルと、長く稼ぎ続けるために知っておくべきタイプを診断します。\n\n' +
      'まず4つの質問にお答えください。直感でOKです！'
    ),
    surveyQuestionMsg(1, []),
  ]);
  await logChat(userId, 'out', '[診断] アンケート開始');
}

async function answerSurvey(userId, q, opt, prevAns, replyToken) {
  const newAns = [...prevAns, opt];

  if (newAns.length >= SURVEY_QUESTIONS.length) {
    // アンケート完了 → スプレッドシートに保存 → 診断スタート
    const surveyData = {};
    SURVEY_QUESTIONS.forEach((sq, i) => {
      surveyData[sq.key] = sq.options[newAns[i]] || '';
    });
    try {
      await updateFriend(userId, surveyData);
    } catch (err) {
      console.error('[survey] スプレッドシート保存失敗:', err);
      // 失敗しても診断は続行（ユーザー体験を止めない）
    }
    await replyMessage(replyToken, [
      textMsg('ありがとうございます！\nでは本題の診断です。\n直感で、一番近いものを5問選んでください。'),
      diagQuestionMsg(1, []),
    ]);
    await logChat(userId, 'out', '[診断] アンケート完了→診断開始');
  } else {
    const nextQ = q + 1;
    await replyMessage(replyToken, [surveyQuestionMsg(nextQ, newAns)]);
    await logChat(userId, 'out', `[診断] アンケートQ${nextQ}`);
  }
}

const DIAG_QUESTIONS = [
  { text: 'お金に関して、あなたに一番近いのはどれですか？', options: [
    { label: '損してもいつか戻るとそのままに', type: 'A' },
    { label: '損すると取り返さなきゃと焦る', type: 'B' },
    { label: 'ここぞの時に一気に大きく動く', type: 'E' },
    { label: '損すると一日中引きずってしまう', type: 'G' },
  ]},
  { text: '新しいことを始める時、どのタイプに近いですか？', options: [
    { label: 'うまくいかないとすぐ別の方法へ', type: 'C' },
    { label: '調べるのは好きだが行動できない', type: 'F' },
    { label: '信頼できる人のOKがないと動けない', type: 'D' },
    { label: '始めるけどながらでやりがち', type: 'H' },
  ]},
  { text: '大事な決断をする時、あなたはどうしますか？', options: [
    { label: '誰かの意見を参考にして決める', type: 'D' },
    { label: 'テンションが上がった時にえいや！', type: 'E' },
    { label: '調べすぎて結局決められない', type: 'F' },
    { label: 'あまり深く考えずなんとなく決める', type: 'H' },
  ]},
  { text: '時間やお金をかけたことが上手くいかない時は？', options: [
    { label: 'もったいなくてやめられずズルズル', type: 'A' },
    { label: 'すぐ別の方法で取り返そうとする', type: 'B' },
    { label: 'まったく違うやり方に切り替えたい', type: 'C' },
    { label: '誰かに相談してから次を決める', type: 'D' },
  ]},
  { text: '自分の性格で一番近いのはどれですか？', options: [
    { label: 'うまくいくと舞い上がり失敗で落ち込む', type: 'G' },
    { label: '他のことをしながら作業が多い', type: 'H' },
    { label: '自信がある時は思いきって大きく動く', type: 'E' },
    { label: '失敗を認めたくなくて現実から目をそらす', type: 'A' },
  ]},
];

const DIAG_PRIORITY = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

// 在宅副業→FXへの共通の流れ（全タイプ共通）
const ZAITAKU_BRIDGE =
  '\n\n' +
  '---\n\n' +
  '在宅で副業を考えた時、\n' +
  'ライティング・データ入力・ハンドメイドなど\n' +
  '「時間やスキルを売る仕事」はたくさんあります。\n\n' +
  'でも、これには共通した天井があります。\n\n' +
  '　働いた時間＝収入\n\n' +
  '体力や時間の上限が、そのまま収入の上限になる。\n' +
  '本業と並行すれば、いつか必ず限界が訪れます。\n\n' +
  'だから僕がおすすめするのはFX。\n' +
  '時間・場所を選ばず、スキルが身につくほど収入が伸びる。\n' +
  '好きな時に好きな場所で働ける、数少ない副業です。\n\n' +
  'ただし、上で診断したあなたの傾向は、\nFXでも同じように出やすいポイント。\n' +
  'だからこそ、先に知っておくことが大切です。';

// 診断結果の末尾（秘伝書＋CTA）
const DIAG_SUFFIX =
  '\n\nそんなあなたに気を付けてほしいポイント・\n' +
  '僕が習得したコツをまとめた秘伝書を、\n' +
  '特別に明日もお届けします。\n\n' +
  'さらに詳しく聞きたい方は、\nメニューから「相談」と入力してみてください。\n' +
  '個別で相談に応じます。\n\n' +
  '※投資は自己責任です。\n※成果を保証するものではありません。';

const DIAGNOSIS = {
  A: '【診断結果】あなたは「損切りできない・塩漬け型」\n\n' +
     '損が出た時に「いつか戻るかも」とそのまま放置してしまう傾向があります。\n' +
     'もったいない気持ちが先に立って、現実から目をそらしがち。\n' +
     '小さな損を見て見ぬふりするうちに、気づいたら大きな穴になっていた…というパターンです。\n\n' +
     'キーワードは「先にルールを決める」こと。\n' +
     '感情ではなく、あらかじめ決めたルールで動けるようになると結果が変わります。' +
     ZAITAKU_BRIDGE,

  B: '【診断結果】あなたは「取り返そうとする・リベンジ型」\n\n' +
     '損をした後に「すぐ取り返さなきゃ」と焦って動いてしまう傾向があります。\n' +
     '冷静さを欠いた状態での行動が、さらなる損につながりやすいです。\n\n' +
     '「1回の損の上限を決めて、超えたら今日はやめる」\nこのルールが、あなたには特に重要になります。' +
     ZAITAKU_BRIDGE,

  C: '【診断結果】あなたは「すぐ別の方法を探す・手法ジプシー型」\n\n' +
     'うまくいかないとすぐに「別のやり方」を探してしまう傾向があります。\n' +
     '方法を変え続けると、何が良くて何が悪かったのか分からなくなります。\n\n' +
     '1つのやり方を最低1〜3か月は続けて記録すること。\nそれが上達への最短ルートです。' +
     ZAITAKU_BRIDGE,

  D: '【診断結果】あなたは「誰かの意見がないと動けない・他人軸型」\n\n' +
     '「信頼できる人がいいと言ったから」という理由で動いてしまいやすいです。\n' +
     '他人のタイミングと自分のタイミングは違うため、鵜呑みにするのは危険です。\n\n' +
     '「なぜそう言えるのか」を自分で考える習慣を\nつけることが大切です。' +
     ZAITAKU_BRIDGE,

  E: '【診断結果】あなたは「ここぞの時に大きく動く・一発逆転型」\n\n' +
     '「これはいける！」と感じた時に、思いきって大きく動いてしまいやすいです。\n' +
     '自信がある時こそ冷静さが必要で、感情ではなくルールで動くことが重要です。\n\n' +
     '「テンションが上がっている時こそ、一呼吸置く」\nこれを合言葉にしてください。' +
     ZAITAKU_BRIDGE,

  F: '【診断結果】あなたは「調べるけど動けない・評論家型」\n\n' +
     '勉強はするけど、なかなか行動に移せない…というループに入りやすいです。\n' +
     '「もっと知識が必要」と感じるのは自然なことですが、\n動かないと実感は得られません。\n\n' +
     'まず失っても痛くない小さな金額で体験すること。\nそれが何よりの第一歩です。' +
     ZAITAKU_BRIDGE,

  G: '【診断結果】あなたは「感情の波が大きい・感情ジェットコースター型」\n\n' +
     'うまくいった日は舞い上がり、うまくいかない日は落ち込む。\n' +
     'その波がそのまま判断を狂わせてしまいます。\n\n' +
     '「結果ではなく、自分で決めたルールを守れたか」\nで自分を評価する視点を持つことが大切です。' +
     ZAITAKU_BRIDGE,

  H: '【診断結果】あなたは「ながら作業で進めてしまう・ながら型」\n\n' +
     '「ちょっとの間に」「片手間で」と、軽い気持ちで動いてしまいやすいです。\n' +
     '集中できない環境での判断は精度が落ちます。\n\n' +
     '「見る時間を決める」「その時間だけ集中する」\nこのシンプルなルールが、あなたには効果的です。' +
     ZAITAKU_BRIDGE,
};

Object.keys(DIAGNOSIS).forEach(k => {
  DIAGNOSIS[k] += DIAG_SUFFIX;
});

function diagQuestionMsg(qNum, currentAns = []) {
  const q = DIAG_QUESTIONS[qNum - 1];
  const actions = q.options.map((o, i) => ({
    type: 'postback',
    label: o.label,
    data: `action=diag_ans&q=${qNum}&opt=${i + 1}&ans=${JSON.stringify(currentAns)}`,
    displayText: o.label,
  }));
  return buttonsTemplate(`【質問 ${qNum}/${DIAG_QUESTIONS.length}】\n${q.text}`, actions);
}

function computeDiagType(answerSeq) {
  const score = {};
  answerSeq.forEach((opt, i) => {
    const o = DIAG_QUESTIONS[i].options[opt - 1];
    if (o) score[o.type] = (score[o.type] || 0) + 1;
  });
  let best = DIAG_PRIORITY[0], bestScore = -1;
  DIAG_PRIORITY.forEach(t => { const s = score[t] || 0; if (s > bestScore) { best = t; bestScore = s; } });
  return best;
}

// ============================================================
// イベント別処理
// ============================================================
async function onFollow(userId, replyToken) {
  const profile = await getLineProfile(userId);
  await upsertFriend(userId, {
    userId,
    '表示名': profile.displayName || '',
    '登録日時': new Date().toISOString(),
    'ステータス': '友だち',
    '現在ステップ': 0,
    'タグ': '新規',
    'optOut': false,
    '診断タイプ': '',
    '診断状態': '',
    '最終接触': new Date().toISOString(),
  });
  const g = GIFTS.day0;
  await replyMessage(replyToken, [textMsg(
    `はじめまして、登録ありがとうございます。\n\n` +
    `まず最初に、僕自身が最初にやらかした「お金を溶かす5パターン」をまとめた特典をお渡しします。\n` +
    `先に"失敗の地図"を持っておくだけで、無駄に溶かす確率はかなり下げられます。\n\n` +
    `▼${g.title}\n${g.url}\n\n` +
    `「診断」と送ると、あなたのトレードタイプが分かります。よかったら試してみてください。\n\n` +
    `気になることがあれば、いつでもこのトークに送ってください。`
  )]);
  await logChat(userId, 'out', '[follow] Day0特典配信');
}

async function onTextMessage(userId, text, replyToken) {
  await logChat(userId, 'in', text);
  const newTag = await appendTag(userId, '要対応');
  await updateFriend(userId, { '最終接触': new Date().toISOString(), 'タグ': newTag });

  // 「診断」→ 事前アンケート→8タイプ診断を開始
  if (DIAGNOSIS_ENABLED && text.replace(/\s/g, '') === '診断') {
    await startSurvey(userId, replyToken);
    return;
  }

  // 「相談」→ 個別面談案内を自動返信（replyToken使用のため通数カウントなし）
  if (text.replace(/\s/g, '') === '相談') {
    const consultMsg =
      'ご相談ありがとうございます。\n' +
      '個別面談の候補日を3つほどお送りください。\n' +
      'ご希望の日時に合わせて、〜1時間程度で個別相談を組ませていただきます。\n\n' +
      '例)⚪\n' +
      '①平日18:00以降\n' +
      '②火曜日10:00-12:00の間\n' +
      '③平日は20:00-、土日は終日\n' +
      'などでもOK\n\n' +
      '【個別面談希望（コピペでお使いください）】\n' +
      '①   月　日　　時〜　時\n' +
      '②   月　日　　時〜　時\n' +
      '③   月　日　　時〜　時\n\n' +
      '確認次第、日程および個別面談リンクをお送りいたします。';
    try {
      await replyMessage(replyToken, [textMsg(consultMsg)]);
      await logChat(userId, 'out', '[相談] 個別面談案内を自動返信');
    } catch (err) {
      console.error('[相談] 自動返信失敗:', err);
      // 失敗しても処理を止めない（会話ログを見てじゃっきーさんが手動対応可能）
    }
    return;
  }

  if (REPLY_MODE === 'manual') return;
  if (REPLY_MODE === 'ack') {
    await replyMessage(replyToken, [textMsg(ACK_TEXT)]);
    await logChat(userId, 'out', '[ack] ' + ACK_TEXT);
  }
}

async function onPostback(userId, data, replyToken) {
  if (!DIAGNOSIS_ENABLED) return;
  const params = parseQuery(data);

  // リッチメニュー等から診断スタート
  if (params.action === 'diag_start') { await startSurvey(userId, replyToken); return; }

  // 事前アンケートの回答
  if (params.action === 'survey_ans') {
    const q = Number(params.q);
    const opt = Number(params.opt);
    const prevAns = params.surveyAns ? JSON.parse(params.surveyAns) : [];
    await answerSurvey(userId, q, opt, prevAns, replyToken);
    return;
  }

  // 8タイプ診断の回答
  if (params.action === 'diag_ans') {
    const q = Number(params.q);
    const opt = Number(params.opt);
    const prevAns = params.ans ? JSON.parse(params.ans) : [];
    await answerDiagnosis(userId, q, opt, prevAns, replyToken);
    return;
  }
}

async function startDiagnosis(userId, replyToken) {
  // ユーザーが友だちDBにいない場合は先に登録する（診断状態はボタンデータで管理するのでシート保存不要）
  const existing = await getFriend(userId);
  if (!existing) {
    const profile = await getLineProfile(userId);
    await upsertFriend(userId, {
      userId,
      '表示名': profile.displayName || '',
      '登録日時': new Date().toISOString(),
      'ステータス': '友だち',
      '現在ステップ': 0,
      'タグ': '診断',
      'optOut': false,
      '診断タイプ': '',
      '診断状態': '',
      '最終接触': new Date().toISOString(),
    });
  }
  await replyMessage(replyToken, [
    textMsg('あなたが勝てない"本当の理由"を診断します。\n直感で、一番近いものを5問選んでください。'),
    diagQuestionMsg(1, []),
  ]);
  await logChat(userId, 'out', '[診断] 開始');
}

async function answerDiagnosis(userId, q, opt, prevAns, replyToken) {
  // 状態はボタンのpostbackデータから取得（シート読み書き不要）
  const newAns = [...prevAns, opt];

  if (newAns.length >= DIAG_QUESTIONS.length) {
    // 全問回答完了 → 結果を計算してシートに保存
    const type = computeDiagType(newAns);
    const newTag = await appendTag(userId, '診断済み');
    await updateFriend(userId, { '診断タイプ': type, '診断状態': '', 'タグ': newTag });
    await replyMessage(replyToken, [textMsg('診断結果が出ました。\n\nあなたは……\n' + DIAGNOSIS[type])]);
    await logChat(userId, 'out', '[診断結果] ' + type);
  } else {
    // 次の質問へ（状態はボタンデータに埋め込む）
    const nextQ = q + 1;
    await replyMessage(replyToken, [diagQuestionMsg(nextQ, newAns)]);
    await logChat(userId, 'out', '[診断] Q' + nextQ);
  }
}

function parseQuery(s) {
  const o = {};
  String(s).split('&').forEach(kv => {
    const idx = kv.indexOf('=');
    if (idx > -1) o[kv.substring(0, idx)] = decodeURIComponent(kv.substring(idx + 1));
  });
  return o;
}

// ============================================================
// Webhook メインハンドラ
// ============================================================
export default async function handler(req, res) {
  // GETは疎通確認用
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true });
  }

  if (req.method !== 'POST') {
    return res.status(405).end();
  }

  // LINEの検証ボタン対応：中身が空のテストデータは即200を返す
  if (!req.body || !req.body.events) {
    return res.status(200).json({ ok: true });
  }

  // セキュリティチェック
  const token = req.query.token;
  if (WEBHOOK_SECRET && token !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'forbidden' });
  }

  // イベント処理を先に実行してから200を返す
  const events = req.body.events || [];
  for (const event of events) {
    const userId = event.source && event.source.userId;
    if (!userId) continue;
    try {
      switch (event.type) {
        case 'follow':
          await onFollow(userId, event.replyToken);
          break;
        case 'message':
          if (event.message.type === 'text') {
            await onTextMessage(userId, event.message.text, event.replyToken);
          }
          break;
        case 'postback':
          await onPostback(userId, event.postback.data, event.replyToken);
          break;
        case 'unfollow':
          await updateFriend(userId, { 'ステータス': 'ブロック', 'optOut': 'true' });
          break;
      }
    } catch (err) {
      console.error('handleEvent error:', err);
    }
  }

  // 全処理完了後に200を返す
  return res.status(200).json({ ok: true });
}
