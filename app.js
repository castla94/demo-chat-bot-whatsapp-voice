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


const main = async () => {
    try {
        // Inicializar adaptadores
        const adapterDB = new MockAdapter();
        const adapterFlow = createFlow([
            voice,
            chatbot, 
            welcome,
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
        
    } catch (error) {
        defaultLogger.error('Error al iniciar el bot', { 
            error: error.message, 
            stack: error.stack 
        });
    }
}

main();
