# Lastikli Çarşaf — WhatsApp Worker (Baileys)

Sipariş bildirimi için WhatsApp Web köprüsü. PHP backend'den webhook alır, Baileys ile müşteriye mesaj gönderir.

**v2.0:** Chromium gerek **YOK**. Termux/Android, ARM Linux ve düşük bellekli VPS'lerde sorunsuz çalışır.

## Mimari

```
PHP backend (lastiklicarsaf.tr)
        ↓ HTTP POST + X-Worker-Secret
Node.js worker (Termux'ta veya VPS'te)
        ↓ Baileys (WhatsApp Web protokolü, native)
WhatsApp → müşteri telefonu
```

## Endpoint'ler

| Method | Path | Açıklama |
|---|---|---|
| GET | `/status` | Bağlantı durumu (initializing / qr / connecting / open / close) |
| POST | `/notify/order-received` | `{phone, customerName, orderNo, total, sizes}` |
| POST | `/notify/cargo-shipped` | `{phone, customerName, orderNo, trackingNumber, trackingUrl}` |
| POST | `/notify/delivery-tomorrow` | `{phone, customerName, orderNo, trackingNumber}` |
| POST | `/notify/delivered` | `{phone, customerName, orderNo}` |
| POST | `/notify/raw` | `{phone, message}` — manuel test |

Tüm POST endpoint'leri için `X-Worker-Secret: <WORKER_SECRET>` header zorunludur.

## 📱 Termux (Android) Kurulum

Bu rehber Xiaomi Redmi 13C gibi orta seviye Android için yazıldı. Diğer cihazlarda da çalışır.

### 1. Termux uygulamasını yükle

**ÖNEMLİ:** Play Store'daki Termux **eski ve çalışmıyor**. F-Droid'den yükle:

1. https://f-droid.org/F-Droid.apk → indir, kur (bilinmeyen kaynaklara izin ver)
2. F-Droid aç → ara: **"Termux"** → yükle
3. Termux'u aç

### 2. Termux paket kurulumu

Termux'ta şu komutları sırayla çalıştır (her satırı tek tek, Enter):

```bash
# Paket listesini güncelle (5-10 dk sürebilir)
pkg update -y && pkg upgrade -y

# Gereken paketler
pkg install nodejs git nano openssl -y

# (Opsiyonel) cloudflared — sonra Cloudflare Tunnel için
pkg install cloudflared -y
```

### 3. Storage izni

Worker session'ını Android storage'ında saklayabilmek için:

```bash
termux-setup-storage
```

Açılan diyaloga **"İzin Ver"** de.

### 4. Worker'ı klonla + kur

```bash
cd ~
git clone https://github.com/talhakaranfill/lastikli-whatsapp-worker.git
cd lastikli-whatsapp-worker
npm install
```

`npm install` ~3-5 dk sürer (Baileys + pino + express indirir).

### 5. .env config

```bash
cp .env.example .env
nano .env
```

İçeride `WORKER_SECRET` satırını bul ve değeri rastgele bir string yap:

```bash
# Termux'ta rastgele secret üret:
openssl rand -base64 32
```

Çıktıyı kopyala, `.env`'deki `WORKER_SECRET=` satırına yapıştır. Kaydet (Ctrl+O, Enter, Ctrl+X).

### 6. İlk çalıştırma + QR scan

```bash
node server.js
```

Terminal'de **QR kod** çıkar (büyük kare patern). WhatsApp uygulamasında:

1. **⋮** (sağ üst, 3 nokta) → **Bağlı cihazlar**
2. **Cihaz bağla** butonu
3. Telefonun kamerasını terminal'deki QR'a tut → 1-2 saniyede bağlanır
4. Terminal: `🚀 WhatsApp bağlandı` yazısı görünür

**Worker artık çalışıyor.** Ctrl+C ile durdurma — sonraki adımda daemon yapacağız.

### 7. PM2 ile arka planda çalıştır

```bash
npm install -g pm2
pm2 start server.js --name lastikli-wa
pm2 save
pm2 startup    # boot'ta otomatik başlatma talimatı verir
```

Komutlar:
```bash
pm2 status                # çalışıyor mu kontrol
pm2 logs lastikli-wa      # canlı log
pm2 restart lastikli-wa   # yeniden başlat
pm2 stop lastikli-wa      # durdur
```

### 8. Xiaomi MIUI ayarları ⚠️ KRİTİK

MIUI'nin pil tasarrufu Termux'ı **kapatır** ekran kapandıktan dakikalar sonra. Bu ayarlar **zorunlu**:

