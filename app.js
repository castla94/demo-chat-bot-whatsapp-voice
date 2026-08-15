import { createBot, createProvider, createFlow } from '@builderbot/bot';
import { writeFileSync, unlinkSync } from 'fs';
import { BaileysProvider as Provider } from '@builderbot/provider-baileys'
//import { BaileysProvider as Provider } from 'aurik3-builderbot-baileys-custom'
import { MemoryDB as Database } from '@builderbot/bot'
import { voice } from './flow/voice.js';
import { media } from './flow/media.js';
import { chatbot } from './flow/chatbot.js';
import 'dotenv/config';
import { defaultLogger } from './helpers/cloudWatchLogger.js';
import express from 'express';
import { getWhatsapp, getWhatsappWhitelist, postWhatsappConversation, putWhatsapp } from './services/aws/index.js';
import { addReceivedFromRawMessage } from './helpers/conversationBuffer.js';

const app = express();
const MIME_EXTENSION_MAP = {
    'application/pdf': 'pdf',
    'application/msword': 'doc',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.ms-excel': 'xls',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'text/plain': 'txt',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png'
};

const getFileExtensionFromBase64 = (base64Media, type) => {
    const mimeMatch = /^data:([^;]+);base64,/i.exec(base64Media ?? '');
    const mimeType = mimeMatch?.[1]?.toLowerCase();

    if (mimeType && MIME_EXTENSION_MAP[mimeType]) {
        return MIME_EXTENSION_MAP[mimeType];
    }

    return type === 'imagen' ? 'jpg' : 'pdf';
};

const buildTempFilePath = (prefix, extension) => {
    const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `temp/${prefix}_${safeTimestamp}.${extension}`;
};

const extractPhoneNumberFromOwnMessage = (message) => {
    const jidCandidates = [
        message?.key?.remoteJidAlt,
        message?.key?.remoteJid
    ];

    for (const jid of jidCandidates) {
        const rawValue = String(jid || '').trim();
        if (!rawValue) {
            continue;
        }

        const phoneNumber = rawValue.split('@')[0].replace(/\D/g, '');
        if (phoneNumber) {
            return phoneNumber;
        }
    }

    return '';
};

const processOwnTextMessage = async (message) => {
    const text = String(message?.message?.conversation || '').trim();

    if (!text) {
        return;
    }

    const phoneNumber = extractPhoneNumberFromOwnMessage(message);
    if (!phoneNumber) {
        defaultLogger.warn('No se pudo extraer el número del mensaje manual', {
            remoteJid: message?.key?.remoteJid,
            remoteJidAlt: message?.key?.remoteJidAlt,
            action: 'own_message_phone_missing',
            file: 'app.js'
        });
        return;
    }

    const name = String(
        message?.pushName ||
        message?.notifyName ||
        message?.verifiedBizName ||
        ''
    ).trim();

    defaultLogger.info('Mensaje manual detectado', {
        phoneNumber,
        name,
        text,
        remoteJid: message?.key?.remoteJid,
        remoteJidAlt: message?.key?.remoteJidAlt,
        action: 'own_message_detected',
        file: 'app.js'
    });

    const userStatus = await getWhatsapp(phoneNumber, { name });

    const userStatusLabel = userStatus
        ? (userStatus.status ? 'activo' : 'inactivo')
        : 'sin_registro';

    defaultLogger.info(`Estado del contacto para mensaje manual: ${userStatusLabel}`, {
        phoneNumber,
        name,
        userStatus,
        action: 'own_message_user_status_check',
        file: 'app.js'
    });

    if (userStatusLabel === 'sin_registro') {
        defaultLogger.info('Mensaje manual omitido por contacto sin registro', {
            phoneNumber,
            name,
            action: 'own_message_skip_without_user_record',
            file: 'app.js'
        });
        return;
    }

    if (userStatus?.status) {
        await putWhatsapp(phoneNumber, userStatus.name || name, false);

        defaultLogger.info('Bot desactivado por mensaje manual', {
            phoneNumber,
            name: userStatus.name || name,
            action: 'own_message_bot_disabled',
            file: 'app.js'
        });
    }

    const isWhitelisted = await getWhatsappWhitelist(phoneNumber);

    if (isWhitelisted) {
        defaultLogger.info('Conversación manual omitida por whitelist', {
            phoneNumber,
            name,
            action: 'own_message_skip_conversation_whitelist',
            file: 'app.js'
        });
        return;
    }

    await postWhatsappConversation(phoneNumber, "", text, "", "", 'openia');
};

