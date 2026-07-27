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
    let isListenerAttached = false;

    const registerListener = () => {
        if (isListenerAttached) {
            console.log('Listener de mensajes propios ya registrado');
            return;
        }

        const sock =
            adapterProvider.vendor ??
            adapterProvider.sock ??
            adapterProvider.instance?.sock;

        if (!sock?.ev?.on) {
            console.warn('Socket de Baileys aun no disponible para escuchar eventos propios');
            return;
        }

        sock.ev.on('messages.upsert', async ({ messages }) => {
            for (const message of messages) {
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
        });

        isListenerAttached = true;
    
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
        const adapterProvider = createProvider(Provider,{ version: [2, 3000, 1043085068]});

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
