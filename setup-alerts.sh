#!/usr/bin/env bash
#
# DOKAŃCZANIE ALERTÓW — Telegram i e-mail
# =======================================
#
# Po co ten skrypt: żeby włączyć powiadomienia bez ręcznego szukania `chat_id`
# i bez wpisywania sekretów po jednym. Robi trzy rzeczy:
#   1. znajduje Twój chat_id (bot musi mieć od Ciebie wiadomość),
#   2. dopisuje brakujące sekrety do .dev.vars,
#   3. wysyła je do Cloudflare i robi redeploy.
#
# UŻYCIE:
#   ./setup-alerts.sh
#
# Wcześniej:
#   - napisz COKOLWIEK do swojego bota na Telegramie (samo "start" wystarczy),
#   - jeśli chcesz e-mail, wklej klucz API v3 Brevo do .dev.vars (BREVO_API_KEY).

set -euo pipefail
cd "$(dirname "$0")"

GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
ok()   { echo "${GREEN}OK${RESET}  $*"; }
warn() { echo "${YELLOW}UWAGA${RESET} $*"; }
fail() { echo "${RED}BŁĄD${RESET} $*" >&2; exit 1; }

[[ -f .dev.vars ]] || fail "Brak pliku .dev.vars — najpierw go utwórz (wzór w .dev.vars.example)."
[[ -f .cloudflare.env ]] || fail "Brak pliku .cloudflare.env — potrzebny token Cloudflare do wdrożenia."

# Wrangler potrzebuje zapisywalnego HOME — patrz komentarz w setup-cloudflare.sh
if ! mkdir -p "${HOME}/Library/Preferences/.wrangler" 2>/dev/null; then
  export HOME="${TMPDIR:-/tmp}/wrangler-home"
  mkdir -p "$HOME"
fi
export WRANGLER_LOG_PATH="${HOME}/.wrangler-logs"
mkdir -p "$WRANGLER_LOG_PATH" 2>/dev/null || true
set -a; . ./.cloudflare.env; set +a
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID

get_var() { grep -E "^$1=" .dev.vars 2>/dev/null | head -1 | cut -d= -f2- || true; }
set_var() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" .dev.vars; then
    # sed z separatorem | — wartości mogą zawierać / i &
    python3 - "$key" "$value" <<'PY'
import pathlib, re, sys
key, value = sys.argv[1], sys.argv[2]
p = pathlib.Path('.dev.vars'); s = p.read_text()
s = re.sub(rf'^{re.escape(key)}=.*$', f'{key}={value}', s, flags=re.M)
p.write_text(s)
PY
  else
    printf '%s=%s\n' "$key" "$value" >> .dev.vars
  fi
}

echo "${BOLD}=== 1. TELEGRAM ===${RESET}"
TOKEN="$(get_var TELEGRAM_BOT_TOKEN)"
if [[ -z "$TOKEN" ]]; then
  fail "Brak TELEGRAM_BOT_TOKEN w .dev.vars.
Token dostaniesz od @BotFather:
  1. napisz do @BotFather -> /newbot
  2. podaj nazwę i username bota (username musi kończyć się na 'bot')
  3. wklej token tutaj:  sed -i '' 's|^TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=TWOJ_TOKEN|' .dev.vars"
fi

me=$(curl -s --max-time 20 "https://api.telegram.org/bot${TOKEN}/getMe")
if ! echo "$me" | grep -q '"ok":true'; then
  fail "Token bota jest nieprawidłowy. Odpowiedź Telegrama: $(echo "$me" | head -c 200)"
fi
botname=$(echo "$me" | python3 -c "import json,sys; print(json.load(sys.stdin)['result'].get('username','?'))")
ok "Bot działa: @${botname}"