const attachOwnMessageListener = (adapterProvider) => {
    let activeSock = null;

    const onMessagesUpsert = async ({ messages }) => {
        for (const message of messages || []) {
            try {
                if (!message?.message) continue;
                if (message?.key?.fromMe !== true) continue;

                await processOwnTextMessage(message);
            } catch (error) {
                defaultLogger.error('Error procesando mensaje manual propio', {
                    error: error.message,
                    stack: error.stack,
                    remoteJid: message?.key?.remoteJid,
                    remoteJidAlt: message?.key?.remoteJidAlt,
                    action: 'own_message_processing_error',
                    file: 'app.js'
                });
            }
        }
    };

    const onConnectionUpdate = () => {
        registerListener();
    };

    const detachFromSock = (sock) => {
        if (!sock?.ev) return;
        if (typeof sock.ev.off === 'function') {
            sock.ev.off('messages.upsert', onMessagesUpsert);
            sock.ev.off('connection.update', onConnectionUpdate);
            return;
        }
        if (typeof sock.ev.removeListener === 'function') {
            sock.ev.removeListener('messages.upsert', onMessagesUpsert);
            sock.ev.removeListener('connection.update', onConnectionUpdate);
        }
    };

    const attachToSock = (sock) => {
        if (!sock?.ev?.on) {
            return false;
        }

        if (activeSock === sock) {
            return true;
        }

        if (activeSock) {
            detachFromSock(activeSock);
        }

        sock.ev.on('messages.upsert', onMessagesUpsert);
        sock.ev.on('connection.update', onConnectionUpdate);
        activeSock = sock;
        return true;
    };

    const registerListener = () => {
        const sock =
            adapterProvider.vendor ??
            adapterProvider.sock ??
            adapterProvider.instance?.sock;

        if (!attachToSock(sock)) {
            return;
        }
    };

    registerListener();
    adapterProvider.on('ready', registerListener);
};

/**
 * Listener BAILEYS de mensajes ENTRANTES (pre-BuilderBot, punto más temprano).
 * Registra CADA mensaje (texto/audio/imagen) en la conversación compartida INMEDIATAMENTE
 * al detectarlo, incrementando la versión global y lastActivityAt ANTES que BuilderBot
 * encole los addKeyword secuenciales por número.
 *
 * Así, cuando el flujo de texto empiece su polling y luego llegue un audio, el listener
 * de Baileys YA habrá registrado el audio e incrementado la versión a N+1 → el polling
 * del texto detectará version mismatch y cederá el turno inmediatamente (sin importar que
 * BuilderBot aún no haya procesado el voice.js por la cola secuencial).
 */
