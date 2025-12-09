import { createBot, createProvider, createFlow } from '@builderbot/bot';
import { writeFileSync, unlinkSync } from 'fs';
import { BaileysProvider as Provider } from 'aurik3-builderbot-baileys-custom'
import { MemoryDB as Database } from '@builderbot/bot'
import { voice } from './flow/voice.js';
import { media } from './flow/media.js';
import { chatbot } from './flow/chatbot.js';
import 'dotenv/config';
import { defaultLogger } from './helpers/cloudWatchLogger.js';
import express from 'express';
import { postWhatsappConversation } from './services/aws/index.js';

const app = express();

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
        const adapterProvider = createProvider(Provider,{ version: [2, 3000, 1027934701]});

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

                // Enviar el mensaje usando el número y el mensaje desde el body
                await adapterProvider.sendText(`${phoneNumber}@c.us`, message);

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
                    // Paso 2: guardar archivo temporal
                    filePath = 'temp/imagen_' + new Date().toISOString() + '';
                    writeFileSync(filePath, base64Data, 'base64');
                    await adapterProvider.sendImage(`${phoneNumber}@c.us`, filePath, message);

                }
                if(type == 'file'){
                    // Paso 2: guardar archivo temporal
                    filePath = 'temp/file_' + new Date().toISOString() + '';
                    writeFileSync(filePath, base64Data, 'base64');
                    await adapterProvider.sendFile(`${phoneNumber}@c.us`, filePath);
                    if(message!==''){
                        await adapterProvider.sendText(`${phoneNumber}@c.us`, message);
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