chat_id="$(get_var TELEGRAM_CHAT_ID)"
if [[ -z "$chat_id" ]]; then
  echo
  warn "Nie mam jeszcze Twojego chat_id."
  echo "   Otwórz Telegrama i napisz COKOLWIEK do @${botname} (np. \"start\")."
  echo
  for attempt in 1 2 3 4 5 6; do
    printf "   Sprawdzam... (próba %d/6) " "$attempt"
    updates=$(curl -s --max-time 20 "https://api.telegram.org/bot${TOKEN}/getUpdates")
    chat_id=$(echo "$updates" | python3 -c "
import json,sys
try:
    d=json.load(sys.stdin)
    for u in d.get('result',[]):
        m = u.get('message') or u.get('edited_message') or u.get('channel_post') or {}
        ch = m.get('chat') or {}
        if ch.get('id'): print(ch['id']); break
except Exception: pass
" 2>/dev/null || true)
    if [[ -n "$chat_id" ]]; then echo "znaleziony: ${chat_id}"; break; fi
    echo "brak wiadomości"
    [[ $attempt -lt 6 ]] && sleep 10
  done
fi

if [[ -z "$chat_id" ]]; then
  fail "Nie znalazłem chat_id. Upewnij się, że napisałeś do @${botname} (nie do innego bota),
a potem uruchom skrypt ponownie. Możesz też wpisać chat_id ręcznie:
  https://api.telegram.org/bot${TOKEN}/getUpdates  ->  szukaj \"chat\":{\"id\":...}"
fi
set_var TELEGRAM_CHAT_ID "$chat_id"
ok "TELEGRAM_CHAT_ID zapisany: ${chat_id}"

echo
echo "${BOLD}=== 2. E-MAIL (opcjonalnie) ===${RESET}"
brevo="$(get_var BREVO_API_KEY)"
if [[ -z "$brevo" ]]; then
  warn "Brak BREVO_API_KEY — alerty e-mail będą pominięte, Telegram zadziała.
   Klucz API v3 (zaczyna się od 'xkeysib-') pobierzesz z:
     https://app.brevo.com/settings/keys/api   (zakładka API Keys, NIE SMTP)
   Wklej go do .dev.vars jako BREVO_API_KEY i uruchom skrypt ponownie."
else
  case "$brevo" in
    xsmtpsib-*) fail "BREVO_API_KEY to klucz SMTP (xsmtpsib-...), a API v3 wymaga klucza 'xkeysib-...'.
Wejdź na https://app.brevo.com/settings/keys/api -> zakładka API Keys." ;;
  esac
  to="$(get_var ALERT_EMAIL_TO)"; from="$(get_var ALERT_EMAIL_FROM)"
  [[ -n "$to" ]] && [[ -n "$from" ]] || warn "Uzupełnij ALERT_EMAIL_TO i ALERT_EMAIL_FROM w .dev.vars, inaczej e-mail nie wyjdzie."
  ok "Klucz Brevo wygląda poprawnie"
fi

echo
echo "${BOLD}=== 3. WDRAŻAM SEKRETY ===${RESET}"
npx wrangler secret bulk .dev.vars >/dev/null 2>&1 && ok "Sekrety wgrane do Cloudflare"
npx wrangler deploy 2>&1 | grep -E "Uploaded|Deployed" || fail "Deploy nie powiódł się — sprawdź output powyżej."

echo
echo "${BOLD}=== 4. TEST ALERTU ===${RESET}"
echo "   Uruchamiam skan z wysyłką alertów (1-2 minuty)..."
apikey="$(get_var API_KEY)"
url="https://earnings-iv-scanner.wesleyoptions.workers.dev/scan?alerts=1"
result=$(curl -s --max-time 280 -X POST -H "x-api-key: ${apikey}" "$url" || true)

python3 - "$result" <<'PY' || true
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    print("   Nie udało się odczytać odpowiedzi — sprawdź ręcznie /api/health"); raise SystemExit
al = d.get('alertDispatch') or {}
print(f"   wysłane alerty: {al.get('sent', 0)} | pominięte (już wysłane): {al.get('skipped', 0)}")
for e in (al.get('errors') or [])[:5]:
    print("   BŁĄD:", e[:160])
if al.get('sent', 0) == 0 and not al.get('errors'):
    print("   (brak nowych alertów — wszystko już wysłane wcześniej albo brak kandydatów)")
PY

echo
ok "${BOLD}GOTOWE${RESET}"
echo "   Sprawdź Telegrama — powinien przyjść alert dla najlepszego kandydata."
echo "   Diagnostyka: curl -s https://earnings-iv-scanner.wesleyoptions.workers.dev/api/health"
