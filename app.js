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
import { postWhatsappConversation } from './services/aws/index.js';

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
        const { handleCtx, httpServer } = await createBot({
        flow: adapterFlow,
        provider: adapterProvider,
        database: adapterDB,
    })

        // Iniciar portal web para código QR
        const port = process.env.PORT || 3000;
        httpServer(port)

        defaultLogger.info('Bot iniciado', { port });

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