const attachIncomingConversationListener = (adapterProvider) => {
    let activeSock = null;

    const onMessagesUpsert = async ({ messages }) => {
        for (const message of messages || []) {
            try {
                // ======= FILTROS ANTI-NOISE =======
                const k = message?.key || {}
                // 1) Mensajes propios NUNCA entran
                if (k.fromMe === true) continue
                // 2) Filtrar status (broadcast de estados 0@s.whatsapp.net)
                const remoteStr = String(k.remoteJid || '')
                if (remoteStr.startsWith('status@') || remoteStr.includes('broadcast')) continue
                // 3) Filtrar grupos (remate en @g.us)
                if (remoteStr.endsWith('@g.us')) continue
                // 4) Filtrar messageStubType (eventos de grupo, added, leave, etc.)
                if (message?.messageStubType) continue
                // 5) Filtrar receipts (acknowledgments sin message payload)
                if (!message?.message || Object.keys(message.message).length === 0) continue
                // 6) Bloquear explícitamente tipos que no deben entrar al buffer
                const m = message.message
                const noisyTypes = ['reactionMessage','senderKeyDistributionMessage','protocolMessage',
                    'receiptMessage','pollUpdateMessage','pollCreationMessage','call','commentMessage',
                    'groupInviteLinkMessage','groupMentionedMessage']
                let isNoisy = false
                for (const nt of noisyTypes) if (m[nt]) { isNoisy = true; break }
                if (isNoisy) {
                    defaultLogger.debug('Listener raw: mensaje ruido ignorado', {
                        remoteJid: remoteStr,
                        messageId: k.id,
                        types: Object.keys(m),
                        action: 'conversation_listener_noise_skip',
                        file: 'app.js'
                    })
                    continue
                }

                defaultLogger.debug('Listener raw: mensaje candidato a buffer', {
                    remoteJid: remoteStr,
                    remoteJidAlt: k.remoteJidAlt,
                    participant: k.participant,
                    messageId: k.id,
                    messageTimestamp: message?.messageTimestamp,
                    messageTypes: Object.keys(m),
                    action: 'conversation_listener_candidate',
                    file: 'app.js'
                })

                const res = addReceivedFromRawMessage(message, { file: 'app.js' });
                if (res) {
                    defaultLogger.info('Listener raw registró mensaje en buffer compartido', {
                        phoneKey: res.phoneKey,
                        version: res.version,
                        duplicated: res.duplicated,
                        entryId: res.entryId,
                        type: res.type,
                        receivedAt: res.receivedAt ? new Date(res.receivedAt).toISOString() : null,
                        action: 'conversation_listener_added',
                        file: 'app.js'
                    })
                }
            } catch (error) {
                defaultLogger.error('Error en listener entrada conversación', {
                    error: error.message,
                    stack: error.stack,
                    remoteJid: message?.key?.remoteJid,
                    action: 'conversation_listener_error',
                    file: 'app.js'
                });
            }
        }
    };

    const onConnectionUpdate = () => {
        registerListener();
    };

    const detachFromSock = (sock) => {
        if (!sock?.ev) return;
        if (typeof sock.ev.off === 'function') {
            sock.ev.off('messages.upsert', onMessagesUpsert);
            sock.ev.off('connection.update', onConnectionUpdate);
            return;
        }
        if (typeof sock.ev.removeListener === 'function') {
            sock.ev.removeListener('messages.upsert', onMessagesUpsert);
            sock.ev.removeListener('connection.update', onConnectionUpdate);
        }
    };

    const attachToSock = (sock) => {
        if (!sock?.ev?.on) return false;
        if (activeSock === sock) return true;
        if (activeSock) detachFromSock(activeSock);
        sock.ev.on('messages.upsert', onMessagesUpsert);
        sock.ev.on('connection.update', onConnectionUpdate);
        activeSock = sock;
        return true;
    };

    const registerListener = () => {
        const sock =
            adapterProvider.vendor ??
            adapterProvider.sock ??
            adapterProvider.instance?.sock;
        attachToSock(sock);
    };

    registerListener();
    adapterProvider.on('ready', registerListener);
};

