#!/data/data/com.termux/files/usr/bin/bash
# Lastikli Çarşaf WhatsApp Worker — Termux otomatik kurulum
#
# Kullanım (Termux'ta tek satır):
#   curl -fsSL https://raw.githubusercontent.com/talhakaranfill/lastikli-whatsapp-worker/main/install.sh | bash
#
# Yaptıkları:
#   1. Termux paketleri (nodejs, git, openssl, cloudflared)
#   2. Storage izni
#   3. Worker repo clone / pull
#   4. npm install
#   5. .env otomatik oluştur + WORKER_SECRET üret
#   6. Worker'ı başlatma talimatı yazdır

set -e

# Renkler
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print() { echo -e "${BLUE}▶${NC} $1"; }
ok()    { echo -e "${GREEN}✓${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠${NC} $1"; }
err()   { echo -e "${RED}✗${NC} $1"; }

# Termux mı kontrol et
if [ ! -d "/data/data/com.termux" ]; then
  err "Bu script SADECE Termux içinde çalışır. Termux uygulamasından çalıştır."
  exit 1
fi

echo ""
echo "════════════════════════════════════════════════"
echo "  Lastikli Çarşaf WhatsApp Worker — Setup"
echo "════════════════════════════════════════════════"
echo ""

# 1. Paket güncellemesi
print "Termux paketleri güncelleniyor (5-10 dk sürebilir, sabırlı ol)..."
pkg update -y > /dev/null 2>&1
pkg upgrade -y > /dev/null 2>&1
ok "Paketler güncel"

# 2. Gerekli paketler
print "Node.js, git, openssl, cloudflared kuruluyor..."
pkg install -y nodejs git nano openssl-tool cloudflared > /dev/null 2>&1
ok "Paketler kuruldu"

# Node version check
NODE_V=$(node --version 2>/dev/null || echo "yok")
print "Node sürümü: $NODE_V"

# 3. Storage izni (dialog çıkar, kullanıcı kabul etmeli)
print "Storage izni isteniyor (ekranda 'İzin Ver' diyaloguna kabul et)..."
termux-setup-storage 2>/dev/null || true
sleep 2
ok "Storage izni alındı"

# 4. Repo
cd ~
if [ -d "lastikli-whatsapp-worker" ]; then
  print "Mevcut repo bulundu, güncelleniyor..."
  cd lastikli-whatsapp-worker
  git pull --rebase --quiet
  ok "Repo güncel"
else
  print "Worker repo klonlanıyor..."
  git clone --quiet https://github.com/talhakaranfill/lastikli-whatsapp-worker.git
  cd lastikli-whatsapp-worker
  ok "Repo indirildi"
fi

# 5. npm install
print "Npm paketleri kuruluyor (3-5 dk sürebilir)..."
npm install --silent --no-audit --no-fund > /dev/null 2>&1
ok "Npm paketleri kuruldu"

# 6. .env config
if [ ! -f ".env" ]; then
  cp .env.example .env
  SECRET=$(openssl rand -base64 32)
  # macOS-style sed uyumlu (Termux BSD sed kullanır)
  sed -i "s|WORKER_SECRET=.*|WORKER_SECRET=$SECRET|" .env
  ok ".env oluşturuldu, WORKER_SECRET üretildi"
else
  warn ".env zaten var, dokunmadım"
fi

echo ""
echo "════════════════════════════════════════════════"
echo -e "  ${GREEN}✓ Kurulum tamamlandı!${NC}"
echo "════════════════════════════════════════════════"
echo ""
echo "Şimdi WhatsApp'ı bağlamak için worker'ı başlat:"
echo ""
echo -e "  ${YELLOW}cd ~/lastikli-whatsapp-worker${NC}"
echo -e "  ${YELLOW}node server.js${NC}"
echo ""
echo "Terminal'de QR kod çıkacak. WhatsApp uygulamasında:"
echo "  ⋮ → Bağlı cihazlar → Cihaz bağla → QR'ı tara"
echo ""
echo "Bağlandıktan sonra Ctrl+C ile durdur, sonraki adıma geç."
echo ""

# WORKER_SECRET'ı bastır ki kullanıcı bana yapıştırabilsin (PHP backend için)
if [ -f .env ]; then
  SECRET=$(grep '^WORKER_SECRET=' .env | cut -d'=' -f2-)
  echo "════════════════════════════════════════════════"
  echo "  WORKER_SECRET (PHP backend'e gireceğiz):"
  echo "════════════════════════════════════════════════"
  echo ""
  echo "  $SECRET"
  echo ""
  echo "Bu string'i bana ilet (sonra PHP'ye eklerken kullanacağım)."
  echo "════════════════════════════════════════════════"
fi
