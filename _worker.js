// Bộ nhớ tạm fallback khi chưa cấu hình Cloudflare KV
const inMemoryCodes = new Map([
  ['C2DAKNR1959YCWSH', {
    code: 'C2DAKNR1959YCWSH',
    package: 3,
    used: false,
    createdAt: new Date().toISOString()
  }]
]);

const getKV = (env) => env.CODES_KV || env.KV || env.ACTIVATION_CODES;

async function getCodeInfo(env, code) {
  const kv = getKV(env);
  if (kv) {
    return await kv.get(`code:${code}`, 'json');
  }
  return inMemoryCodes.get(code) || null;
}

async function saveCodeInfo(env, code, data) {
  const kv = getKV(env);
  if (kv) {
    await kv.put(`code:${code}`, JSON.stringify(data));
  }
  inMemoryCodes.set(code, data);
}

async function listAllCodes(env) {
  const kv = getKV(env);
  if (kv) {
    const list = await kv.list({ prefix: 'code:' });
    const results = [];
    for (const key of list.keys) {
      const val = await kv.get(key.name, 'json');
      if (val) results.push(val);
    }
    return results;
  }
  return Array.from(inMemoryCodes.values());
}

function normalizeKey(str) {
  if (!str) return '';
  return str
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[^a-z0-9]/g, '');
}

function checkAdminAuth(headerKey, env) {
  // Uu tien mat khau cau hinh tren Cloudflare. Neu deployment chua nhan env,
  // dung mat khau du phong de tranh bi khoa trang quan tri.
  const adminSecret = env.ADMIN_SECRET_KEY || env.ADMIN_KEY || env.ADMIN_SECRET || 'Văn Thắng';
  if (!headerKey) return false;
  return headerKey.trim() === String(adminSecret).trim();
}


// ===== AUTO BANK / SEPAY =====
// ============================================================
// CAU HINH BACKEND DE SUA NHANH - SUA KHOI NAY NEU BAN SAO DOI THONG TIN
// ============================================================
const EDITABLE_BACKEND = Object.freeze({
  bank: 'MBBank',
  accountNumber: '2852333333',
  accountHolder: 'PHAN VAN THANG',
  paymentPrefix: 'DL',
  paymentTimeoutMinutes: 10,
  plans: {
    '10d': { id: '10d', amount: 50000, warrantyDays: 10, label: '50K - Bảo hành 10 ngày' },
    '365d': { id: '365d', amount: 150000, warrantyDays: 365, label: '150K - Bảo hành 365 ngày' }
  }
});
const PAYMENT_PLANS = Object.freeze(EDITABLE_BACKEND.plans);
const PAYMENT_BANK = EDITABLE_BACKEND.bank;
const PAYMENT_ACCOUNT = EDITABLE_BACKEND.accountNumber;
const PAYMENT_HOLDER = EDITABLE_BACKEND.accountHolder;
const PAYMENT_PREFIX = EDITABLE_BACKEND.paymentPrefix;
const PAYMENT_EXPIRY_MS = EDITABLE_BACKEND.paymentTimeoutMinutes * 60 * 1000;

function paymentExpiresAt(createdAt) {
  const base = new Date(createdAt || Date.now()).getTime();
  return new Date(base + PAYMENT_EXPIRY_MS).toISOString();
}

function isPaymentExpired(order, nowMs = Date.now()) {
  if (!order) return false;
  const exp = new Date(order.expiresAt || paymentExpiresAt(order.createdAt)).getTime();
  return Number.isFinite(exp) && nowMs >= exp;
}

async function markPaymentExpired(env, order) {
  if (!order || order.status !== 'pending') return order;
  if (!isPaymentExpired(order)) return order;
  const expired = {
    ...order,
    status: 'expired',
    expiresAt: order.expiresAt || paymentExpiresAt(order.createdAt),
    expiredAt: new Date().toISOString(),
    message: 'Đơn đã hết hạn thanh toán sau 10 phút. Vui lòng tạo đơn mới.',
    updatedAt: new Date().toISOString()
  };
  await savePaymentInfo(env, order.orderCode, expired);
  return expired;
}
const inMemoryPayments = new Map();
const inMemoryTransactions = new Map();

async function getPaymentInfo(env, orderCode) {
  const kv = getKV(env);
  if (kv) return await kv.get(`payment:${orderCode}`, 'json');
  return inMemoryPayments.get(orderCode) || null;
}

async function savePaymentInfo(env, orderCode, data) {
  const kv = getKV(env);
  if (kv) await kv.put(`payment:${orderCode}`, JSON.stringify(data));
  inMemoryPayments.set(orderCode, data);
}

async function getSePayTransaction(env, transactionId) {
  const kv = getKV(env);
  if (kv) return await kv.get(`sepay_tx:${transactionId}`, 'json');
  return inMemoryTransactions.get(String(transactionId)) || null;
}

async function saveSePayTransaction(env, transactionId, data) {
  const kv = getKV(env);
  if (kv) await kv.put(`sepay_tx:${transactionId}`, JSON.stringify(data), { expirationTtl: 60 * 60 * 24 * 180 });
  inMemoryTransactions.set(String(transactionId), data);
}

function randomOrderCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let suffix = '';
  for (const b of bytes) suffix += alphabet[b % alphabet.length];
  return PAYMENT_PREFIX + suffix;
}

function normalizeAccountNumber(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' }
  });
}

function constantTimeEqual(a, b) {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function verifySePayWebhook(request, rawBody, env) {
  // Chap nhan API Key HOAC HMAC-SHA256. Khong de secret HMAC chan API Key hop le.
  const apiKey = (env.SEPAY_WEBHOOK_API_KEY || env.SEPAY_API_KEY || '').trim();
  if (apiKey) {
    const auth = (request.headers.get('Authorization') || '').trim();
    const match = auth.match(/^Apikey\s+(.+)$/i);
    if (match && constantTimeEqual(match[1].trim(), apiKey)) return true;
  }

  const secret = (env.SEPAY_WEBHOOK_SECRET || '').trim();
  if (secret) {
    const signature = request.headers.get('X-SePay-Signature') || '';
    const timestampText = request.headers.get('X-SePay-Timestamp') || '';
    const timestamp = Number(timestampText);
    if (signature && timestampText && timestamp && Math.abs(Date.now() / 1000 - timestamp) <= 300) {
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const sig = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`${timestampText}.${rawBody}`)
      );
      const hex = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
      if (constantTimeEqual(`sha256=${hex}`, signature)) return true;
    }
  }

  return false;
}

const EMBEDDED_MUACERT_API_TOKEN = 'sk_a743f6716b90dc838ad564e8ead49083a8cd0095cad622b25bef86af42ad4b61';

function getMuacertApiToken(env) {
  return String(env.MUACERT_API_TOKEN || EMBEDDED_MUACERT_API_TOKEN || '').trim();
}

