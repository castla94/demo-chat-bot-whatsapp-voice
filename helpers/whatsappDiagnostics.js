// No registra contenido, credenciales ni números de los contactos.
export const attachWhatsappDiagnostics = (provider, logger) => {
    let activeSocket;
    const onConnection = (update) => {
        if (!update.connection) return;
        const error = update.lastDisconnect?.error;
        const metadata = {
            action: 'whatsapp_connection_update',
            connection: update.connection,
            statusCode: error?.output?.statusCode,
            reason: error?.message,
        };
        logger[update.connection === 'close' ? 'warn' : 'info']('Estado de conexión WhatsApp', metadata);
    };
    const onMessages = ({ messages = [], type }) => {
        for (const message of messages) {
            if (message?.key?.fromMe) continue;
            const hasPayload = Boolean(message?.message && Object.keys(message.message).length);
            logger[hasPayload ? 'info' : 'warn']('Evento de mensaje WhatsApp recibido', {
                action: 'whatsapp_raw_message',
                messageId: message?.key?.id,
                upsertType: type,
                hasPayload,
                messageTypes: Object.keys(message?.message || {}),
                stubType: message?.messageStubType,
            });
        }
    };
    const detach = () => {
        const events = activeSocket?.ev;
        const off = events?.off ?? events?.removeListener;
        off?.call(events, 'connection.update', onConnection);
        off?.call(events, 'messages.upsert', onMessages);
    };
    const register = () => {
        const socket = provider.vendor ?? provider.sock ?? provider.instance?.sock;
        if (!socket?.ev?.on || socket === activeSocket) return;
        detach();
        activeSocket = socket;
        socket.ev.on('connection.update', onConnection);
        socket.ev.on('messages.upsert', onMessages);
        logger.info('Diagnóstico conectado al socket WhatsApp', { action: 'whatsapp_diagnostics_attached' });
    };
    const onReady = () => {
        register();
        logger.info('Proveedor WhatsApp conectado; recepción pendiente de verificar con un mensaje', {
            action: 'whatsapp_provider_ready',
        });
    };
    const onAuthFailure = () => logger.error('Fallo de sesión WhatsApp; revisar baileys.log', {
        action: 'whatsapp_auth_failure',
    });
    provider.on('ready', onReady);
    provider.on('auth_failure', onAuthFailure);
    register();
    // Detecta también sockets nuevos mientras conectan, antes del evento ready.
    const timer = setInterval(register, 1000);
    timer.unref?.();
    return () => {
        clearInterval(timer);
        detach();
        provider.removeListener('ready', onReady);
        provider.removeListener('auth_failure', onAuthFailure);
    };
};
