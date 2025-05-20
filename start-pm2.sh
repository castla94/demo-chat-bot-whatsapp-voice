#!/bin/bash

BOT_NAME=$1 # el primer argumento recibido

if [ -z "$BOT_NAME" ]; then
  echo "❌ Debes pasar el nombre del bot como argumento"
  exit 1
fi

echo "🚀 Iniciando bot con nombre: $BOT_NAME"

pm2 delete "$BOT_NAME" || true
pm2 start app.js --name="$BOT_NAME" --max-memory-restart=3G
