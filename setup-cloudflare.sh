#!/usr/bin/env bash
#
# KONFIGURACJA CLOUDFLARE — JEDNYM POLECENIEM
# ==========================================
#
# Co robi:
#   1. sprawdza, czy jesteś zalogowany do Cloudflare (wrangler login),
#   2. tworzy namespace KV o nazwie STATE (jeśli jeszcze nie istnieje),
#   3. wpisuje jego ID do wrangler.toml (odkomentowuje binding),
#   4. wgrywa sekrety z pliku .dev.vars do Cloudflare,
#   5. robi deploy Workera.
#
# UŻYCIE:
#   1. Utwórz plik .dev.vars w tym katalogu (jest w .gitignore — NIE trafi do GitHuba):
#
#        FINNHUB_API_KEY=twoj_klucz
#        TRADIER_API_KEY=twoj_klucz
#        API_KEY=dlugi_losowy_ciag
#        TELEGRAM_BOT_TOKEN=123:ABC        # opcjonalnie
#        TELEGRAM_CHAT_ID=-100123          # opcjonalnie
#        RESEND_API_KEY=re_xxx             # opcjonalnie
#
#   2. Uruchom:
#
#        ./setup-cloudflare.sh
#
# Skrypt można uruchamiać wielokrotnie — jest idempotentny (nie tworzy
# drugiego namespace'u, nie nadpisuje już wpisanego ID, sekrety nadpisuje
# nowymi wartościami).

set -euo pipefail

cd "$(dirname "$0")"

# Wrangler domyślnie pisze logi do katalogu w $HOME. Jeśli ten katalog jest
# niedostępny (sandbox, restrykcyjne uprawnienia), wrangler kończy się błędem
# EPERM i przerywa działanie. Jawne wskazanie /tmp usuwa ten problem —
# potwierdzone testem: bez tej linii exit code bywa niezerowy mimo udanego builda.
export WRANGLER_LOG_PATH="${WRANGLER_LOG_PATH:-/tmp/wrangler-logs}"
export WRANGLER_SEND_METRICS=false

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
info() { echo "${BOLD}==>${RESET} $*"; }
ok()   { echo "${GREEN}OK${RESET}  $*"; }
warn() { echo "${YELLOW}UWAGA${RESET} $*"; }
fail() { echo "${RED}BŁĄD${RESET} $*" >&2; exit 1; }

# ── 0. Wymagania wstępne ─────────────────────────────────────────────────────
[[ -f package.json ]] || fail "Uruchom skrypt z katalogu projektu (brak package.json)."
command -v node >/dev/null 2>&1 || fail "Brak Node.js. Zainstaluj Node 20+."
[[ -d node_modules ]] || { info "Instaluję zależności..."; npm install --no-audit --no-fund; }

# ── 1. Plik z sekretami ──────────────────────────────────────────────────────
if [[ ! -f .dev.vars ]]; then
  # Heredoc w cudzysłowie: bez tego $(...) w komunikacie zostałoby WYKONANE
  # zamiast pokazane jako przykład (błąd, który łatwo przeoczyć).
  read -r -d '' msg <<'KOMUNIKAT' || true

Brak pliku .dev.vars.

Utwórz go w tym katalogu z kluczami API:

  FINNHUB_API_KEY=twoj_klucz_finnhub
  TRADIER_API_KEY=twoj_klucz_tradier
  API_KEY=dowolny_dlugi_losowy_ciag

Losowy API_KEY wygenerujesz tak:
  head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40

Klucze: https://finnhub.io/register  oraz  https://developer.tradier.com/
KOMUNIKAT
  fail "$msg"
fi

required=(FINNHUB_API_KEY TRADIER_API_KEY API_KEY)
missing=()
for key in "${required[@]}"; do
  grep -qE "^${key}=.+" .dev.vars || missing+=("$key")
