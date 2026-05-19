/**
 * Lastikli Çarşaf — WhatsApp notification worker (Baileys)
 *
 * No Chromium / puppeteer — bağlanmak için direkt WhatsApp Web protokolü kullanır.
 * Termux/Android ve ARM Linux'ta sorunsuz çalışır.
 *
 * QR auth (ilk çalıştırma):
 *   - Terminal'de QR kod çıkar → WhatsApp uygulamasından ⋮ → Bağlı Cihazlar → Cihaz Bağla
 *   - Session ./session/ klasörüne kaydedilir, bir daha QR gerekmez
 *
 * Endpoints:
 *   GET  /status                    → bağlantı durumu
 *   POST /notify/order-received     → yeni sipariş onay mesajı
 *   POST /notify/cargo-shipped      → kargo takip no mesajı
 *   POST /notify/delivery-tomorrow  → yarın teslim hatırlatma
 *   POST /notify/delivered          → teslim sonrası teşekkür
 *   POST /notify/raw                → manuel mesaj (test)
 *
 * Auth: tüm POST endpoint'leri X-Worker-Secret header'ında WORKER_SECRET gerekir.
 */

import 'dotenv/config';
import express from 'express';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} from '@whiskeysockets/baileys';

const PORT = parseInt(process.env.PORT || '3000', 10);
const SECRET = process.env.WORKER_SECRET || '';
const SESSION_PATH = process.env.SESSION_PATH || './session';
const LOG_LEVEL = (process.env.LOG_LEVEL || 'info').toLowerCase();

if (!SECRET || SECRET === 'change-me-to-something-random-and-long') {
  console.error('❌ WORKER_SECRET set edilmedi veya default — .env dosyasını düzelt.');
  process.exit(1);
}

const logger = pino({ level: LOG_LEVEL });

/* ─── Optional Telegram alerter ─── */
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

/* ─── WhatsApp State ─── */
let sock = null;
let waReady = false;
let waState = 'initializing'; // initializing | qr | connecting | open | close

async function startSocket() {
  const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

  sock = makeWASocket({
    auth: state,
    logger: logger.child({ module: 'baileys' }),
    printQRInTerminal: false, // kendi QR'ımızı bastırıyoruz
    browser: Browsers.appropriate('Lastikli Çarşaf Worker'),
    // Daha temiz log için:
    syncFullHistory: false,
    markOnlineOnConnect: false, // kullanıcının "online" status'unu bozmaz
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      waState = 'qr';
      logger.info('📱 QR kod oluşturuldu. WhatsApp uygulamasından tara:');
      qrcode.generate(qr, { small: true });
      console.log('\n   WhatsApp → ⋮ → Bağlı Cihazlar → Cihaz Bağla\n');
    }

    if (connection === 'connecting') {
      waState = 'connecting';
      logger.info('🔄 Bağlanıyor...');
    }

    if (connection === 'open') {
      waReady = true;
      waState = 'open';
      logger.info(`🚀 WhatsApp bağlandı — ${sock.user?.id || 'unknown'}`);
      alertAdmin(`Worker hazır, WhatsApp bağlı. (${sock.user?.id || 'no id'})`);
    }

    if (connection === 'close') {
      waReady = false;
      waState = 'close';
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn({ code, shouldReconnect }, '⚠️ Bağlantı koptu');

      if (shouldReconnect) {
        // Reconnect — pm2'ye gerek yok, içeride deneriz
        setTimeout(() => {
          logger.info('🔄 Yeniden bağlanıyor...');
          startSocket().catch(err => {
            logger.error({ err }, 'Reconnect başarısız, exit ediliyor (pm2 restart edecek)');
            alertAdmin(`Reconnect failed: ${err.message}`);
            process.exit(1);
          });
        }, 3000);
      } else {
        // Logged out — session geçersiz, manuel müdahale gerek
        logger.error('🚫 Hesap logout edildi. Session sil ve QR yeniden tara.');
        alertAdmin('Logout edildi — session silip QR yeniden tarayın.');
        process.exit(1);
      }
    }
  });
}

logger.info('🔄 WhatsApp socket başlatılıyor...');
startSocket().catch(err => {
  logger.error({ err }, 'Initialize hatası');
  alertAdmin(`Initialize error: ${err.message}`);
  process.exit(1);
});

/* ─── Phone helpers ─── */
/**
 * Türk telefon numarasını WhatsApp JID formatına çevir.
 * "0555..." / "+90555..." / "555..." → "905551234567@s.whatsapp.net"
 */
