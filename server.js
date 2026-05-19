/**
 * Lastikli Çarşaf — WhatsApp notification worker
 *
 * Architecture:
 *   PHP backend (lastiklicarsaf.tr) → HTTP POST → bu Node.js worker → WhatsApp Web (whatsapp-web.js)
 *
 * QR auth (ilk çalıştırma):
 *   pm2 logs lastikli-whatsapp-worker → terminal QR çıkar → WhatsApp uygulamasından "Bağlı Cihazlar → Cihaz Bağla"
 *
 * Endpoints:
 *   GET  /status                       → bağlantı durumu (auth, ready)
 *   POST /notify/order-received        → yeni sipariş onay mesajı
 *   POST /notify/cargo-shipped         → kargo takip no mesajı
 *   POST /notify/delivery-tomorrow     → "yarın teslim" hatırlatma
 *   POST /notify/delivered             → teslim sonrası teşekkür
 *
 * Auth: tüm POST endpoint'leri X-Worker-Secret header'ında WORKER_SECRET gerekir.
 */

import 'dotenv/config';
import express from 'express';
import qrcode from 'qrcode-terminal';
import pkg from 'whatsapp-web.js';
const { Client, LocalAuth } = pkg;

const PORT = parseInt(process.env.PORT || '3000', 10);
const SECRET = process.env.WORKER_SECRET || '';
const SESSION_PATH = process.env.SESSION_PATH || './session';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

if (!SECRET || SECRET === 'change-me-to-something-random-and-long') {
  console.error('❌ WORKER_SECRET set edilmedi veya default — .env dosyasını düzelt.');
  process.exit(1);
}