done
if (( ${#missing[@]} > 0 )); then
  fail "W .dev.vars brakuje wymaganych kluczy: ${missing[*]}"
fi
ok "Plik .dev.vars kompletny (klucze obowiązkowe obecne)"

# Ostrzeżenie o kanałach alertów, które wymagają dodatkowych sekretów
channels=$(grep -E '^ALERT_CHANNELS=' .dev.vars 2>/dev/null | cut -d= -f2- || true)
channels=${channels:-$(grep -E '^ALERT_CHANNELS' wrangler.toml | head -1 | cut -d'"' -f2)}
if [[ "$channels" == *telegram* ]]; then
  grep -qE '^TELEGRAM_BOT_TOKEN=.+' .dev.vars && grep -qE '^TELEGRAM_CHAT_ID=.+' .dev.vars \
    || warn "ALERT_CHANNELS zawiera 'telegram', ale brak TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID w .dev.vars — alerty na Telegram nie zadziałają."
fi
if [[ "$channels" == *email* ]]; then
  grep -qE '^RESEND_API_KEY=.+' .dev.vars \
    || warn "ALERT_CHANNELS zawiera 'email', ale brak RESEND_API_KEY w .dev.vars — alerty e-mail nie zadziałają."
fi

# ── 2. Logowanie do Cloudflare ───────────────────────────────────────────────
info "Sprawdzam logowanie do Cloudflare..."
if ! npx wrangler whoami >/dev/null 2>&1; then
  warn "Nie jesteś zalogowany. Otwieram przeglądarkę do logowania..."
  npx wrangler login
fi
account=$(npx wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1 || true)
[[ -n "$account" ]] && ok "Zalogowany (account: ${account:0:8}...)" || ok "Zalogowany"

# ── 3. Namespace KV ──────────────────────────────────────────────────────────
info "Sprawdzam namespace KV 'STATE'..."
existing_id=$(grep -E '^id = ' wrangler.toml | grep -oE '"[0-9a-f]{32}"' | tr -d '"' | head -1 || true)

if [[ -n "$existing_id" ]]; then
  ok "wrangler.toml ma już wpisane ID namespace'u: ${existing_id:0:8}..."
else
  info "Tworzę namespace KV..."
  kv_output=$(npx wrangler kv namespace create STATE 2>&1) || {
    echo "$kv_output"
    fail "Nie udało się utworzyć namespace'u KV. Jeśli namespace już istnieje, wklej jego ID ręcznie do wrangler.toml (sekcja [[kv_namespaces]])."
  }
  echo "$kv_output"
  # wrangler wypisuje id w formacie: id = "abcdef..." (bywa w bloku TOML)
  new_id=$(echo "$kv_output" | grep -oE '[0-9a-f]{32}' | head -1 || true)
  [[ -n "$new_id" ]] || fail "Nie udało się odczytać ID namespace'u z outputu powyżej. Wklej je ręcznie do wrangler.toml."

  # Odkomentuj binding i wstaw ID — robimy to przez node, żeby nie polegać na sed -i
  node -e "
    const fs = require('fs');
    let toml = fs.readFileSync('wrangler.toml', 'utf8');
    toml = toml.replace(/# \[\[kv_namespaces\]\]/, '[[kv_namespaces]]');
    toml = toml.replace(/# binding = \"STATE\"/, 'binding = \"STATE\"');
    toml = toml.replace(/# id = \"WKLEJ_TUTAJ_ID\"/, 'id = \"${new_id}\"');
    fs.writeFileSync('wrangler.toml', toml);
  "
  ok "ID namespace'u wpisane do wrangler.toml: ${new_id:0:8}..."
fi

grep -qE '^\[\[kv_namespaces\]\]' wrangler.toml || fail "Binding KV nadal zakomentowany w wrangler.toml — odkomentuj sekcję [[kv_namespaces]] ręcznie."

# ── 4. Sekrety ───────────────────────────────────────────────────────────────
info "Wgrywam sekrety z .dev.vars do Cloudflare..."
npx wrangler secret bulk .dev.vars
ok "Sekrety wgrane"

# ── 5. Deploy ────────────────────────────────────────────────────────────────
info "Wdrażam Workera..."
npx wrangler deploy

# ── 6. Podsumowanie ──────────────────────────────────────────────────────────
echo
ok "${BOLD}GOTOWE${RESET}"
cat <<'EOF'

Sprawdź, czy wszystko działa:

  1. Adres swojego Workera znajdziesz w outputcie deployu powyżej
     (linia "Uploaded" / "https://earnings-iv-scanner.<subdomain>.workers.dev").
     Diagnostyka konfiguracji (pole "missing" musi być puste):
       curl <adres>/api/health

  3. Cron wystartuje automatycznie o 11:10 i 21:10 UTC w dni robocze.

  4. Żeby zobaczyć wynik od razu, bez czekania na cron:
       curl -H "x-api-key: <Twoje API_KEY z .dev.vars>" "<adres>/api/scan?refresh=1"
     (trwa 2-4 minuty — to normalne)

  5. Podgląd logów na żywo:
       npx wrangler tail --format pretty

EOF