const toWhatsAppJid = (phone) => {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  let normalized;
  if (digits.length === 11 && digits.startsWith('0')) {
    normalized = '90' + digits.substring(1);
  } else if (digits.length === 10 && digits.startsWith('5')) {
    normalized = '90' + digits;
  } else if (digits.length === 12 && digits.startsWith('90')) {
    normalized = digits;
  } else if (digits.length === 13 && digits.startsWith('900')) {
    normalized = '90' + digits.substring(3);
  } else {
    return null;
  }
  if (!/^905\d{9}$/.test(normalized)) return null;
  return `${normalized}@s.whatsapp.net`;
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

/* ─── Send helper ─── */
const sendMessage = async (phone, text) => {
  if (!waReady || !sock) {
    return { ok: false, error: 'WhatsApp henüz hazır değil', state: waState };
  }
  const jid = toWhatsAppJid(phone);
  if (!jid) {
    return { ok: false, error: 'Geçersiz telefon formatı: ' + phone };
  }
  try {
    // Telefon WhatsApp'a kayıtlı mı kontrol et (Baileys onWhatsApp)
    const exists = await sock.onWhatsApp(jid.split('@')[0]);
    if (!exists || !exists[0]?.exists) {
      return { ok: false, error: 'Bu numara WhatsApp\'a kayıtlı değil: ' + phone };
    }
    const result = await sock.sendMessage(jid, { text });
    logger.info({ to: phone, msgId: result.key.id }, '✉️  Mesaj gönderildi');
    return { ok: true, messageId: result.key.id };
  } catch (err) {
    logger.error({ to: phone, err: err.message }, 'Send failed');
    return { ok: false, error: err.message };
  }
};

/* ─── Express API ─── */
const app = express();
app.use(express.json({ limit: '100kb' }));

const requireSecret = (req, res, next) => {
  const got = req.header('X-Worker-Secret') || '';
  if (got !== SECRET) {
    logger.warn({ path: req.path, ip: req.ip }, 'Yetkisiz istek');
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
};

app.get('/status', (req, res) => {
  res.json({
    ok: true,
    state: waState,
    ready: waReady,
    user: sock?.user?.id || null,
    uptime: process.uptime(),
    version: '2.0.0',
    engine: 'baileys',
  });
});

app.post('/notify/order-received', requireSecret, async (req, res) => {
  const { phone, customerName, orderNo, total, sizes } = req.body || {};
  if (!phone || !orderNo) return res.status(400).json({ ok: false, error: 'phone ve orderNo gerekli' });
  const result = await sendMessage(phone, tmpl.orderReceived({ customerName, orderNo, total, sizes }));
  res.status(result.ok ? 200 : 500).json(result);
});

app.post('/notify/cargo-shipped', requireSecret, async (req, res) => {
  const { phone, customerName, orderNo, trackingNumber, trackingUrl } = req.body || {};
  if (!phone || !orderNo || !trackingNumber) return res.status(400).json({ ok: false, error: 'phone, orderNo, trackingNumber gerekli' });
  const result = await sendMessage(phone, tmpl.cargoShipped({ customerName, orderNo, trackingNumber, trackingUrl }));
  res.status(result.ok ? 200 : 500).json(result);
});

app.post('/notify/delivery-tomorrow', requireSecret, async (req, res) => {
  const { phone, customerName, orderNo, trackingNumber } = req.body || {};
  if (!phone || !orderNo) return res.status(400).json({ ok: false, error: 'phone ve orderNo gerekli' });
  const result = await sendMessage(phone, tmpl.deliveryTomorrow({ customerName, orderNo, trackingNumber }));
  res.status(result.ok ? 200 : 500).json(result);
});

app.post('/notify/delivered', requireSecret, async (req, res) => {
  const { phone, customerName, orderNo } = req.body || {};
  if (!phone || !orderNo) return res.status(400).json({ ok: false, error: 'phone ve orderNo gerekli' });
  const result = await sendMessage(phone, tmpl.delivered({ customerName, orderNo }));
  res.status(result.ok ? 200 : 500).json(result);
});

app.post('/notify/raw', requireSecret, async (req, res) => {
  const { phone, message } = req.body || {};
  if (!phone || !message) return res.status(400).json({ ok: false, error: 'phone ve message gerekli' });
  const result = await sendMessage(phone, message);
  res.status(result.ok ? 200 : 500).json(result);
});

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🌐 HTTP listening on :${PORT}`);
});

// Graceful shutdown
const shutdown = async () => {
  logger.info('👋 Kapatılıyor...');
  try { await sock?.end(undefined); } catch { /* ignore */ }
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
