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
#   - jeśli chcesz e-mail, wklej klucz API v3 Brevo do .dev.vars (BREVO_API_KEY)
#     oraz ustaw ALERT_EMAIL_TO / ALERT_EMAIL_FROM w wrangler.toml (to konfiguracja,
#     nie sekret — trzymanie ich w obu plikach powoduje odrzucenie przez Cloudflare).

set -euo pipefail
cd "$(dirname "$0")"

GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
ok()   { echo "${GREEN}OK${RESET}  $*"; }
warn() { echo "${YELLOW}UWAGA${RESET} $*"; }
fail() { echo "${RED}BŁĄD${RESET} $*" >&2; exit 1; }

[[ -f .dev.vars ]] || fail "Brak pliku .dev.vars — najpierw go utwórz (wzór w .dev.vars.example)."
[[ -f .cloudflare.env ]] || fail "Brak pliku .cloudflare.env — potrzebny token Cloudflare do wdrożenia."

# Wrangler potrzebuje zapisywalnego HOME — patrz komentarz w setup-cloudflare.sh
# Test musi sprawdzać ZAPIS PLIKU, nie samo mkdir: w środowiskach sandbox
# `mkdir` potrafi się udać, a zapis już nie, przez co wrangler przewraca się
# dopiero przy deployu z mylącym błędem EPERM.
WRANGLER_CFG_DIR="${HOME}/Library/Preferences/.wrangler"
mkdir -p "$WRANGLER_CFG_DIR" 2>/dev/null || true
if ! touch "${WRANGLER_CFG_DIR}/.write-test" 2>/dev/null; then
  export HOME="${TMPDIR:-/tmp}/wrangler-home"
  mkdir -p "$HOME"
else
  rm -f "${WRANGLER_CFG_DIR}/.write-test"
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

# Dostawcę wybiera EMAIL_PROVIDER w .email-config (albo zostaje domyślny z wrangler.toml).
# Resend NIE MA blokady IP, więc jest prostszy, gdy Brevo wymaga autoryzacji adresów IP.
provider=""
if [[ -f .email-config ]]; then
  provider="$(grep -E '^EMAIL_PROVIDER=' .email-config | head -1 | cut -d= -f2- | tr -d ' \r')"
fi
if [[ -z "$provider" ]]; then
  provider="$(grep -E '^EMAIL_PROVIDER' wrangler.toml | head -1 | cut -d'"' -f2)"
fi
provider="${provider:-brevo}"
if [[ "$provider" != "brevo" && "$provider" != "resend" ]]; then
  fail "EMAIL_PROVIDER musi być \"brevo\" albo \"resend\" (jest: \"${provider}\")."
fi
echo "   Dostawca: ${BOLD}${provider}${RESET}"

# Wpisz wybranego dostawcę do wrangler.toml, żeby Worker wiedział, którym kluczem wysyłać.
python3 - "$provider" <<'PYPROV'
import pathlib, re, sys
prov = sys.argv[1]
p = pathlib.Path('wrangler.toml'); s = p.read_text()
p.write_text(re.sub(r'^EMAIL_PROVIDER = .*$', f'EMAIL_PROVIDER = "{prov}"', s, flags=re.M))
PYPROV

if [[ "$provider" == "resend" ]]; then
  # ── RESEND ────────────────────────────────────────────────────────────────
  resend_key="$(get_var RESEND_API_KEY)"
  if [[ -z "$resend_key" ]]; then
    warn "Brak RESEND_API_KEY — alerty e-mail pominięte, Telegram zadziała.
   Klucz: https://resend.com/api-keys -> Create API Key -> uprawnienie \"Sending access\"
   Dopisz do .dev.vars jako RESEND_API_KEY i uruchom skrypt ponownie."
  else
    # WERYFIKACJA KLUCZA — przez endpoint WYSYŁKI, nie przez /domains.
    #
    # Pułapka, na którą się nadziałem: klucz z uprawnieniem "Sending access"
    # (właśnie taki zalecamy, bo minimalny) NIE MA dostępu do GET /domains i to
    # API zwraca na nim 401 z komunikatem "This API key is restricted to only
    # send emails". Traktowanie tego jako błędu klucza było mylące — klucz był
    # poprawny, tylko pytaliśmy go o coś, do czego nie służy.
    #
    # Właściwy test: spróbować wysłać na adres testowy Resenda. API rozróżnia
    # dwie sytuacje i obie są dla nas informatywne:
    #   200        -> klucz działa ORAZ domena nadawcy jest zweryfikowana
    #   403 z "not verified" -> klucz działa, ale domena wymaga weryfikacji
    from_check="$(grep -E '^ALERT_EMAIL_FROM' wrangler.toml | head -1 | cut -d'"' -f2)"
    from_check="${from_check:-onboarding@resend.dev}"
    domena="${from_check##*@}"

    echo "   Sprawdzam klucz i domenę nadawcy (${domena})..."
    http=$(curl -s -o /tmp/resend-send.json -w "%{http_code}" --max-time 20 \
      -X POST https://api.resend.com/emails \
      -H "Authorization: Bearer ${resend_key}" -H "Content-Type: application/json" \
      -d "{\"from\":\"${from_check}\",\"to\":[\"delivered@resend.dev\"],\"subject\":\"Weryfikacja konfiguracji skanera\",\"html\":\"<p>Test konfiguracji. Ten adres należy do Resend i nie trafia do skrzynki.</p>\"}" \
      || echo "000")

    case "$http" in
      200)
        ok "Klucz Resend działa, domena ${domena} zweryfikowana (wysyłka przetestowana)" ;;
      401)
        fail "Resend odrzucił klucz (HTTP 401): $(head -c 150 /tmp/resend-send.json)
