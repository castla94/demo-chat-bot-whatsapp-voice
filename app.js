const { createBot, createProvider, createFlow, addKeyword, EVENTS } = require('@bot-whatsapp/bot');

const QRPortalWeb = require('@bot-whatsapp/portal');
const BaileysProvider = require('@bot-whatsapp/provider/baileys');
const MockAdapter = require('@bot-whatsapp/database/mock');
const { voice } = require('./flow/voice');
const { media } = require('./flow/media');
const { menu } = require('./flow/menu');
const { chatbot } = require('./flow/chatbot');
const { vendor } = require('./flow/vendor');
const { welcome } = require('./flow/welcome');
require('dotenv').config();
// ... existing code ...
const { defaultLogger } = require('./helpers/cloudWatchLogger');
const express = require("express");
const app = express();


const main = async () => {
    try {
        app.use(express.json());
        // Inicializar adaptadores
        const adapterDB = new MockAdapter();
        const adapterFlow = createFlow([
            voice,
            chatbot,
            welcome,
            media
        ]);
        const adapterProvider = createProvider(BaileysProvider);

        // Crear instancia del bot
        const bot = createBot({
            flow: adapterFlow,
            provider: adapterProvider,
            database: adapterDB,
        });

        // Iniciar portal web para código QR
        const port = process.env.PORT || 3000;
        QRPortalWeb({ port });

        defaultLogger.info('Bot iniciado', { port });

        /**
         * Enviar mensaje con metodos propios del provider del bot
         */
        /*app.post("/send-message-bot", async (req, res) => {
            const { phoneNumber, message } = req.body; // Extrae los parámetros del body

            if (!phoneNumber || !message) {
                return res.status(400).send({ error: "Parámetros 'phoneNumber' y 'message' son requeridos" });
            }

            try {
                // Enviar el mensaje usando el número y el mensaje desde el body
                await adapterProvider.sendText(`${phoneNumber}@c.us`, message);
                console.log("enviado!");
                res.send({ data: "enviado!" });
            } catch (error) {
                console.error("Error al enviar mensaje:", error);
                res.status(500).send({ error: "Error al enviar el mensaje" });
            }
        });
        const portsend = 3001
        app.listen(portsend, () => console.log(`http://localhost:${portsend}`));
        */

    } catch (error) {
        defaultLogger.error('Error al iniciar el bot', {
            error: error.message,
            stack: error.stack
        });
    }
}

main();