async function activateMuacertDevice(env, { udid, name, model }) {
  const apiToken = getMuacertApiToken(env);
  if (!apiToken) {
    return { ok: false, httpStatus: 500, code: 'NO_TOKEN', message: 'Chưa cấu hình MUACERT_API_TOKEN trên Cloudflare Dashboard.' };
  }

  const mcRes = await fetch('https://muacert.com/openapi/v1/devices', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ udid, name, model, package: 3, currency: 'VND' })
  });

  let mcData = {};
  try { mcData = await mcRes.json(); } catch (_) {}

  if (!mcRes.ok || mcData.code !== 0) {
    let errMsg = mcData.message || 'Lỗi khi kích hoạt thiết bị trên hệ thống.';
    if (mcData.code === 2001) errMsg = 'Số dư tài khoản API MuaCert hiện không đủ để kích hoạt.';
    if (mcData.code === 2002) errMsg = 'Thiết bị UDID này đã tồn tại trên hệ thống.';
    return {
      ok: false,
      httpStatus: mcRes.status === 200 ? 400 : mcRes.status,
      code: mcData.code,
      message: errMsg,
      data: mcData
    };
  }

  return { ok: true, httpStatus: 200, data: mcData };
}



// ===== TELEGRAM BOT =====
const EMBEDDED_TELEGRAM_BOT_TOKEN = '8985405888:AAHM5r0AcUuWerpFwuig6RWT6J-wuFkvQtE';
const EMBEDDED_TELEGRAM_WEBHOOK_SECRET = 'duyle_tg_9f31a8c7';

function getTelegramBotToken(env) {
  return String(env.TELEGRAM_BOT_TOKEN || EMBEDDED_TELEGRAM_BOT_TOKEN || '').trim();
}

function getTelegramWebhookSecret(env) {
  return String(env.TELEGRAM_WEBHOOK_SECRET || EMBEDDED_TELEGRAM_WEBHOOK_SECRET || '').trim();
}

async function telegramApi(env, method, payload) {
  const token = getTelegramBotToken(env);
  if (!token) throw new Error('Chưa cấu hình TELEGRAM_BOT_TOKEN');
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) throw new Error(data.description || `Telegram API ${method} lỗi`);
  return data;
}

async function saveTelegramState(env, chatId, data) {
  const kv = getKV(env);
  if (!kv) return;
  await kv.put(`tgstate:${chatId}`, JSON.stringify(data), { expirationTtl: 60 * 60 * 24 * 2 });
}

async function getTelegramState(env, chatId) {
  const kv = getKV(env);
  if (!kv) return null;
  return await kv.get(`tgstate:${chatId}`, 'json');
}

function telegramMainKeyboard(origin) {
  return {
    inline_keyboard: [
      [{ text: '🛒 Mua chứng chỉ', callback_data: 'buy', style: 'primary' }],
      [{ text: '🔎 Tra cứu UDID', callback_data: 'lookup_udid', style: 'primary' }],
      [{ text: '📋 Kiểm tra đơn gần nhất', callback_data: 'last_status', style: 'primary' }],
      [{ text: '📘 Hướng dẫn sử dụng', callback_data: 'guide', style: 'primary' }],
      [{ text: '🌐 Mở web', url: origin, style: 'primary' }]
    ]
  };
}

function telegramGuideText() {
  return [
    '📘 HƯỚNG DẪN SỬ DỤNG',
    '',
    '1️⃣ Bấm “Mua chứng chỉ” và gửi UDID của iPhone/iPad.',
    '2️⃣ Chọn gói 50.000đ (BH 10 ngày) hoặc 150.000đ (BH 365 ngày).',
    '3️⃣ Quét QR và chuyển đúng số tiền + đúng nội dung.',
    '4️⃣ SePay xác nhận tiền vào, hệ thống tự kích hoạt MuaCert.',
    '5️⃣ Khi chứng chỉ sẵn sàng, chọn ESign / KSign / ESign 2.0 hoặc tải file chứng chỉ.',
    '',
    '🔎 “Tra cứu UDID” dùng để kiểm tra trạng thái chứng chỉ của một UDID đã kích hoạt.',
    '📋 “Kiểm tra đơn gần nhất” dùng để xem trạng thái đơn Telegram gần nhất.'
  ].join('\n');
}

