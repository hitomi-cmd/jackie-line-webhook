// ============================================================
// ステップ配信 - api/step-delivery.js
// cron-job.org から1時間ごとにGETリクエストを受ける
// ============================================================

const LINE_TOKEN     = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const CRON_SECRET    = process.env.WEBHOOK_SECRET;

const GIFTS = {
  day1: { title: '唯一守っている資金管理ルール（1枚シート）',        url: 'https://drive.google.com/file/d/1dx75Vi5IVAxlF50OI6DdmdEFWpf2EiUI/view?usp=sharing' },
  day3: { title: 'トレードを辞めずに続ける7つの心構え',              url: 'https://drive.google.com/file/d/1ANmkTtKNlZG2TcFBLDFrgal7SYMCgXXn/view?usp=sharing' },
  day5: { title: 'ゼロから"自分なりの勝ち方"を作る90日ロードマップ', url: 'https://drive.google.com/file/d/1AwYMlwvP8f_7TsepA8TRoo5irQzV9l3U/view?usp=sharing' },
};
const STEP_SCHEDULE = [1, 3, 5];
const SHEET_FRIENDS = '友だちDB';

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

async function pushMessage(to, messages) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${LINE_TOKEN}`,
    },
    body: JSON.stringify({ to, messages }),
  });
}

export default async function handler(req, res) {
  if (req.query.token !== CRON_SECRET) {
    return res.status(401).json({ error: 'forbidden' });
  }

  const rows = await getSheetData(SHEET_FRIENDS);
  if (rows.length < 2) return res.status(200).json({ ok: true, sent: 0 });

  const header = {};
  rows[0].forEach((h, i) => header[h] = i);
  const now = new Date();
  let sent = 0;

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r[header['optOut']] === 'true' || r[header['ステータス']] === 'ブロック') continue;

    const regDate = new Date(r[header['登録日時']]);
    const daysPassed = Math.floor((now - regDate) / 86400000);
    let currentStep = Number(r[header['現在ステップ']] || 0);

    for (const day of STEP_SCHEDULE) {
      if (daysPassed >= day && currentStep < day) {
        const g = GIFTS['day' + day];
        if (!g) continue;

        const msg = day === 5
          ? `今日はこちらをお届けします。\n\n▼${g.title}\n${g.url}\n\nこれで地図は揃いました。最初の30日でつまずく人がほとんどです。今どこで止まっているかを一緒に確認するために、30分の無料個別相談を用意しています。このトークに「相談」とひとこと送ってください。あとは本人が個別に対応します。`
          : `今日はこちらをお届けします。\n\n▼${g.title}\n${g.url}\n\n読んだ感想を、ぜひこのトークで聞かせてください。`;

        await pushMessage(r[header['userId']], [{ type: 'text', text: msg }]);
        currentStep = day;
        sent++;
      }
    }

    if (currentStep !== Number(r[header['現在ステップ']] || 0)) {
      await updateCell(SHEET_FRIENDS, i, header['現在ステップ'], currentStep);
    }
  }

  return res.status(200).json({ ok: true, sent });
}
