#!/bin/bash
# Usage: send_tg.sh <bot_token> <chat_id> <message>
# Called from wb-rules/garage.js; message is passed via $'...' ANSI-C quoting.
TOKEN="$1"
CHAT="$2"
TEXT="$3"

RESPONSE=$(curl -s -w "\n%{http_code}" \
  --max-time 10 \
  -X POST "https://api.telegram.org/bot${TOKEN}/sendMessage" \
  --data-urlencode "chat_id=${CHAT}" \
  --data-urlencode "text=${TEXT}")

CURL_EXIT=$?
HTTP_CODE=$(printf '%s' "$RESPONSE" | tail -n1)
BODY=$(printf '%s' "$RESPONSE" | head -n -1)

if [ "$CURL_EXIT" -ne 0 ]; then
  echo "[TG] Network error: curl exit code ${CURL_EXIT}" >&2
  exit 1
fi

if [ "$HTTP_CODE" -lt 200 ] || [ "$HTTP_CODE" -ge 300 ]; then
  echo "[TG] HTTP ${HTTP_CODE}: ${BODY}" >&2
  exit 1
fi