/* ─── Logger ─── */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const log = (level, ...args) => {
  if (LEVELS[level] <= LEVELS[LOG_LEVEL]) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${level.toUpperCase()}]`, ...args);
  }
};

/* ─── Optional Telegram alerter (worker hatalarını admin'e bildirir) ─── */
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT  = process.env.TELEGRAM_CHAT_ID || '';
const alertAdmin = async (msg) => {
  if (!TG_TOKEN || !TG_CHAT) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TG_CHAT, text: `🤖 WhatsApp Worker: ${msg}` }),
    });
  } catch { /* swallow */ }
};

/* ─── WhatsApp Client ─── */
let waReady = false;
let waAuthState = 'initializing'; // initializing | qr | authenticated | ready | disconnected

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
    ],
  },
});

client.on('qr', (qr) => {
  waAuthState = 'qr';
  log('info', '📱 QR kod oluşturuldu. WhatsApp uygulamasından tara:');
  qrcode.generate(qr, { small: true });
  log('info', '   WhatsApp → ⋮ → Bağlı Cihazlar → Cihaz Bağla');
});

client.on('authenticated', () => {
  waAuthState = 'authenticated';
  log('info', '✅ WhatsApp authentication başarılı.');
});

client.on('auth_failure', (msg) => {
  waAuthState = 'disconnected';
  log('error', '❌ WhatsApp auth başarısız:', msg);
  alertAdmin(`Auth failure: ${msg}`);
});

client.on('ready', () => {
  waReady = true;
  waAuthState = 'ready';
  log('info', '🚀 WhatsApp Web hazır — mesaj atmaya başlayabiliriz.');
  alertAdmin('Worker hazır, WhatsApp bağlı.');
});

client.on('disconnected', (reason) => {
  waReady = false;
  waAuthState = 'disconnected';
  log('warn', '⚠️ WhatsApp bağlantısı koptu:', reason);
  alertAdmin(`Disconnected: ${reason} — yeniden başlatmaya çalışıyor.`);
  // pm2 restart yapsın diye process'i çıkar
  setTimeout(() => process.exit(1), 2000);
});

log('info', '🔄 WhatsApp client başlatılıyor...');
client.initialize().catch(err => {
  log('error', 'Initialize hatası:', err.message);
  alertAdmin(`Initialize error: ${err.message}`);
  process.exit(1);
});

/* ─── Phone helpers ─── */
/**
 * Türk telefon numarasını WhatsApp ID formatına çevir.
 * "0555..." / "+90555..." / "555..." → "905551234567@c.us"
 */
const toWhatsAppId = (phone) => {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  let normalized;
  if (digits.length === 11 && digits.startsWith('0')) {
    normalized = '90' + digits.substring(1);          // 0555... → 90555...
  } else if (digits.length === 10 && digits.startsWith('5')) {
    normalized = '90' + digits;                       // 555... → 90555...
  } else if (digits.length === 12 && digits.startsWith('90')) {
    normalized = digits;                              // 90555... → kullan
  } else if (digits.length === 13 && digits.startsWith('900')) {
    normalized = '90' + digits.substring(3);          // hatalı 0090555... → 90555...
  } else {
    return null;
  }
  if (!/^905\d{9}$/.test(normalized)) return null;    // 90 + 5 + 9 digit
  return `${normalized}@c.us`;
};

/* ─── Message templates ─── */
const tmpl = {
  orderReceived: ({ customerName, orderNo, total, sizes }) => {
    const first = (customerName || '').split(' ')[0] || 'değerli müşterimiz';
    const sizeText = sizes && sizes.length ? `\n📦 *Seçilen boylar:* ${sizes.join(', ')}` : '';
    const totalText = total ? `\n💰 *Tutar:* ${total} TL (kapıda ödeme)` : '';
    return [
      `Merhaba ${first} 👋`,
      ``,
      `*Lastikli Çarşaf*'tan siparişinizi aldık! 🎉`,
      ``,
      `📋 *Sipariş No:* ${orderNo}${sizeText}${totalText}`,
      ``,
      `Hazırlığı bitince kargoya verip takip numarasıyla size yazacağız.`,
      `Sorularınız için bu numaradan ulaşabilirsiniz.`,
      ``,
      `Teşekkürler 🙏`,
    ].join('\n');
  },

  cargoShipped: ({ customerName, orderNo, trackingNumber, trackingUrl }) => {
    const first = (customerName || '').split(' ')[0] || 'değerli müşterimiz';
    const urlLine = trackingUrl ? `\n🔗 *Takip linki:* ${trackingUrl}` : '';
    return [
      `Merhaba ${first} 👋`,
      ``,
      `Siparişiniz *kargoya verildi* 🚚`,
      ``,
      `📋 *Sipariş No:* ${orderNo}`,
      `📦 *Kargo Takip No:* ${trackingNumber}${urlLine}`,
      ``,
      `1-3 iş günü içinde kapınızda olacak. Kapıda nakit veya kart ile ödeyebilirsiniz.`,
      ``,
      `Lastikli Çarşaf 🛏️`,
    ].join('\n');
  },

  deliveryTomorrow: ({ customerName, orderNo, trackingNumber }) => {
    const first = (customerName || '').split(' ')[0] || 'değerli müşterimiz';
    return [
      `Merhaba ${first} 👋`,
      ``,
      `Siparişiniz *yarın teslim edilecek* 📦`,
      ``,
      `📋 *Sipariş No:* ${orderNo}`,
      `🚚 *Takip No:* ${trackingNumber}`,
      ``,
      `Kapıda nakit veya kart ile ödeme alacak. Lütfen telefonunuzun açık olmasına dikkat edin.`,
      ``,
      `Lastikli Çarşaf 🛏️`,
    ].join('\n');
  },

  delivered: ({ customerName, orderNo }) => {
    const first = (customerName || '').split(' ')[0] || 'değerli müşterimiz';
    return [
      `Merhaba ${first} 👋`,
      ``,
      `Siparişiniz teslim edildi 🎉`,
      ``,
      `📋 *Sipariş No:* ${orderNo}`,
      ``,
      `Lastikli çarşaflarınızı umarız sevmişsinizdir 🛏️`,
      `Memnun kaldıysanız bir 5 yıldız değerlendirmenizi çok severiz: ⭐⭐⭐⭐⭐`,
      ``,
      `Yeniden görüşmek üzere 🙏`,
      `*Lastikli Çarşaf*`,
    ].join('\n');
  },
};

