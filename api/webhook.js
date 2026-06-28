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
const DIAG_QUESTIONS = [
  { text: '相場を見ていて、一番ヒヤッとするのは？', options: [
    { label: '含み損がふくらんでいく時', type: 'A' },
    { label: '負けを取り返したくなる時', type: 'B' },
    { label: 'いけると思いロットを上げた時', type: 'E' },
    { label: '気づくと根拠なく入ってる時', type: 'H' },
  ]},
  { text: '負けた直後、やりがちなのは？', options: [
    { label: 'すぐ次で取り返そうとする', type: 'B' },
    { label: '一日中ずっと引きずる', type: 'G' },
    { label: '手法のせいに感じて変えたい', type: 'C' },
    { label: 'もっと勉強しなきゃと戻る', type: 'F' },
  ]},
  { text: 'エントリーを決める時、頼りにするのは？', options: [
    { label: '人のサインや配信がないと不安', type: 'D' },
    { label: 'いけそうな時は大きく張る', type: 'E' },
    { label: '説明できなくても入ってしまう', type: 'H' },
    { label: '根拠を固めたくて結局入れない', type: 'F' },
  ]},
  { text: '手法について、一番近いのは？', options: [
    { label: '1つに決められず乗り換える', type: 'C' },
    { label: '検証は十分だが実戦が少ない', type: 'F' },
    { label: '人の手法をそのまま使う', type: 'D' },
    { label: '切れずに戻るのを待ちがち', type: 'A' },
  ]},
  { text: 'トレード中のメンタル・環境は？', options: [
    { label: '勝つと有頂天、負けると沈む', type: 'G' },
    { label: '仕事や家事の合間に片手間で', type: 'H' },
    { label: '熱くなり連続で入りがち', type: 'B' },
    { label: '自信があるとロットを上げる', type: 'E' },
  ]},
];

const DIAG_PRIORITY = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

const DIAGNOSIS = {
  A: '【塩漬け型】損切りができないタイプ。1回の大損が10回の小さな勝ちを消します。\n最初の一歩：エントリー"前"に損切りラインを決め、置いたら触らない。\n「損切りは負けじゃない。退場しないための入場料です」',
  B: '【リベンジ型】負けた直後に冷静さを失うタイプ。\n最初の一歩：1回の損失上限を決め、超えたらPCを閉じる。\n「取り返そうとした瞬間が、いちばん負ける瞬間でした」',
  C: '【手法ジプシー型】手法をすぐ変えるタイプ。再現性が育ちません。\n最初の一歩：1つの手法を結果が出るまで検証し、最低1〜3か月記録する。',
  D: '【他人軸型】人のサインがないと動けないタイプ。\n最初の一歩：根拠を鵜呑みにせず"なぜそう言うか"で考える癖をつける。',
  E: '【一発逆転型】自信があるとロットを上げるタイプ。\n最初の一歩：ロットは「自信」ではなく「ルール」で決める。',
  F: '【評論家型】勉強ばかりで動けないタイプ。\n最初の一歩：失っても痛くない金額で、まず小さく動く。',
  G: '【感情ジェットコースター型】勝敗にメンタルが直結するタイプ。\n最初の一歩：結果ではなく「ルールを守れたか」で自分を採点する。',
  H: '【ながらトレード型】片手間で雑にエントリーするタイプ。\n最初の一歩：見る時間軸・通貨を1つに絞る。',
};
Object.keys(DIAGNOSIS).forEach(k => {
  DIAGNOSIS[k] += '\n\n詳しく知りたい人は、下のメニューからどうぞ。\n個別面談の申し込み、または僕のことが分かるページをのぞいてみてください。\n\n※投資は自己責任です。\n※成果を保証するものではありません。';
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

  if (DIAGNOSIS_ENABLED && text.replace(/\s/g, '') === '診断') {
    await startDiagnosis(userId, replyToken);
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
  if (params.action === 'diag_start') { await startDiagnosis(userId, replyToken); return; }
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
