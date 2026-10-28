// 間取り3D：AI読み取り用サーバー（Vercel の関数）
// APIキーはここに書かず、Vercel の環境変数 ANTHROPIC_API_KEY に入れます。
// この関数は「間取り図」と「家具」の写真を読み取ることしかしません（質問文はサーバー側で固定）。

const PROMPTS = {
  plan: "この画像は部屋の間取り図（手書きのスケッチ、または不動産の図面）の写真です。複数枚ある場合は、すべて同じ部屋についての写真です（1枚目が間取り図、ほかは寸法のメモ、部屋の写真、追加の図面など）。すべてを合わせて判断し、寸法は書かれた数字を優先してください。部屋の外周の壁を読み取り、JSONだけを返してください。説明文は不要です。\n\n読み取りのルール:\n- 壁は縦と横だけで表します。斜めに描かれた線は、近いほうの縦か横にします。\n- 開始点は「いちばん上にある角のうち、いちばん左の角」です。そこから時計回りに、壁を1本ずつ順番に並べます。\n- dir は進む向きで right / down / left / up のどれかです。\n- length_cm は図に書かれた数字を優先します。mm で書かれていれば cm に直します（800mm → 80）。「430cm×340」のような部屋全体の寸法も手がかりにします。\n- 数字が書かれていない壁は、ほかの寸法と図の比率から推定し、estimated を true にします。\n- 外周が閉じるようにします（right の合計＝left の合計、down の合計＝up の合計）。\n- ドア：開き戸の弧や「ドア」「DR」などの表記から読み取ります。wall は walls の配列番号（0始まり）、offset_cm はその壁の始点からドアの端までの距離、width_cm はドアの幅、height_cm は高さ（「210高」のように書いてあればその値、なければ 200）。swing は部屋の内側へ開くなら \"in\"、外側へ開くなら \"out\"。\n- fixtures：×印の付いた四角（柱・収納・設備など）や作り付けのもの。name は日本語の短い名前。x_cm と y_cm は、部屋全体を囲む長方形の左上の角から、その物の左上の角までの距離。w_cm は横幅、d_cm は縦の長さ、h_cm は高さ（不明なら 200）。\n- ceiling_cm：天井高が書いてあればその値、なければ null。\n- notes：自信がない点や推定した点を、日本語で短く最大3つ。\n\n返す形式（この形のJSONだけ）:\n{\"walls\":[{\"dir\":\"right\",\"length_cm\":162,\"estimated\":false}],\"doors\":[{\"wall\":0,\"offset_cm\":0,\"width_cm\":80,\"height_cm\":210,\"swing\":\"out\"}],\"fixtures\":[{\"name\":\"収納\",\"x_cm\":286,\"y_cm\":0,\"w_cm\":54,\"d_cm\":80,\"h_cm\":200}],\"ceiling_cm\":null,\"notes\":[\"入口部分の奥行きは数字がないため推定\"]}",
  furniture: "この画像は1つの家具の写真です。複数枚ある場合は、すべて同じ家具です（本体の写真、寸法が書かれた商品ラベル・カタログ・値札、メジャーを当てた写真など）。この家具の外形の寸法を読み取り、JSONだけを返してください。説明文は不要です。\n\n読み取りのルール:\n- 写真に書かれた寸法を最優先します。「W×D×H」「幅×奥行×高さ」「W80×D30×H180」などの表記を読みます。mm で書かれていれば cm に直します（800mm → 80）。\n- w_cm は正面から見た横幅、d_cm は奥行き、h_cm は床からいちばん高いところまでの高さです。\n- 寸法が写っていない部分は、写っている物（床板の幅、コンセント、ドア、A4用紙、人など）や、その種類の家具の一般的な大きさから推定し、estimated を true にします。\n- type は bed / desk / chair / shelf / sofa / box のうち近いものです。机・テーブル類は desk、収納・家電・その他は box にします。\n- name は日本語の短い名前です（例：本棚、ダイニングテーブル、冷蔵庫）。\n- color は本体のおもな色を #rrggbb で表します。\n- notes は推定した点や自信がない点を、日本語で短く最大3つ書きます。\n\n返す形式（この形のJSONだけ）:\n{\"name\":\"本棚\",\"type\":\"shelf\",\"w_cm\":80,\"d_cm\":30,\"h_cm\":180,\"color\":\"#c9b08a\",\"estimated\":false,\"notes\":[\"奥行きはラベルの表記から読み取り\"]}"
};

const MODEL = process.env.MODEL || 'claude-sonnet-5-5';
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 20); // 1つの接続元あたり1日の回数（目安）
const MAX_IMAGES = 4;
const hits = new Map(); // 回数の記録（サーバーが再起動すると消える目安の制限）

function allowedOrigin(req) {
  const origin = req.headers.origin || '';
  const list = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (origin && (list.includes(origin) || origin === 'https://' + req.headers.host)) return origin;
  return null;
}

module.exports = async function handler(req, res) {
  const origin = allowedOrigin(req);
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
  }
  if (req.method === 'OPTIONS') return res.status(origin ? 204 : 403).end();
  if (!origin) return res.status(403).json({ error: 'origin_not_allowed' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'server_not_configured' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}); }
  catch (e) { return res.status(400).json({ error: 'bad_image' }); }
  const task = body.task === 'furniture' ? 'furniture' : 'plan';
  const list = Array.isArray(body.images) ? body.images : (body.image ? [{ data: body.image, mediaType: body.mediaType }] : []);
  if (!list.length || list.length > MAX_IMAGES) return res.status(400).json({ error: 'bad_image' });
  let total = 0;
  const images = [];
  for (const im of list) {
    const data = String((im && im.data) || '');
    const mediaType = ['image/jpeg', 'image/png', 'image/webp'].includes(im && im.mediaType) ? im.mediaType : 'image/jpeg';
    total += data.length;
    if (!data || !/^[A-Za-z0-9+/=]+$/.test(data)) return res.status(400).json({ error: 'bad_image' });
    images.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
  }
  if (total > 4200000) return res.status(400).json({ error: 'bad_image' });

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const day = new Date().toISOString().slice(0, 10);
  const k = ip + '|' + day;
  const n = (hits.get(k) || 0) + 1;
  if (n > DAILY_LIMIT) return res.status(429).json({ error: 'daily_limit' });
  hits.set(k, n);
  if (hits.size > 5000) hits.clear();

  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 4000,
        messages: [{ role: 'user', content: [...images, { type: 'text', text: PROMPTS[task] }] }]
      })
    });
  } catch (e) {
    return res.status(502).json({ error: 'upstream_unreachable' });
  }
  if (!r.ok) {
    let msg = '';
    try { const e = await r.json(); msg = String((e && e.error && e.error.message) || ''); } catch (e) {}
    let code = 'upstream_' + r.status;
    if (r.status === 429 || r.status === 529) code = 'upstream_busy';
    else if (r.status === 401 || r.status === 403) code = 'server_key_invalid';
    else if (/credit balance/i.test(msg)) code = 'no_credit';
    else if (r.status === 404 || /model/i.test(msg)) code = 'bad_model';
    console.error('anthropic error', r.status, msg);
    return res.status(502).json({ error: code, detail: msg.slice(0, 200) });
  }
  const j = await r.json();
  const t = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) return res.status(502).json({ error: 'invalid_json' });
  try { return res.status(200).json({ result: JSON.parse(t.slice(a, b + 1)) }); }
  catch (e) { return res.status(502).json({ error: 'invalid_json' }); }
};
