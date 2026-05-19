# Lastikli Çarşaf — WhatsApp Worker

Sipariş bildirimi için WhatsApp Web köprüsü. PHP backend'den webhook alır, `whatsapp-web.js` ile müşteriye mesaj gönderir.

## Mimari

```
PHP backend (lastiklicarsaf.tr)
        ↓ HTTP POST + X-Worker-Secret
Node.js worker (Oracle Cloud VM)
        ↓ whatsapp-web.js (puppeteer + Chrome)
WhatsApp Web → müşteri telefonu
```

## Endpoint'ler

| Method | Path | Açıklama |
|---|---|---|
| GET | `/status` | Bağlantı durumu, ready/qr/disconnected |
| POST | `/notify/order-received` | `{phone, customerName, orderNo, total, sizes}` |
| POST | `/notify/cargo-shipped` | `{phone, customerName, orderNo, trackingNumber, trackingUrl}` |
| POST | `/notify/delivery-tomorrow` | `{phone, customerName, orderNo, trackingNumber}` |
| POST | `/notify/delivered` | `{phone, customerName, orderNo}` |
| POST | `/notify/raw` | `{phone, message}` — test/manual |

Tüm POST endpoint'leri için `X-Worker-Secret: <WORKER_SECRET>` header zorunludur.

## VM Kurulum

```bash
# Ubuntu 22.04 ARM64 / x86 — fark etmez
sudo apt update && sudo apt install -y curl git chromium-browser

# Node 20 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Repo
git clone https://github.com/<USER>/lastikli-whatsapp-worker.git
cd lastikli-whatsapp-worker
npm install

# Config
cp .env.example .env
nano .env   # WORKER_SECRET'ı openssl rand -base64 32 ile üret

# Test çalıştır (ilk seferde QR çıkar)
node server.js
# WhatsApp → Bağlı Cihazlar → Cihaz Bağla → QR'ı tara

# Production: pm2 ile daemon
sudo npm install -g pm2
pm2 start server.js --name lastikli-whatsapp-worker
pm2 save
pm2 startup   # boot sırasında otomatik başlat
```

## Güvenlik

- Worker port'u (3000) **public IP'ye açık** — sadece `WORKER_SECRET` header'ı geçen istekler kabul ediliyor
- Secret en az 32 karakter rastgele olmalı: `openssl rand -base64 32`
- `.env` ve `session/` git'e gitmemeli (gitignore'da)
- WhatsApp session `session/` klasöründe — VM disk şifrelemesi varsa daha iyi

## Restart davranışı

WhatsApp koptuğunda worker self-terminate eder (pm2 yeniden başlatır). Session disk'te kayıtlı olduğundan QR tekrar gerekmez. Sadece **ilk kurulumda** QR tarar.

## Debug

```bash
pm2 logs lastikli-whatsapp-worker         # canlı log
pm2 logs lastikli-whatsapp-worker --lines 100
pm2 restart lastikli-whatsapp-worker      # restart
curl http://localhost:3000/status         # durum kontrol
```

## Mesaj template'leri

Mesajları özelleştirmek için `server.js` içindeki `tmpl` objesini düzenle, sonra `pm2 restart`.

## Telefon format

Türkiye numarası beklenir:
- `0555 123 45 67` → otomatik temizlenir
- `+90 555 123 45 67` → otomatik temizlenir
- `905551234567` → direkt kullanılır

WhatsApp'a kayıtlı olmayan numara için `404 Not registered` döner — PHP tarafında bunu sessizce geçmek mantıklı (SMS fallback).
