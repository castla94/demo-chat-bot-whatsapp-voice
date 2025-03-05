const { addKeyword } = require('@bot-whatsapp/bot')
const { 
    putWhatsapp,
    promptGetWhatsapp,
    getWhatsappWhitelist,
    postWhatsappConversation 
} = require('../services/aws');
const { defaultLogger } = require('../helpers/cloudWatchLogger');
const fs = require("fs");

const { textToVoice } = require('../services/audio');
/**
 * Welcome flow that handles initial user interaction
 * Manages whitelist validation, conversation history and menu display
 */
const welcome = addKeyword([
    "buenas",
    "hola", 
    "como esta",
    "buenos"
])
.addAction(async (ctx, { flowDynamic, endFlow, state,provider }) => {
    try {
        const userId = ctx.key.remoteJid
        const userPhone = ctx.from
        const userName = ctx?.pushName ?? ''

        defaultLogger.info('Iniciando procesamiento de mensaje', {
            userId,
            numberPhone: userPhone,
            name: userName,
            messageBody: ctx.body,
            action: 'message_received',
            timestamp: new Date().toISOString(),
            file: 'welcome.js'
        })

        // Reset conversation history
        await state.update({ history: [] })

        // Check if user is in whitelist
        const isWhitelisted = await getWhatsappWhitelist(userPhone)
        defaultLogger.info('Verificación de whitelist', {
            userId,
            numberPhone: userPhone,
            name: userName,
            isWhitelisted,
            action: 'whitelist_verification',
            file: 'welcome.js'
        })

        if (isWhitelisted) {
            defaultLogger.info('Usuario en whitelist, finalizando flujo', {
                userId,
                numberPhone: userPhone,
                name: userName,
                action: 'whitelist_end_flow',
                file: 'welcome.js'
            })
            return endFlow()
        }

        // Initialize user session
        await putWhatsapp(userPhone, userName, true)
        defaultLogger.info('Estado del usuario', {
            userId,
            numberPhone: userPhone,
            name: userName,
            action: 'user_status_check',
            file: 'welcome.js'
        })

        // Get welcome message and menu
        const whatsappPrompt = await promptGetWhatsapp()
        defaultLogger.info('Procesando mensajes acumulados', {
            userId,
            numberPhone: userPhone,
            name: userName,
            action: 'processing_messages',
            file: 'welcome.js'
        })
        
        // Save initial conversation
        await postWhatsappConversation(
            userPhone,
            ctx.body,
            whatsappPrompt.welcome
        )
        defaultLogger.info('Respuesta del modelo obtenida', {
            userId,
            numberPhone: userPhone,
            name: userName,
            modelResponse: whatsappPrompt.welcome,
            action: 'model_response',
            file: 'welcome.js'
        })

        // Send welcome message
        await flowDynamic(whatsappPrompt.welcome)

        /*
        const pathAudio = await textToVoice(userId, userPhone, userName,whatsappPrompt.welcome)
        await provider.sendAudio(ctx.from+"@s.whatsapp.net", pathAudio)
        */

        // Display menu based on configuration
        await displayMenu(whatsappPrompt, flowDynamic)

       /* fs.unlink(pathAudio, (error) => {
            if (error) {
                defaultLogger.error('Error eliminando audio', {
                    userId,
                    numberPhone,
                    name,
                    error: error.message,
                    action: 'delete_audio',
                    file: 'audio/index.js'
                });
            }
        });*/

    } catch (err) {
        console.log("error",err)
        defaultLogger.error('Error en welcome flujo', {
            userId: ctx.key.remoteJid,
            numberPhone: ctx.from,
            name: ctx?.pushName,
            error: err,
            file: 'welcome.js'
        })
    }
})

/**
 * Helper function to display menu content
 * @param {Object} whatsappPrompt - Prompt containing menu data
 * @param {Function} flowDynamic - Flow control function
 */
const displayMenu = async (whatsappPrompt, flowDynamic) => {
    const hasValidMenuUrl = whatsappPrompt.url_menu && 
                           whatsappPrompt.url_menu !== "" && 
                           whatsappPrompt.url_menu !== "NA"

    /*                      
    if (!hasValidMenuUrl) {
        await flowDynamic([{
            body: whatsappPrompt.products
        }])
        return
    }
*/
if (hasValidMenuUrl) {
    await flowDynamic([{
        body: '.',
        media: whatsappPrompt.url_menu
    }])
}
}

module.exports = { welcome }
