pm2 stop whatsapp-demo

SOURCE_FILE="bot_sessions/baileys_store.json"
YEAR_SERVER=$(date +"%Y") 
MONTH_SERVER=$(date +"%m") 
DEST_DIR="sessions_history/$YEAR_SERVER/$MONTH_SERVER"
DEST_FILE="$DEST_DIR/baileys_store.json"

if [ -f "$SOURCE_FILE" ]; then
    mkdir -p "$DEST_DIR"

    cp "$SOURCE_FILE" "$DEST_FILE"

    if [ $? -eq 0 ]; then
        echo "Archivo copiado exitosamente a $DEST_FILE"
    else
        echo "Error al copiar el archivo."
    fi
else
    echo "El archivo $SOURCE_FILE no existe."
fi

rm -rf "$DEST_FILE"

pm2 start whatsapp-demo --max-memory-restart 1536M