async function telegramLookupUdid(env, chatId, udid, origin) {
  const clean = String(udid || '').trim();
  if (!/^[A-Za-z0-9-]{12,80}$/.test(clean)) {
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: '❌ UDID không hợp lệ. Vui lòng kiểm tra và gửi lại.' });
    return;
  }

  const apiToken = getMuacertApiToken(env);
  if (!apiToken) {
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: '⚠️ Hệ thống chưa cấu hình API.' });
    return;
  }

  try {
    const res = await fetch(`https://muacert.com/openapi/v1/certificate/${encodeURIComponent(clean)}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' }
    });
    let data = {};
    try { data = await res.json(); } catch (_) {}

    if (res.ok && data?.code === 0 && data?.data) {
      const info = data.data;
      const status = String(info.status || 'ACTIVE').toUpperCase();
      const processing = status === 'PROCESSING';
      const revoked = status.includes('REVOKED') || status.includes('BANNED');
      const icon = revoked ? '🔴' : processing ? '🟡' : '🟢';
      const label = revoked ? 'ĐÃ BỊ THU HỒI' : processing ? 'ĐANG XỬ LÝ' : 'CÒN HOẠT ĐỘNG';
      const keyboard = [];
      if (!processing && !revoked) {
        keyboard.push([
          { text: '📲 Cài ESign', url: `${origin}/?udid=${encodeURIComponent(clean)}&tgapp=esign` },
          { text: '📲 Cài KSign', url: `${origin}/?udid=${encodeURIComponent(clean)}&tgapp=ksign` }
        ]);
        keyboard.push([{ text: '📲 Cài ESign 2.0', url: `${origin}/?udid=${encodeURIComponent(clean)}&tgapp=esign2` }]);
        keyboard.push([{ text: '📦 Tải chứng chỉ', url: `${origin}/api/download-cert/${encodeURIComponent(clean)}` }]);
      }
      keyboard.push([{ text: '🔎 Tra cứu UDID khác', callback_data: 'lookup_udid' }]);
      await telegramApi(env, 'sendMessage', {
        chat_id: chatId,
        text: `${icon} ${label} (${status})\nUDID: ${clean}\n📱 Dòng máy: ${info.model || 'iPhone/iPad'}${processing ? '\n\n⏳ MuaCert đang tạo file chứng chỉ. Vui lòng kiểm tra lại sau.' : ''}`,
        reply_markup: { inline_keyboard: keyboard }
      });
      return;
    }

    await telegramApi(env, 'sendMessage', {
      chat_id: chatId,
      text: `❌ Không tìm thấy chứng chỉ cho UDID này.\n${data?.message || data?.error || ''}`.trim(),
      reply_markup: { inline_keyboard: [[{ text: '🔎 Thử UDID khác', callback_data: 'lookup_udid' }]] }
    });
  } catch (err) {
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: `❌ Lỗi tra cứu: ${err?.message || 'Không xác định'}` });
  }
}

async function createTelegramPaymentOrder(env, { udid, planId, chatId, userId }) {
  if (!getKV(env)) throw new Error('Cần KV binding CODES_KV');
  const plan = PAYMENT_PLANS[planId];
  if (!plan) throw new Error('Gói thanh toán không hợp lệ');
  if (!/^[A-Za-z0-9-]{12,80}$/.test(String(udid || '').trim())) throw new Error('UDID không hợp lệ');

  let orderCode = '';
  for (let i = 0; i < 5; i++) {
    const candidate = randomOrderCode();
    if (!(await getPaymentInfo(env, candidate))) { orderCode = candidate; break; }
  }
  if (!orderCode) throw new Error('Không tạo được mã thanh toán');

  const now = new Date();
  const content = `SEVQR ${orderCode}`;
  const order = {
    orderCode,
    status: 'pending',
    amount: plan.amount,
    planId: plan.id,
    planLabel: plan.label,
    warrantyDays: plan.warrantyDays,
    udid: String(udid).trim(),
    model: 'iPhone',
    name: String(udid).trim(),
    bank: PAYMENT_BANK,
    accountNumber: PAYMENT_ACCOUNT,
    accountHolder: PAYMENT_HOLDER,
    transferContent: content,
    telegramChatId: String(chatId),
    telegramUserId: userId ? String(userId) : '',
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PAYMENT_EXPIRY_MS).toISOString(),
    updatedAt: now.toISOString()
  };
  await savePaymentInfo(env, orderCode, order);

  const qr = new URL('https://vietqr.app/img');
  qr.searchParams.set('acc', PAYMENT_ACCOUNT);
  qr.searchParams.set('bank', PAYMENT_BANK);
  qr.searchParams.set('amount', String(plan.amount));
  qr.searchParams.set('des', content);
  qr.searchParams.set('template', 'compact');
  qr.searchParams.set('showinfo', 'true');
  qr.searchParams.set('fullacc', 'true');
  qr.searchParams.set('holder', PAYMENT_HOLDER);
  qr.searchParams.set('store', 'vanthang');
  return { order, qrUrl: qr.toString() };
}

async function telegramSendOrder(env, chatId, order, qrUrl) {
  const caption = [
    `💳 Đơn ${order.orderCode}`,
    `Gói: ${order.planLabel}`,
    `Số tiền: ${Number(order.amount).toLocaleString('vi-VN')}đ`,
    `Ngân hàng: ${order.bank}`,
    `STK: ${order.accountNumber}`,
    `Chủ TK: ${order.accountHolder}`,
    `Nội dung: ${order.transferContent}`,
    '',
    '⏱️ Đơn có hiệu lực trong 10 phút.',
    '⚠️ Chuyển đúng số tiền và giữ nguyên nội dung.'
  ].join('\n');
  try {
    await telegramApi(env, 'sendPhoto', {
      chat_id: chatId,
      photo: qrUrl,
      caption,
      reply_markup: { inline_keyboard: [[{ text: '🔄 Kiểm tra thanh toán', callback_data: `status:${order.orderCode}` }]] }
    });
  } catch (_) {
    await telegramApi(env, 'sendMessage', {
      chat_id: chatId,
      text: caption + `\n\nQR: ${qrUrl}`,
      reply_markup: { inline_keyboard: [[{ text: '🔄 Kiểm tra thanh toán', callback_data: `status:${order.orderCode}` }]] }
    });
  }
}

async function telegramSendStatus(env, chatId, order, origin) {
  order = await markPaymentExpired(env, order);
  const map = {
    pending: '⏳ Chờ thanh toán',
    paid_processing: '💰 Đã nhận tiền, đang kích hoạt',
    paid: '💰 Đã nhận tiền',
    activated: '✅ Đã kích hoạt',
    activation_failed: '⚠️ Đã nhận tiền nhưng kích hoạt lỗi',
    expired: '⌛ Đơn đã hết hạn'
  };
  const text = [
    `${map[order.status] || order.status} — ${order.orderCode}`,
    `UDID: ${order.udid}`,
    `Gói: ${order.planLabel || ''}`,
    order.message ? `Trạng thái: ${order.message}` : ''
  ].filter(Boolean).join('\n');
  const keyboard = [];
  if (order.status === 'activated') {
    keyboard.push([
      { text: '📲 Cài ESign', url: `${origin}/?udid=${encodeURIComponent(order.udid)}&tgapp=esign` },
      { text: '📲 Cài KSign', url: `${origin}/?udid=${encodeURIComponent(order.udid)}&tgapp=ksign` }
    ]);
    keyboard.push([{ text: '📲 Cài ESign 2.0', url: `${origin}/?udid=${encodeURIComponent(order.udid)}&tgapp=esign2` }]);
    keyboard.push([{ text: '📦 Tải chứng chỉ', url: `${origin}/api/download-cert/${encodeURIComponent(order.udid)}` }]);
  } else if (order.status === 'expired') {
    keyboard.push([{ text: '🛒 Tạo đơn mới', callback_data: 'buy' }]);
  } else {
    keyboard.push([{ text: '🔄 Kiểm tra lại', callback_data: `status:${order.orderCode}` }]);
  }
  await telegramApi(env, 'sendMessage', { chat_id: chatId, text, reply_markup: { inline_keyboard: keyboard } });
}

async function telegramNotifyActivated(env, order, origin) {
  if (!order?.telegramChatId) return;
  await telegramApi(env, 'sendMessage', {
    chat_id: order.telegramChatId,
    text: `✅ Thanh toán và kích hoạt thành công!\nĐơn: ${order.orderCode}\nUDID: ${order.udid}\nGói: ${order.planLabel || ''}`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📲 Cài ESign', url: `${origin}/?udid=${encodeURIComponent(order.udid)}&tgapp=esign` },
          { text: '📲 Cài KSign', url: `${origin}/?udid=${encodeURIComponent(order.udid)}&tgapp=ksign` }
        ],
        [{ text: '📲 Cài ESign 2.0', url: `${origin}/?udid=${encodeURIComponent(order.udid)}&tgapp=esign2` }],
        [{ text: '📦 Tải chứng chỉ', url: `${origin}/api/download-cert/${encodeURIComponent(order.udid)}` }]
      ]
    }
  });
}

async function handleTelegramUpdate(update, env, origin) {
  const cb = update.callback_query;
  if (cb) {
    const chatId = cb.message?.chat?.id;
    const userId = cb.from?.id;
    const data = String(cb.data || '');
    try { await telegramApi(env, 'answerCallbackQuery', { callback_query_id: cb.id }); } catch (_) {}
    if (!chatId) return;

    if (data === 'buy') {
      await saveTelegramState(env, chatId, { step: 'await_udid', userId, updatedAt: Date.now() });
      await telegramApi(env, 'sendMessage', { chat_id: chatId, text: '📱 Gửi UDID của thiết bị vào đây.' });
      return;
    }
    if (data === 'lookup_udid') {
      await saveTelegramState(env, chatId, { step: 'await_lookup_udid', userId, updatedAt: Date.now() });
      await telegramApi(env, 'sendMessage', { chat_id: chatId, text: '🔎 Gửi UDID cần tra cứu vào đây.' });
      return;
    }
    if (data === 'pricing') {
      await telegramApi(env, 'sendMessage', {
        chat_id: chatId,
        text: '📦 BẢNG GIÁ\n\n🟢 Gói 50.000đ — Bảo hành 10 ngày\n💎 Gói 150.000đ — Bảo hành 365 ngày\n\n⏳ Mỗi đơn thanh toán có hiệu lực 10 phút.',
        reply_markup: telegramMainKeyboard(origin)
      });
      return;
    }
    if (data === 'account') {
      const u = cb.from || {};
      const state = await getTelegramState(env, chatId);
      const username = u.username ? '@' + u.username : 'Chưa đặt username';
      const last = state?.orderCode ? state.orderCode : 'Chưa có';
      await telegramApi(env, 'sendMessage', {
        chat_id: chatId,
        text: `👤 TÀI KHOẢN\n\n🆔 Telegram ID: ${u.id || userId || chatId}\n📛 Tên: ${[u.first_name, u.last_name].filter(Boolean).join(' ') || 'Khách hàng'}\n🔗 Username: ${username}\n🧾 Đơn gần nhất: ${last}`,
        reply_markup: telegramMainKeyboard(origin)
      });
      return;
    }
    if (data === 'language') {
      await telegramApi(env, 'sendMessage', {
        chat_id: chatId,
        text: '🌐 NGÔN NGỮ\n\n🇻🇳 Tiếng Việt đang được sử dụng.\nCác ngôn ngữ khác có thể bổ sung sau.',
        reply_markup: telegramMainKeyboard(origin)
      });
      return;
    }
    if (data === 'guide') {
      await telegramApi(env, 'sendMessage', { chat_id: chatId, text: telegramGuideText(), reply_markup: telegramMainKeyboard(origin) });
      return;
    }
    if (data === 'last_status') {
      const state = await getTelegramState(env, chatId);
      if (!state?.orderCode) {
        await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Bạn chưa có đơn gần nhất.', reply_markup: telegramMainKeyboard(origin) });
        return;
      }
      const order = await getPaymentInfo(env, state.orderCode);
      if (!order) {
        await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Không tìm thấy đơn gần nhất.' });
        return;
      }
      await telegramSendStatus(env, chatId, order, origin);
      return;
    }
    if (data.startsWith('plan:')) {
      const planId = data.slice(5);
      const state = await getTelegramState(env, chatId);
      if (!state?.udid) {
        await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'UDID chưa được lưu. Bấm Mua chứng chỉ và gửi lại UDID.' });
        return;
      }
      const { order, qrUrl } = await createTelegramPaymentOrder(env, { udid: state.udid, planId, chatId, userId });
      await saveTelegramState(env, chatId, { step: 'waiting_payment', udid: state.udid, orderCode: order.orderCode, userId, updatedAt: Date.now() });
      await telegramSendOrder(env, chatId, order, qrUrl);
      return;
    }
    if (data.startsWith('status:')) {
      const code = data.slice(7).trim().toUpperCase();
      const order = await getPaymentInfo(env, code);
      if (!order) {
        await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Không tìm thấy đơn.' });
        return;
      }
      await telegramSendStatus(env, chatId, order, origin);
      return;
    }
    return;
  }

  const msg = update.message;
  if (!msg?.chat?.id) return;
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const text = String(msg.text || '').trim();
  if (text === '/start' || text === '/menu') {
    await saveTelegramState(env, chatId, { step: 'menu', userId, updatedAt: Date.now() });
    await telegramApi(env, 'sendMessage', {
      chat_id: chatId,
      text: '✨ CHUNGCHIDUYLE BOT ✨\n\nMua chứng chỉ tự động 24/7\nTra cứu UDID & cài app ký nhanh\n\nChọn chức năng bên dưới:',
      reply_markup: telegramMainKeyboard(origin)
    });
    return;
  }
  if (text === '/status') {
    const state = await getTelegramState(env, chatId);
    if (state?.orderCode) {
      const order = await getPaymentInfo(env, state.orderCode);
      if (order) return telegramSendStatus(env, chatId, order, origin);
    }
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Chưa có đơn gần nhất.' });
    return;
  }
  if (text === '/lookup') {
    await saveTelegramState(env, chatId, { step: 'await_lookup_udid', userId, updatedAt: Date.now() });
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: '🔎 Gửi UDID cần tra cứu vào đây.' });
    return;
  }
  if (text === '/guide') {
    await telegramApi(env, 'sendMessage', { chat_id: chatId, text: telegramGuideText(), reply_markup: telegramMainKeyboard(origin) });
    return;
  }

  const state = await getTelegramState(env, chatId);
  if (state?.step === 'await_lookup_udid') {
    const udid = text;
    if (!/^[A-Za-z0-9-]{12,80}$/.test(udid)) {
      await telegramApi(env, 'sendMessage', { chat_id: chatId, text: '❌ UDID không hợp lệ. Gửi lại UDID đầy đủ.' });
      return;
    }
    await saveTelegramState(env, chatId, { step: 'menu', userId, updatedAt: Date.now() });
    await telegramLookupUdid(env, chatId, udid, origin);
    return;
  }

  if (state?.step === 'await_udid') {
    const udid = text;
    if (!/^[A-Za-z0-9-]{12,80}$/.test(udid)) {
      await telegramApi(env, 'sendMessage', { chat_id: chatId, text: '❌ UDID không hợp lệ. Gửi lại UDID đầy đủ.' });
      return;
    }
    await saveTelegramState(env, chatId, { step: 'choose_plan', udid, userId, updatedAt: Date.now() });
    await telegramApi(env, 'sendMessage', {
      chat_id: chatId,
      text: `✅ Đã nhận UDID:\n${udid}\n\nChọn gói:`,
      reply_markup: {
        inline_keyboard: [
          [{ text: '50.000đ — BH 10 ngày', callback_data: 'plan:10d' }],
          [{ text: '150.000đ — BH 365 ngày', callback_data: 'plan:365d' }]
        ]
      }
    });
    return;
  }

  await telegramApi(env, 'sendMessage', { chat_id: chatId, text: 'Bấm /start để mở menu.', reply_markup: telegramMainKeyboard(origin) });
}

export default {
  async fetch(request, env, ctx) {
try{const u=new URL(request.url);if(u.pathname==="/esign2.ipa"||u.pathname==="/apps/esign2.ipa"){if(!env.BUCKET)return new Response("R2 BUCKET binding missing",{status:500});const o=await env.BUCKET.get("esign2.ipa");if(!o)return new Response("esign2.ipa not found in R2",{status:404});const h=new Headers();try{o.writeHttpMetadata(h)}catch(e){}h.set("Content-Type","application/octet-stream");return new Response(o.body,{headers:h});}}catch(e){}

    const url = new URL(request.url);

    // Thời gian tự hủy file (10 phút = 10 * 60 * 1000 ms)
    const EXPIRE_AFTER_MS = 10 * 60 * 1000;

    // Xử lý CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key, X-Telegram-Bot-Api-Secret-Token',
        },
      });
    }

    // Telegram webhook setup: mở bằng /api/telegram/setup?admin=<mật khẩu admin>
    if (url.pathname === '/api/telegram/setup' && request.method === 'GET') {
      const admin = url.searchParams.get('admin') || '';
      if (!checkAdminAuth(admin, env)) return jsonResponse({ success: false, message: 'Sai mật khẩu admin.' }, 401);
      const secret = getTelegramWebhookSecret(env);
      const webhookUrl = `${url.origin}/api/telegram/webhook`;
      try {
        const data = await telegramApi(env, 'setWebhook', {
          url: webhookUrl,
          secret_token: secret,
          allowed_updates: ['message', 'callback_query'],
          drop_pending_updates: true
        });
        return jsonResponse({ success: true, bot: '@chungchiduyle_bot', webhookUrl, result: data.result, message: 'Đã đăng ký Telegram webhook.' });
      } catch (e) {
        return jsonResponse({ success: false, message: e.message }, 500);
      }
    }

    if (url.pathname === '/api/telegram/webhook' && request.method === 'POST') {
      const expected = getTelegramWebhookSecret(env);
      const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '';
      if (!expected || !constantTimeEqual(got, expected)) return jsonResponse({ success: false, message: 'Telegram webhook không hợp lệ.' }, 401);
      try {
        const update = await request.json();
        if (ctx?.waitUntil) ctx.waitUntil(handleTelegramUpdate(update, env, url.origin));
        else await handleTelegramUpdate(update, env, url.origin);
        return jsonResponse({ success: true });
      } catch (e) {
        return jsonResponse({ success: false, message: e.message }, 500);
      }
    }

    // Helper lấy R2 Bucket binding
    const getBucket = () => env.BUCKET || env.R2 || env.R2_BUCKET || env.MY_BUCKET || env.www || env.WWW;

    // Hàm tự động dọn dẹp các file IPA cũ hơn 10 phút
    const cleanupExpiredFiles = async (bucket) => {
      try {
        const list = await bucket.list({ limit: 50 });
        const now = Date.now();
        const deletePromises = [];

        for (const obj of list.objects) {
          const uploadedAt = obj.customMetadata?.uploadedAt
            ? parseInt(obj.customMetadata.uploadedAt, 10)
            : new Date(obj.uploaded).getTime();

          if (uploadedAt && (now - uploadedAt > EXPIRE_AFTER_MS)) {
            deletePromises.push(bucket.delete(obj.key));
          }
        }

        if (deletePromises.length > 0) {
          await Promise.allSettled(deletePromises);
        }
      } catch (e) {
        console.warn('Lỗi dọn file hết hạn:', e);
      }
    };

    // Xử lý CORS OPTIONS Preflight cho tất cả các đường dẫn /api/
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400'
        }
      });
    }

    // Endpoint tải file mobileconfig tự động đọc UDID trên iPhone / iPad
    if (url.pathname === '/udid.mobileconfig' || url.pathname === '/api/udid/get') {
      const callbackUrl = `${url.origin}/api/udid/callback`;
      const configPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>PayloadContent</key>
    <dict>
        <key>URL</key>
        <string>${callbackUrl}</string>
        <key>DeviceAttributes</key>
        <array>
            <string>UDID</string>
            <string>PRODUCT</string>
            <string>VERSION</string>
            <string>SERIAL</string>
            <string>MODEL</string>
            <string>IMEI</string>
        </array>
    </dict>
    <key>PayloadOrganization</key>
    <string>Ký App iOS</string>
    <key>PayloadDisplayName</key>
    <string>Lấy Mã UDID Thiết Bị</string>
    <key>PayloadVersion</key>
    <integer>1</integer>
    <key>PayloadUUID</key>
    <string>9CF42BE2-8245-4E1E-86E6-44E7CEE54294</string>
    <key>PayloadIdentifier</key>
    <string>com.signapp.getudid</string>
    <key>PayloadDescription</key>
    <string>Hồ sơ tạm thời đọc mã UDID thiết bị để kích hoạt chứng chỉ iOS.</string>
    <key>PayloadType</key>
    <string>Profile Service</string>
</dict>
</plist>`;

      return new Response(configPlist, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-apple-aspen-config; charset=utf-8',
          'Content-Disposition': 'attachment; filename="udid.mobileconfig"',
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Endpoint nhận thông tin thiết bị gửi về từ iOS khi cài mobileconfig
    if (url.pathname === '/api/udid/callback' && request.method === 'POST') {
      try {
        const bodyText = await request.text();
        const match = bodyText.match(/<key>UDID<\/key>\s*<string>([a-zA-Z0-9-]+)<\/string>/i);
        const udid = match ? match[1].trim() : '';

        // Apple Safari OTA Profile yêu cầu HTTP 301 chuyển hướng về trang web
        const redirectUrl = `${url.origin}/?udid=${encodeURIComponent(udid)}`;
        return new Response(null, {
          status: 301,
          headers: {
            'Location': redirectUrl,
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          }
        });
      } catch (err) {
        return new Response('Lỗi đọc UDID: ' + err.message, { status: 500 });
      }
    }

    // API tao don thanh toan Auto Bank 50K
    if (url.pathname === '/api/payment/create' && request.method === 'POST') {
      try {
        if (!getKV(env)) {
          return jsonResponse({ success: false, message: 'Auto Bank cần Cloudflare KV (CODES_KV) để lưu đơn thanh toán.' }, 500);
        }

        const body = await request.json();
        const udid = String(body.udid || '').trim();
        const model = String(body.model || '').trim() || 'iPhone';
        const name = String(body.name || '').trim() || udid;
        const planId = String(body.plan || '').trim();
        const plan = PAYMENT_PLANS[planId];
        if (!udid) return jsonResponse({ success: false, message: 'Vui lòng nhập UDID trước khi thanh toán.' }, 400);
        if (!/^[A-Za-z0-9-]{12,80}$/.test(udid)) return jsonResponse({ success: false, message: 'UDID không hợp lệ.' }, 400);
        if (!plan) return jsonResponse({ success: false, message: 'Gói thanh toán không hợp lệ. Chỉ hỗ trợ gói 50K/10 ngày hoặc 150K/365 ngày.' }, 400);

        let orderCode = '';
        for (let i = 0; i < 5; i++) {
          const candidate = randomOrderCode();
          if (!(await getPaymentInfo(env, candidate))) { orderCode = candidate; break; }
        }
        if (!orderCode) return jsonResponse({ success: false, message: 'Không tạo được mã thanh toán, vui lòng thử lại.' }, 500);

        const now = new Date();
        const content = `SEVQR ${orderCode}`;
        const order = {
          orderCode,
          status: 'pending',
          amount: plan.amount,
          planId: plan.id,
          planLabel: plan.label,
          warrantyDays: plan.warrantyDays,
          udid,
          model,
          name,
          bank: PAYMENT_BANK,
          accountNumber: PAYMENT_ACCOUNT,
          accountHolder: PAYMENT_HOLDER,
          transferContent: content,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + PAYMENT_EXPIRY_MS).toISOString(),
          updatedAt: now.toISOString()
        };
        await savePaymentInfo(env, orderCode, order);

        const qr = new URL('https://vietqr.app/img');
        qr.searchParams.set('acc', PAYMENT_ACCOUNT);
        qr.searchParams.set('bank', PAYMENT_BANK);
        qr.searchParams.set('amount', String(plan.amount));
        qr.searchParams.set('des', content);
        qr.searchParams.set('template', 'compact');
        qr.searchParams.set('showinfo', 'true');
        qr.searchParams.set('fullacc', 'true');
        qr.searchParams.set('holder', PAYMENT_HOLDER);
        qr.searchParams.set('store', 'vanthang');

        return jsonResponse({
          success: true,
          order: {
            orderCode,
            status: order.status,
            amount: plan.amount,
            planId: plan.id,
            planLabel: plan.label,
            warrantyDays: plan.warrantyDays,
            bank: PAYMENT_BANK,
            accountNumber: PAYMENT_ACCOUNT,
            accountHolder: PAYMENT_HOLDER,
            transferContent: content,
            qrUrl: qr.toString(),
            expiresAt: order.expiresAt
          }
        });
      } catch (err) {
        return jsonResponse({ success: false, message: 'Lỗi tạo đơn thanh toán: ' + err.message }, 500);
      }
    }

    // API kiem tra trang thai don Auto Bank
    if (url.pathname === '/api/payment/status' && request.method === 'GET') {
      const orderCode = String(url.searchParams.get('order') || '').trim().toUpperCase();
      if (!orderCode) return jsonResponse({ success: false, message: 'Thiếu mã đơn.' }, 400);
      let order = await getPaymentInfo(env, orderCode);
      if (!order) return jsonResponse({ success: false, message: 'Không tìm thấy đơn thanh toán.' }, 404);
      order = await markPaymentExpired(env, order);
      return jsonResponse({
        success: true,
        order: {
          orderCode: order.orderCode,
          status: order.status,
          amount: order.amount,
          udid: order.udid,
          paidAt: order.paidAt || null,
          activatedAt: order.activatedAt || null,
          message: order.message || '',
          planId: order.planId || '',
          planLabel: order.planLabel || '',
          warrantyDays: Number(order.warrantyDays || 0),
          warrantyExpiresAt: order.warrantyExpiresAt || null,
          expiresAt: order.expiresAt || paymentExpiresAt(order.createdAt),
          expiredAt: order.expiredAt || null
        }
      });
    }

    // Webhook SePay: xac nhan tien vao va tu dong kich hoat MuaCert
    if (url.pathname === '/api/sepay/webhook' && request.method === 'POST') {
      try {
        const rawBody = await request.text();
        const hasAuthConfig = Boolean((env.SEPAY_WEBHOOK_SECRET || env.SEPAY_WEBHOOK_API_KEY || env.SEPAY_API_KEY || '').trim());
        if (!hasAuthConfig) return jsonResponse({ success: false, message: 'Chưa cấu hình secret/API key cho webhook SePay.' }, 503);
        if (!(await verifySePayWebhook(request, rawBody, env))) {
          return jsonResponse({ success: false, message: 'Webhook SePay không hợp lệ.' }, 401);
        }

        let tx;
        try { tx = JSON.parse(rawBody); } catch (_) { return jsonResponse({ success: false, message: 'Payload JSON không hợp lệ.' }, 400); }
        const txId = String(tx.id ?? '').trim();
        if (!txId) return jsonResponse({ success: false, message: 'Thiếu ID giao dịch SePay.' }, 400);

        const oldTx = await getSePayTransaction(env, txId);
        if (oldTx && oldTx.status === 'completed') return jsonResponse({ success: true, duplicate: true });

        if (String(tx.transferType || '').toLowerCase() !== 'in') {
          await saveSePayTransaction(env, txId, { status: 'ignored', reason: 'not_in', at: new Date().toISOString() });
          return jsonResponse({ success: true, ignored: true });
        }
        if (normalizeAccountNumber(tx.accountNumber) !== normalizeAccountNumber(PAYMENT_ACCOUNT)) {
          await saveSePayTransaction(env, txId, { status: 'ignored', reason: 'wrong_account', at: new Date().toISOString() });
          return jsonResponse({ success: true, ignored: true });
        }

        const content = String(tx.content || '').toUpperCase();
        const codeFromPayload = String(tx.code || '').trim().toUpperCase();
        const codeMatch = content.match(/\bDL[A-Z0-9]{8}\b/);
        const orderCode = (/^DL[A-Z0-9]{8}$/.test(codeFromPayload) ? codeFromPayload : (codeMatch ? codeMatch[0] : ''));
        if (!orderCode) {
          await saveSePayTransaction(env, txId, { status: 'ignored', reason: 'no_order_code', at: new Date().toISOString() });
          return jsonResponse({ success: true, ignored: true });
        }

        let order = await getPaymentInfo(env, orderCode);
        if (!order) {
          await saveSePayTransaction(env, txId, { status: 'ignored', reason: 'order_not_found', orderCode, at: new Date().toISOString() });
          return jsonResponse({ success: true, ignored: true });
        }
        order = await markPaymentExpired(env, order);
        if (order.status === 'expired') {
          await saveSePayTransaction(env, txId, { status: 'ignored', reason: 'order_expired', orderCode, transferAmount: Number(tx.transferAmount || 0), at: new Date().toISOString() });
          return jsonResponse({ success: true, ignored: true, reason: 'order_expired' });
        }
        if (['activated', 'paid'].includes(order.status)) {
          await saveSePayTransaction(env, txId, { status: 'completed', duplicateOrder: true, orderCode, at: new Date().toISOString() });
          return jsonResponse({ success: true, duplicate: true });
        }

        const transferAmount = Number(tx.transferAmount || 0);
        if (transferAmount !== Number(order.amount)) {
          await saveSePayTransaction(env, txId, { status: 'ignored', reason: 'wrong_amount', orderCode, transferAmount, at: new Date().toISOString() });
          await savePaymentInfo(env, orderCode, {
            ...order,
            lastReceivedAmount: transferAmount,
            message: `Đã nhận giao dịch ${transferAmount.toLocaleString('vi-VN')}đ nhưng đơn cần ${Number(order.amount).toLocaleString('vi-VN')}đ.`,
            updatedAt: new Date().toISOString()
          });
          return jsonResponse({ success: true, ignored: true, reason: 'wrong_amount' });
        }

        const paidAt = new Date().toISOString();
        const paidOrder = {
          ...order,
          status: 'paid_processing',
          paidAt,
          sepayTransactionId: txId,
          sepayReferenceCode: tx.referenceCode || '',
          message: 'Đã nhận thanh toán, đang kích hoạt thiết bị...',
          updatedAt: paidAt
        };
        await savePaymentInfo(env, orderCode, paidOrder);

        const activation = await activateMuacertDevice(env, {
          udid: order.udid,
          name: order.name || order.udid,
          model: order.model || 'iPhone'
        });

        const activatedAt = new Date().toISOString();
        if (activation.ok || activation.code === 2002) {
          const warrantyDays = Number(order.warrantyDays || 0);
          const warrantyExpiresAt = warrantyDays > 0
            ? new Date(new Date(activatedAt).getTime() + warrantyDays * 24 * 60 * 60 * 1000).toISOString()
            : null;
          await savePaymentInfo(env, orderCode, {
            ...paidOrder,
            status: 'activated',
            activatedAt,
            warrantyExpiresAt,
            deviceId: activation.data?.data?.device?.id || '',
            message: activation.code === 2002 ? 'Đã nhận tiền. UDID đã tồn tại trên MuaCert và được ghi nhận là đã kích hoạt.' : 'Thanh toán và kích hoạt thành công.',
            updatedAt: activatedAt
          });
          await saveSePayTransaction(env, txId, { status: 'completed', orderCode, amount: transferAmount, at: activatedAt });
          if (paidOrder.telegramChatId) {
            const finalOrder = { ...paidOrder, status: 'activated', activatedAt, warrantyExpiresAt };
            if (ctx?.waitUntil) ctx.waitUntil(telegramNotifyActivated(env, finalOrder, url.origin).catch(() => {}));
            else telegramNotifyActivated(env, finalOrder, url.origin).catch(() => {});
          }
          return jsonResponse({ success: true, orderCode, activated: true });
        }

        await savePaymentInfo(env, orderCode, {
          ...paidOrder,
          status: 'activation_failed',
          message: 'Đã nhận tiền nhưng kích hoạt MuaCert thất bại: ' + activation.message,
          activationErrorCode: activation.code,
          updatedAt: activatedAt
        });
        await saveSePayTransaction(env, txId, { status: 'completed', orderCode, amount: transferAmount, activationFailed: true, at: activatedAt });
        return jsonResponse({ success: true, orderCode, activated: false });
      } catch (err) {
        return jsonResponse({ success: false, message: 'Lỗi xử lý webhook: ' + err.message }, 500);
      }
    }

    // API Kích hoạt gói 50K (Package 3) bằng Mã Code
    if (url.pathname === '/api/activate' && request.method === 'POST') {
      try {
        const body = await request.json();
        const code = (body.code || '').trim().toUpperCase();
        const udid = (body.udid || '').trim();
        const model = (body.model || '').trim() || 'iPhone';
        const name = (body.name || '').trim() || udid;

        if (!code) {
          return new Response(JSON.stringify({ success: false, message: 'Vui lòng nhập mã kích hoạt.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        if (!udid) {
          return new Response(JSON.stringify({ success: false, message: 'Vui lòng nhập mã UDID của thiết bị.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const codeData = await getCodeInfo(env, code);
        if (!codeData) {
          return new Response(JSON.stringify({ success: false, message: 'Mã kích hoạt không tồn tại hoặc không chính xác.' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        if (codeData.used) {
          return new Response(JSON.stringify({
            success: false,
            message: `Mã này đã được kích hoạt trước đó (UDID: ${codeData.udid ? codeData.udid.slice(0, 8) + '...' : 'Đã ẩn'}).`
          }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const apiToken = getMuacertApiToken(env);
        if (!apiToken) {
          return new Response(JSON.stringify({ success: false, message: 'Chưa cấu hình MUACERT_API_TOKEN trên Cloudflare Dashboard.' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // Gọi API MuaCert thêm thiết bị vào Package 3 (50.000 VNĐ)
        const mcRes = await fetch('https://muacert.com/openapi/v1/devices', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            udid,
            name,
            model,
            package: 3,
            currency: 'VND'
          })
        });

        const mcData = await mcRes.json();

        if (!mcRes.ok || mcData.code !== 0) {
          let errMsg = mcData.message || 'Lỗi khi kích hoạt thiết bị trên hệ thống MuaCert.';
          if (mcData.code === 2001) errMsg = 'Số dư tài khoản API hiện không đủ để kích hoạt, vui lòng liên hệ admin.';
          if (mcData.code === 2002) errMsg = 'Thiết bị UDID này đã tồn tại trên hệ thống!';
          return new Response(JSON.stringify({
            success: false,
            code: mcData.code,
            message: errMsg,
            details: mcData
          }), {
            status: mcRes.status === 200 ? 400 : mcRes.status,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // Đánh dấu mã đã sử dụng
        const nowIso = new Date().toISOString();
        await saveCodeInfo(env, code, {
          ...codeData,
          used: true,
          usedAt: nowIso,
          udid,
          name,
          model,
          deviceId: mcData.data?.device?.id || ''
        });

        return new Response(JSON.stringify({
          success: true,
          message: 'Kích hoạt thành công cho thiết bị!',
          data: {
            udid,
            device: mcData.data?.device || {},
            activatedAt: nowIso
          }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, message: 'Lỗi server: ' + err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // API Admin: Tạo danh sách mã kích hoạt mới
    if (url.pathname === '/api/admin/generate-codes' && request.method === 'POST') {
      try {
        const adminKeyHeader = request.headers.get('X-Admin-Key');
        if (!checkAdminAuth(adminKeyHeader, env)) {
          return new Response(JSON.stringify({ success: false, message: 'Sai mật khẩu admin.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const body = await request.json().catch(() => ({}));
        const count = Math.min(Math.max(parseInt(body.count, 10) || 1, 1), 50);
        const prefix = (body.prefix || '').trim().toUpperCase();
        const pkg = parseInt(body.package, 10) || 3;

        const generatedCodes = [];
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

        for (let i = 0; i < count; i++) {
          let randomStr = '';
          for (let j = 0; j < 16; j++) {
            randomStr += chars.charAt(Math.floor(Math.random() * chars.length));
          }
          const fullCode = prefix ? `${prefix}${randomStr}` : randomStr;

          const item = {
            code: fullCode,
            package: pkg,
            used: false,
            createdAt: new Date().toISOString()
          };

          await saveCodeInfo(env, fullCode, item);
          generatedCodes.push(fullCode);
        }

        const allCodes = await listAllCodes(env);

        return new Response(JSON.stringify({
          success: true,
          message: `Đã tạo thành công ${generatedCodes.length} mã!`,
          codes: generatedCodes,
          allCodes
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, message: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // API Admin: Lấy danh sách mã
    if (url.pathname === '/api/admin/list-codes' && request.method === 'GET') {
      try {
        const adminKeyHeader = request.headers.get('X-Admin-Key');
        if (!checkAdminAuth(adminKeyHeader, env)) {
          return new Response(JSON.stringify({ success: false, message: 'Sai mật khẩu admin.' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const allCodes = await listAllCodes(env);

        return new Response(JSON.stringify({
          success: true,
          codes: allCodes
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });

      } catch (err) {
        return new Response(JSON.stringify({ success: false, message: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // API Tải file chứng chỉ theo UDID từ muacert.com
    if (url.pathname.startsWith('/api/download-cert/') && request.method === 'GET') {
      try {
        const udid = url.pathname.replace('/api/download-cert/', '').trim();
        if (!udid) {
          return new Response(JSON.stringify({ error: 'Thiếu tham số UDID' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const apiToken = getMuacertApiToken(env);
        if (!apiToken) {
          return new Response(JSON.stringify({ error: 'Chưa cấu hình MUACERT_API_TOKEN trên Cloudflare Dashboard' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const certRes = await fetch(`https://muacert.com/openapi/v1/certificate/${encodeURIComponent(udid)}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
          }
        });

        const certData = await certRes.json();

        if (!certRes.ok || certData.code !== 0 || !certData.data?.downloadUrl) {
          return new Response(JSON.stringify({
            error: certData.message || 'Không tìm thấy chứng chỉ hoặc chứng chỉ chưa sẵn sàng',
            details: certData
          }), {
            status: certRes.status === 200 ? 404 : certRes.status,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const certStatus = (certData.data?.status || '').toUpperCase();
        if (certStatus === 'PROCESSING') {
          return new Response(JSON.stringify({
            error: 'Chứng chỉ đang trong tiến trình xử lý (PROCESSING). Hệ thống MuaCert cần ít phút để khởi tạo file chứng chỉ, vui lòng quay lại sau ít phút!',
            status: 'PROCESSING',
            isProcessing: true,
            details: certData.data
          }), {
            status: 422,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        if (certStatus.includes('REVOKED') || certStatus.includes('BANNED')) {
          return new Response(JSON.stringify({
            error: `Chứng chỉ đã bị thu hồi (${certStatus}). Vui lòng liên hệ Admin qua Telegram @lethanhduyy.`,
            status: certStatus,
            isRevoked: true
          }), {
            status: 410,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // Proxy trực tiếp dữ liệu file zip từ MuaCert CDN về cho trình duyệt bằng ArrayBuffer
        const zipFileRes = await fetch(certData.data.downloadUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
            'Accept': '*/*'
          }
        });

        if (!zipFileRes.ok) {
          const cdnData = await zipFileRes.json().catch(() => null);
          let errMsg = cdnData?.message || 'Không thể lấy dữ liệu zip chứng chỉ từ CDN';
          if (cdnData && (cdnData.message === 'Certificate file not found' || cdnData.code === 1004)) {
            const addedAtMs = certData.data?.addedAt ? new Date(certData.data.addedAt).getTime() : 0;
            const isOld = addedAtMs > 0 && (Date.now() - addedAtMs > 24 * 60 * 60 * 1000);
            if (isOld) {
              errMsg = 'File chứng chỉ của thiết bị này đã hết hạn lưu trữ hoặc không còn trên MuaCert (Mã 1004: File not found). Vui lòng kiểm tra lại trên muacert.com!';
            } else {
              errMsg = 'File chứng chỉ chưa sẵn sàng trên MuaCert (đang được hệ thống khởi tạo). Vui lòng đợi ít phút rồi thử lại!';
            }
          }
          return new Response(JSON.stringify({ 
            error: errMsg, 
            status: certStatus,
            details: cdnData
          }), {
            status: zipFileRes.status,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const zipArrayBuffer = await zipFileRes.arrayBuffer();

        return new Response(zipArrayBuffer, {
          status: 200,
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${udid}.zip"`,
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': '*'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message || 'Lỗi khi tải chứng chỉ' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // API Tra cứu trạng thái chứng chỉ chi tiết theo UDID
    if (url.pathname.startsWith('/api/cert-status/') && request.method === 'GET') {
      try {
        const udid = url.pathname.replace('/api/cert-status/', '').trim();
        if (!udid) {
          return new Response(JSON.stringify({ error: 'Thiếu tham số UDID' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const apiToken = getMuacertApiToken(env);
        if (!apiToken) {
          return new Response(JSON.stringify({ error: 'Chưa cấu hình MUACERT_API_TOKEN trên Cloudflare Dashboard' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const certRes = await fetch(`https://muacert.com/openapi/v1/certificate/${encodeURIComponent(udid)}`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiToken}`,
            'Content-Type': 'application/json'
          }
        });

        const certData = await certRes.json();
        return new Response(JSON.stringify(certData), {
          status: certRes.status,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // API Upload trực tiếp lên Cloudflare R2 (Tự hủy sau 10 phút)
    if (url.pathname === '/api/upload' && request.method === 'POST') {
      try {
        const bucket = getBucket();
        if (!bucket) {
          return new Response(JSON.stringify({
            error: 'Chưa cấu hình R2 Bucket binding (tên biến: BUCKET hoặc www) trong Cloudflare Settings'
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const formData = await request.formData();
        const file = formData.get('file');

        if (!file) {
          return new Response(JSON.stringify({ error: 'Không tìm thấy file tải lên' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        const uniqueId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        const key = `${uniqueId}.ipa`;
        const now = Date.now();

        await bucket.put(key, file.stream ? file.stream() : await file.arrayBuffer(), {
          httpMetadata: {
            contentType: 'application/octet-stream',
          },
          customMetadata: {
            uploadedAt: now.toString(),
            originalName: file.name || 'app_signed.ipa'
          }
        });

        // Chạy dọn dẹp các file cũ ngầm trong background
        if (ctx && ctx.waitUntil) {
          ctx.waitUntil(cleanupExpiredFiles(bucket));
        } else {
          cleanupExpiredFiles(bucket).catch(() => {});
        }

        const downloadUrl = `${url.origin}/api/download/${key}`;

        return new Response(JSON.stringify({
          success: true,
          key,
          url: downloadUrl,
          expiresIn: '10m'
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message || 'Lỗi upload lên R2' }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    // API Download file IPA từ R2
    if ((url.pathname.startsWith('/api/download/') || url.pathname.startsWith('/ipa/')) && request.method === 'GET') {
      try {
        const key = decodeURIComponent(url.pathname.replace(/^\/(api\/download|ipa)\//, ''));
        const bucket = getBucket();
        if (!bucket) {
          return new Response('R2 Bucket chưa được cấu hình', { status: 500 });
        }

        const object = await bucket.get(key);
        if (!object) {
          return new Response('File không tồn tại hoặc đã hết hạn (tự động xóa sau 10 phút)', { status: 404 });
        }

        // Kiểm tra thời hạn 10 phút
        const now = Date.now();
        const uploadedAt = object.customMetadata?.uploadedAt
          ? parseInt(object.customMetadata.uploadedAt, 10)
          : new Date(object.uploaded).getTime();

        if (uploadedAt && (now - uploadedAt > EXPIRE_AFTER_MS)) {
          // Đã quá 10 phút -> Xóa ngay lập tức khỏi R2
          await bucket.delete(key);
          return new Response('Liên kết tải đã hết hạn (tự động xóa sau 10 phút)', { status: 410 });
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        headers.set('Content-Type', 'application/octet-stream');
        headers.set('Access-Control-Allow-Origin', '*');
        const filename = object.customMetadata?.originalName || key;
        headers.set('Content-Disposition', `attachment; filename="${filename}"`);

        return new Response(object.body, { headers });
      } catch (err) {
        return new Response('Lỗi khi tải file từ R2: ' + err.message, { status: 500 });
      }
    }

    // Xử lý tạo manifest plist cho OTA installation
    if (url.pathname.startsWith('/manifest/') && url.pathname.endsWith('.plist')) {
      const parts = url.pathname.split('/');

      if (parts.length >= 7) {
        const bundle = decodeURIComponent(parts[2]);
        const name = decodeURIComponent(parts[3]);
        const version = decodeURIComponent(parts[4]);
        const ipaUrl = decodeURIComponent(parts.slice(5, parts.length - 1).join('/'));

        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${ipaUrl.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${bundle.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string>
        <key>bundle-version</key>
        <string>${version.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>`;

        return new Response(plist, {
          headers: {
            'Content-Type': 'application/x-apple-aspen-manifest',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    // Xử lý link rút gọn: /m/:fileId/:appId
    if (url.pathname.startsWith('/m/')) {
      const parts = url.pathname.split('/');
      if (parts.length >= 4) {
        const fileId = decodeURIComponent(parts[2]);
        const appId = parts[3];

        // Danh sách thông tin ứng dụng cơ bản
        const APPS = {
          esign: { name: 'ESIGN', bundle: 'p3.xyz.yyyue.esign', version: '5.0.2' },
          ksign: { name: 'KSign', bundle: 'nya.asami.ksign', version: '1.5.1' },
          esign2: { name: 'ESign 2.0', bundle: 'cn.swing.esign', version: '1.0' }
        };

        const appInfo = APPS[appId] || APPS['esign'];
        let ipaUrl = fileId;
        if (!ipaUrl.startsWith('http')) {
          if (fileId.includes('uguu')) {
            ipaUrl = `https://a.uguu.se/${fileId}`;
          } else if (fileId.includes('catbox') || fileId.includes('litterbox')) {
            ipaUrl = `https://litterbox.catbox.moe/${fileId}`;
          } else {
            ipaUrl = `${url.origin}/api/download/${fileId}`;
          }
        }

        const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>items</key>
  <array>
    <dict>
      <key>assets</key>
      <array>
        <dict>
          <key>kind</key>
          <string>software-package</string>
          <key>url</key>
          <string>${ipaUrl.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</string>
        </dict>
      </array>
      <key>metadata</key>
      <dict>
        <key>bundle-identifier</key>
        <string>${appInfo.bundle}</string>
        <key>bundle-version</key>
        <string>${appInfo.version}</string>
        <key>kind</key>
        <string>software</string>
        <key>title</key>
        <string>${appInfo.name}</string>
      </dict>
    </dict>
  </array>
</dict>
</plist>`;

        return new Response(plist, {
          headers: {
            'Content-Type': 'application/x-apple-aspen-manifest',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    // Dành cho các file tĩnh khác (HTML, JS, CSS, IPA mẫu)
    if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
      return env.ASSETS.fetch(request);
    }
    return fetch(request);
  }
};