Skopiuj CAŁY klucz z https://resend.com/api-keys (pokazuje się tylko raz)." ;;
      403)
        if grep -qi "not verified\|domain" /tmp/resend-send.json 2>/dev/null; then
          warn "Klucz działa, ale domena '${domena}' NIE jest jeszcze zweryfikowana.
     Dodaj ją: https://resend.com/domains -> Add Domain, potem wklej rekordy DNS
     (SPF i DKIM) u rejestratora domeny i poczekaj na status Verified.
     Odpowiedź Resenda: $(head -c 150 /tmp/resend-send.json)"
        else
          warn "Resend zwróciło 403: $(head -c 150 /tmp/resend-send.json)"
        fi ;;
      422)
        warn "Resend odrzucił nadawcę '${from_check}' jako nieprawidłowy (HTTP 422).
     Sprawdź, czy adres w ALERT_EMAIL_FROM należy do zweryfikowanej domeny." ;;
      000) warn "Nie udało się połączyć z Resend — sprawdzę przy wysyłce alertu." ;;
      *) warn "Resend odpowiedziało HTTP ${http}: $(head -c 150 /tmp/resend-send.json)" ;;
    esac
  fi

else
  # ── BREVO ────────────────────────────────────────────────────────────────
  brevo="$(get_var BREVO_API_KEY)"
  if [[ -z "$brevo" ]]; then
    warn "Brak BREVO_API_KEY — alerty e-mail pominięte, Telegram zadziała.
   Klucz API v3 (prefiks xkeysib-): https://app.brevo.com/settings/keys/api
   UWAGA: zakładka \"API Keys\", NIE \"SMTP\"."
  else
    case "$brevo" in
      xsmtpsib-*) fail "BREVO_API_KEY to klucz SMTP (xsmtpsib-...), a API v3 wymaga klucza xkeysib-....\nWejdź na https://app.brevo.com/settings/keys/api -> zakładka API Keys. Klucz SMTP służy\ndo klienta pocztowego — Cloudflare Workers nie umie wysyłać po SMTP." ;;
    esac

    echo "   Sprawdzam klucz u Brevo..."
    http=$(curl -s -o /tmp/brevo-check.json -w "%{http_code}" --max-time 20 \
      -H "api-key: ${brevo}" https://api.brevo.com/v3/account || echo "000")
    case "$http" in
      200) ok "Klucz Brevo działa" ;;
      401) fail "Brevo odrzucił klucz (HTTP 401: $(head -c 120 /tmp/brevo-check.json)).
Sprawdź, czy skopiowałeś CAŁY klucz z zakładki API Keys." ;;
      000) warn "Nie udało się połączyć z Brevo — sprawdzę przy wysyłce alertu." ;;
      *) warn "Brevo odpowiedziało HTTP ${http} przy sprawdzaniu klucza." ;;
    esac

    from_check="$(grep -E '^ALERT_EMAIL_FROM' wrangler.toml | head -1 | cut -d'"' -f2)"
    if [[ -n "$from_check" && "$from_check" != *twojadomena* ]]; then
      curl -s --max-time 20 -H "api-key: ${brevo}" "https://api.brevo.com/v3/senders" -o /tmp/brevo-senders.json || true
      if python3 -c "
