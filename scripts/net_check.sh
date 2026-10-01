#!/usr/bin/env bash
# Computer Use süreçleri çağrı sırasında internete çıkıyor mu? 10 sn boyunca lsof ile izler.
# Başka bir terminalde bu sırada bir get_app_state çağrısı yap (Claude veya scripts/bench.py).
set -u
PIDS=$(pgrep -f "SkyComputerUseClient mcp|SkyComputerUseService|codex sandbox" | tr '\n' ',' | sed 's/,$//')
[ -n "$PIDS" ] || { echo "Computer Use süreci bulunamadı (bir çağrı başlat)"; exit 1; }
echo "izlenen pid'ler: $PIDS"
echo "unix soketler:"; lsof -nP -a -U -p "$PIDS" 2>/dev/null | awk 'NR>1{print "  "$NF}' | sort -u
echo "10 sn TCP izleme..."
out=$(for i in $(seq 1 20); do lsof -nP -i -a -p "$PIDS" 2>/dev/null | tail -n +2; sleep 0.5; done | sort -u)
if [ -z "$out" ]; then echo "SONUÇ: hiç TCP bağlantısı yok (model çağrısı yok)"; else echo "TCP bağlantıları:"; echo "$out"; fi