1. **Ayarlar → Uygulamalar → Tüm Uygulamalar → Termux**
   - **Pil tasarrufu** → "Kısıtlama yok" (No restrictions)
   - **Otomatik başlatma** → AÇ
   - **Diğer izinler** → "Arka planda çalışmasına izin ver" → AÇ
   - **Bildirimler** → AÇ (durum bildirimi için)

2. **Son uygulamalar ekranı**:
   - Termux'ı aç → son uygulamalardan açıkken **aşağı çek** → kilit ikonuna bas (uygulamayı kilitle)
   - Bu sayede "tümünü temizle" Termux'u kapatmaz

3. **Battery Optimizer** uygulamasını **devre dışı bırak** Termux için (Ayarlar → Pil → Pil tasarrufu → Termux → Kısıtlama yok)

### 9. Termux'ı arka planda canlı tut

Termux'un "wake lock" özelliği var — ekran kapansa bile Node.js çalışır. Termux bildiriminden **"Acquire wake lock"** butonuna bas (status bar bildiriminde görünür).

Veya komut ile:
```bash
termux-wake-lock
```

Bu olmadan ekran kapanır kapanmaz Termux duraklatılır.

### 10. Cloudflare Tunnel — dışarı açma

Telefonun IP'si dinamik + ev WiFi'sinde NAT arkasında. PHP backend doğrudan ulaşamaz. Çözüm: Cloudflare Tunnel ücretsiz public URL verir.

Detaylı [tunnel kurulumu için BURAYA bak](#cloudflare-tunnel-kurulumu) (aşağıda).

---

## 🌐 Cloudflare Tunnel Kurulumu

### 1. Cloudflare hesabı

https://dash.cloudflare.com/sign-up → ücretsiz hesap (e-posta + parola).

### 2. Tunnel oluştur

1. Cloudflare dashboard → sol menüden **Zero Trust** → Networks → **Tunnels**
2. **Create a tunnel** → **Cloudflared** seç → Next
3. Tunnel adı: `lastikli-wa-worker` → Save
4. Sonraki ekranda **Token** kopyala (uzun bir string)

### 3. Termux'ta tunnel başlat

```bash
# Cloudflared zaten kurulu (yukarıdan)
cloudflared tunnel run --token <KOPYALADIĞIN_TOKEN>
```

İlk çalışmada Cloudflare'a bağlanır, "Connected" mesajı görmelisin.

### 4. Public hostname bağla

Cloudflare dashboard'da tunnel'in **Public Hostnames** sekmesi:
- **Subdomain:** `wa-worker` (örnek)
- **Domain:** lastiklicarsaf.tr (Cloudflare'da varsa) veya `*.trycloudflare.com` (alt domain ücretsiz subdomain)
- **Type:** HTTP
- **URL:** `localhost:3000`

→ Save

Şimdi `https://wa-worker.lastiklicarsaf.tr/status` (veya `https://lastikli-wa.trycloudflare.com/status`) gibi bir URL var. Her yerden erişilebilir.

### 5. Tunnel'ı PM2 ile arka plana al

```bash
pm2 start --name cf-tunnel "cloudflared tunnel run --token <TOKEN>"
pm2 save
```

Artık telefon yeniden başlasa bile worker + tunnel ikisi de otomatik kalkar.

---

## 🔒 Güvenlik

- Worker port (3000) **public URL'ye açık** ama sadece `WORKER_SECRET` header geçen istekler kabul edilir
- Secret en az 32 karakter rastgele olmalı (`openssl rand -base64 32`)
- `.env` ve `session/` git'e gitmemeli (gitignore'da)
- WhatsApp session telefon disk'inde — telefon kaybedersen sessio'a erişimi olan kötü niyetli kişi WhatsApp Web'ine giriş yapabilir. Telefonun ekran kilidi güçlü olmalı.

## 🔍 Debug

```bash
pm2 logs lastikli-wa --lines 100   # son 100 satır log
pm2 logs lastikli-wa                # canlı log akışı
curl http://localhost:3000/status  # local durum
curl https://wa-worker.lastiklicarsaf.tr/status  # public URL
pm2 restart lastikli-wa             # restart
```

Sorunlar:
- **"WhatsApp henüz hazır değil"** → `pm2 logs` → QR scan edildi mi kontrol, edilmediyse session sil + yeniden başlat
- **Tunnel kopuyor** → Cloudflare logs'a bak, tunnel restart et
- **Telefon uyuduktan sonra kopuyor** → MIUI ayarlarını tekrar kontrol et, `termux-wake-lock` çalıştır

## Telefon format

Türkiye numarası beklenir:
- `0555 123 45 67` → otomatik temizlenir
- `+90 555 123 45 67` → otomatik temizlenir
- `905551234567` → direkt kullanılır

WhatsApp'a kayıtlı olmayan numara için anlamlı hata döner.