/* ─── Express API ─── */
const app = express();
app.use(express.json({ limit: '100kb' }));

// Auth middleware
const requireSecret = (req, res, next) => {
  const got = req.header('X-Worker-Secret') || '';
  if (got !== SECRET) {
    log('warn', `Yetkisiz istek: ${req.path} from ${req.ip}`);
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
};

// Send helper
const sendMessage = async (phone, text) => {
  if (!waReady) {
    return { ok: false, error: 'WhatsApp henüz hazır değil', state: waAuthState };
  }
  const id = toWhatsAppId(phone);
  if (!id) {
    return { ok: false, error: 'Geçersiz telefon formatı: ' + phone };
  }
  try {
    // Telefon WhatsApp'a kayıtlı mı kontrol et
    const numberId = await client.getNumberId(id.replace('@c.us', ''));
    if (!numberId) {
      return { ok: false, error: 'Bu numara WhatsApp\'a kayıtlı değil: ' + phone };
    }
    const msg = await client.sendMessage(numberId._serialized, text);
    log('info', `✉️  Sent to ${phone} (${id}): ${msg.id._serialized}`);
    return { ok: true, messageId: msg.id._serialized };
  } catch (err) {
    log('error', `Send failed to ${phone}:`, err.message);
    return { ok: false, error: err.message };
  }
};

/* ─── Routes ─── */
app.get('/status', (req, res) => {
  res.json({
    ok: true,
    state: waAuthState,
    ready: waReady,
    uptime: process.uptime(),
    version: '1.0.0',
  });
});

app.post('/notify/order-received', requireSecret, async (req, res) => {
  const { phone, customerName, orderNo, total, sizes } = req.body || {};
  if (!phone || !orderNo) {
    return res.status(400).json({ ok: false, error: 'phone ve orderNo gerekli' });
  }
  const text = tmpl.orderReceived({ customerName, orderNo, total, sizes });
  const result = await sendMessage(phone, text);
  res.status(result.ok ? 200 : 500).json(result);
});

app.post('/notify/cargo-shipped', requireSecret, async (req, res) => {
  const { phone, customerName, orderNo, trackingNumber, trackingUrl } = req.body || {};
  if (!phone || !orderNo || !trackingNumber) {
    return res.status(400).json({ ok: false, error: 'phone, orderNo, trackingNumber gerekli' });
  }
  const text = tmpl.cargoShipped({ customerName, orderNo, trackingNumber, trackingUrl });
  const result = await sendMessage(phone, text);
  res.status(result.ok ? 200 : 500).json(result);
});

app.post('/notify/delivery-tomorrow', requireSecret, async (req, res) => {
  const { phone, customerName, orderNo, trackingNumber } = req.body || {};
  if (!phone || !orderNo) {
    return res.status(400).json({ ok: false, error: 'phone ve orderNo gerekli' });
  }
  const text = tmpl.deliveryTomorrow({ customerName, orderNo, trackingNumber });
  const result = await sendMessage(phone, text);
  res.status(result.ok ? 200 : 500).json(result);
});

app.post('/notify/delivered', requireSecret, async (req, res) => {
  const { phone, customerName, orderNo } = req.body || {};
  if (!phone || !orderNo) {
    return res.status(400).json({ ok: false, error: 'phone ve orderNo gerekli' });
  }
  const text = tmpl.delivered({ customerName, orderNo });
  const result = await sendMessage(phone, text);
  res.status(result.ok ? 200 : 500).json(result);
});

// Generic raw send — testing & ad-hoc usage
app.post('/notify/raw', requireSecret, async (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || !message) {
    return res.status(400).json({ ok: false, error: 'phone ve message gerekli' });
  }
  const result = await sendMessage(phone, message);
  res.status(result.ok ? 200 : 500).json(result);
});

app.listen(PORT, '0.0.0.0', () => {
  log('info', `🌐 HTTP listening on :${PORT}`);
});

// Graceful shutdown
const shutdown = () => {
  log('info', '👋 Kapatılıyor...');
  client.destroy().finally(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