import json,sys
try:
    d=json.load(open('/tmp/brevo-senders.json'))
    aktyw=[s['email'].lower() for s in (d.get('senders') or []) if s.get('active')]
    sys.exit(0 if '$from_check'.lower() in aktyw else 1)
except Exception:
    sys.exit(2)
" 2>/dev/null; then
        ok "Nadawca ${from_check} zweryfikowany w Brevo"
      else
        warn "Nadawca '${from_check}' NIE wygląda na zweryfikowanego.
     Dodaj: https://app.brevo.com/senders -> Add a sender (potwierdź link z maila)."
      fi
    fi
  fi
fi

# ── Adresy nadawcy i odbiorcy (wspólne dla obu dostawców) ───────────────────
if [[ -f .email-config ]]; then
  cfg_to="$(grep -E '^ALERT_EMAIL_TO=' .email-config | head -1 | cut -d= -f2- | tr -d ' \r')"
  cfg_from="$(grep -E '^ALERT_EMAIL_FROM=' .email-config | head -1 | cut -d= -f2- | tr -d ' \r')"
  if [[ -n "$cfg_to" ]]; then
    python3 - "$cfg_to" "$cfg_from" <<'PYCFG'
import pathlib, re, sys
to, frm = sys.argv[1], sys.argv[2]
p = pathlib.Path('wrangler.toml'); s = p.read_text()
s = re.sub(r'^ALERT_EMAIL_TO = .*$', f'ALERT_EMAIL_TO = "{to}"', s, flags=re.M)
if frm:
    s = re.sub(r'^ALERT_EMAIL_FROM = .*$', f'ALERT_EMAIL_FROM = "{frm}"', s, flags=re.M)
p.write_text(s)
PYCFG
    ok "Adresy wpisane do wrangler.toml z .email-config"
  fi
fi

to="$(grep -E '^ALERT_EMAIL_TO' wrangler.toml | head -1 | cut -d'"' -f2)"
from="$(grep -E '^ALERT_EMAIL_FROM' wrangler.toml | head -1 | cut -d'"' -f2)"
if [[ -z "$to" ]]; then
  warn "Brak odbiorcy alertów. Ustaw ALERT_EMAIL_TO w .email-config:"
  echo "       echo 'ALERT_EMAIL_TO=twoj@email.pl' >> .email-config"
elif [[ -z "$from" || "$from" == *twojadomena* ]]; then
  warn "ALERT_EMAIL_FROM to placeholder '${from}' — ustaw zweryfikowanego nadawcę w .email-config."
else
  ok "E-mail: z ${from} na ${to}"
fi


echo
echo "${BOLD}=== 3. WDRAŻAM SEKRETY ===${RESET}"

# KOLIZJA NAZW: Cloudflare odrzuca sekret, którego nazwa jest już zajęta przez
# zmienną z wrangler.toml, i przerywa CAŁY secret bulk — czyli żaden sekret nie
# dojdzie. Sprawdzamy to PRZED wysyłką, bo komunikat z API jest mylący
# ("Binding name already in use"), a skutek wygląda jak cicha awaria.
collisions=$(comm -12 \
  <(grep -oE '^[A-Z_]+ =' wrangler.toml | tr -d ' =' | sort -u) \
  <(grep -oE '^[A-Z_]+=' .dev.vars | tr -d '=' | sort -u) || true)
if [[ -n "$collisions" ]]; then
  warn "Te nazwy są w OBU plikach i Cloudflare je odrzuci:"
  echo "$collisions" | sed 's/^/       /'
  echo "     Usuwam je z .dev.vars — konfiguracja należy do wrangler.toml."
  while read -r key; do
    [[ -n "$key" ]] || continue
    python3 - "$key" <<'PYCOLL'
import pathlib, re, sys
key = sys.argv[1]
p = pathlib.Path('.dev.vars'); s = p.read_text()
p.write_text(re.sub(rf'^{re.escape(key)}=.*\n?', '', s, flags=re.M))
PYCOLL
  done <<< "$collisions"
fi

sec_out=$(npx wrangler secret bulk .dev.vars 2>&1)
if echo "$sec_out" | grep -q "Successfully created"; then
  ok "Sekrety wgrane: $(echo "$sec_out" | grep -c 'Successfully created')"
elif echo "$sec_out" | grep -qE "failed|ERROR"; then
  echo "$sec_out" | grep -E "ERROR|already in use|failed" | head -5
  fail "Nie udało się wgrać sekretów (szczegóły powyżej)"
else
  ok "Sekrety zaktualizowane"
fi
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