const main = async () => {
    try {
        // aumentar el límite de JSON y URL-encoded
        app.use(express.json({ limit: '50mb' }));
        app.use(express.urlencoded({ limit: '50mb', extended: true }));

        // Inicializar adaptadores
        const adapterDB = new Database()
        const adapterFlow = createFlow([
           chatbot, media, voice
        ]);
        const adapterProvider = createProvider(Provider,{ version: [2, 3000, 1045285769]});

        // Crear instancia del bot
        const { httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })

        // Iniciar portal web para código QR
        const port = process.env.PORT || 3000;
        httpServer(port)

        defaultLogger.info('Bot iniciado', { port });

        attachOwnMessageListener(adapterProvider);
        attachIncomingConversationListener(adapterProvider);

        /**
         * Enviar mensaje con metodos propios del provider del bot
         */
        app.post("/send-message-bot", async (req, res) => {

            const { phoneNumber, message } = req.body; // Extrae los parámetros del body

            if (!phoneNumber || !message) {
                defaultLogger.warn("Parámetros 'phoneNumber' y 'message' son requeridos", {
                    phoneNumber: !!phoneNumber,
                    message: !!message
                });
                return res.status(400).send({ error: "Parámetros 'phoneNumber' y 'message' son requeridos" });
            }

            try {

                if(phoneNumber.includes('@')){
                    await adapterProvider.sendText(phoneNumber, message);
                }else{
                    // Enviar el mensaje usando el número y el mensaje desde el body
                    await adapterProvider.sendText(`${phoneNumber}@s.whatsapp.net`, message);
                }

                defaultLogger.info('Mensaje Manual Enviado', {
                    phoneNumber,
                    messageBody: message,
                    timestamp: new Date().toISOString()
                });

                await postWhatsappConversation(phoneNumber, "", message,"","",'openia');

                res.send({ data: "enviado" });
            } catch (error) {
                defaultLogger.error('Error al enviar el mensaje', {
                    phoneNumber,
                    error: error.message,
                    stack: error.stack
                });

                console.error("Error al enviar mensaje:", error);
                res.status(500).send({ error: "Error al enviar el mensaje" });
            }
        });


        /**
        * Enviar mensaje con metodos propios del provider del bot
        */
        app.post("/send-media-bot", async (req, res) => {

            const { phoneNumber, message="", base64Media, type } = req.body; // Extrae los parámetros del body

            if (!phoneNumber || !base64Media || !type) {
                defaultLogger.warn("Parámetros 'phoneNumber' , 'message' , 'base64Media', 'type' son requeridos", {
                    phoneNumber: !!phoneNumber,
                    message: !!message
                });
                return res.status(400).send({ error: "Parámetros 'phoneNumber' , 'message' , 'base64Media', 'type' son requeridos" });
            }

            try {

                // Paso 1: base64 (sin encabezado "data:image/jpeg;base64,...")
                const base64Data = base64Media.includes(',')
                    ? base64Media.split(',')[1]
                    : base64Media;

                let  filePath = '';
                // Paso 2: guardar archivo temporal
                if(type == 'imagen'){
                    const fileExtension = getFileExtensionFromBase64(base64Media, type);
                    // Paso 2: guardar archivo temporal
                    filePath = buildTempFilePath('imagen', fileExtension);
                    writeFileSync(filePath, base64Data, 'base64');
                    await adapterProvider.sendImage(`${phoneNumber}@s.whatsapp.net`, filePath, message);

                }
                if(type == 'file'){
                    const fileExtension = getFileExtensionFromBase64(base64Media, type);
                    // Paso 2: guardar archivo temporal
                    filePath = buildTempFilePath('file', fileExtension);
                    writeFileSync(filePath, base64Data, 'base64');
                    await adapterProvider.sendFile(`${phoneNumber}@s.whatsapp.net`, filePath);
                    if(message!==''){
                        await adapterProvider.sendText(`${phoneNumber}@s.whatsapp.net`, message);
                    }
                }

                defaultLogger.info(type+' Manual Enviado', {
                    phoneNumber,
                    messageBody: type+": " + message,
                    timestamp: new Date().toISOString()
                });

                await postWhatsappConversation(phoneNumber, "", message,base64Media,type,'openia');

                if(filePath !==''){
                    unlinkSync(filePath);
                }

                res.send({ data: "enviado" });
            } catch (error) {
                defaultLogger.error('Error al enviar el mensaje '+type, {
                    phoneNumber,
                    error: error.message,
                    stack: error.stack
                });

                console.error("Error al enviar mensaje "+type+" :", error);
                res.status(500).send({ error: "Error al enviar el mensaje "+type });
            }
        });
        const portsend = parseInt(port) + 10000;
        app.listen(portsend, () => console.log(`http://localhost:${portsend}`));


    } catch (error) {
        defaultLogger.error('Error al iniciar el bot', {
            error: error.message,
            stack: error.stack
        });
    }
}

main();
