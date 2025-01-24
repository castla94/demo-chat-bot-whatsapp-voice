const { addKeyword } = require('@bot-whatsapp/bot')
const { 
    putWhatsapp,
    getWhatsapp, 
    whatsappStatus,
    promptGetWhatsapp,
    getWhatsappWhitelist 
} = require('../services/aws');
const { defaultLogger } = require('../helpers/cloudWatchLogger');

/**
 * Flujo para manejar la solicitud del menú
 * Muestra el menú del restaurante y gestiona el estado del chat
 */
const menu = addKeyword(['Menu'])
    .addAction(async (ctx, { flowDynamic, state, endFlow }) => {
        try {
            const userId = ctx.key.remoteJid
            const numberPhone = ctx.from
            const name = ctx?.pushName ?? ''

            defaultLogger.info('Iniciando procesamiento de menú', {
                userId,
                numberPhone,
                name,
                messageBody: ctx.body,
                action: 'menu_request',
                timestamp: new Date().toISOString(),
                file: 'menu.js'
            })

            // Validar si el usuario está en lista blanca
            const isWhitelisted = await getWhatsappWhitelist(numberPhone)
            defaultLogger.info('Verificación de whitelist', {
                userId,
                numberPhone,
                name,
                isWhitelisted,
                action: 'whitelist_verification',
                file: 'menu.js'
            })

            if (isWhitelisted) {
                defaultLogger.info('Usuario en whitelist, finalizando flujo', {
                    userId,
                    numberPhone,
                    name,
                    action: 'whitelist_end_flow',
                    file: 'menu.js'
                })
                return endFlow()
            }

            // Validar estado global del chatbot
            const botStatus = await whatsappStatus()
            defaultLogger.info('Estado global del bot', {
                userId,
                numberPhone,
                name,
                botStatus,
                action: 'global_status_check',
                file: 'menu.js'
            })

            if (botStatus && !botStatus.status) {
                defaultLogger.info('Bot desactivado globalmente', {
                    userId,
                    numberPhone,
                    name,
                    action: 'global_status_end_flow',
                    file: 'menu.js'
                })
                return endFlow()
            }

            // Validar estado individual del usuario
            const userStatus = await getWhatsapp(numberPhone)
            defaultLogger.info('Estado del usuario', {
                userId,
                numberPhone,
                name,
                userStatus,
                action: 'user_status_check',
                file: 'menu.js'
            })

            if (userStatus && !userStatus.status) {
                defaultLogger.info('Usuario desactivado', {
                    userId,
                    numberPhone,
                    name,
                    action: 'user_disabled_end_flow',
                    file: 'menu.js'
                })
                return endFlow()
            }

            // Obtener menú y mensajes
            const whatsappPrompt = await promptGetWhatsapp()
            defaultLogger.info('Menú obtenido', {
                userId,
                numberPhone,
                name,
                menuUrl: whatsappPrompt.url_menu,
                action: 'menu_retrieved',
                file: 'menu.js'
            })

            // Enviar saludo personalizado
            await flowDynamic(name)

            // Mostrar menú con imagen si existe URL válida
            const hasValidMenuUrl = whatsappPrompt.url_menu && 
                                  whatsappPrompt.url_menu !== "" && 
                                  whatsappPrompt.url_menu !== "NA"

            if (hasValidMenuUrl) {
                await flowDynamic([{
                    body: '🍽️ Nuestro Menú 🍽️',
                    media: whatsappPrompt.url_menu
                }])
            } else {
                await flowDynamic([{
                    body: whatsappPrompt.products
                }])
            }

            // Mensaje de espera de pedido
            await flowDynamic('Quedo atento a tu pedido.')

            // Actualizar estado del chat
            await putWhatsapp(numberPhone, name, true)
            defaultLogger.info('Estado del usuario actualizado', {
                userId,
                numberPhone,
                name,
                action: 'user_status_updated',
                file: 'menu.js'
            })

        } catch (error) {
            defaultLogger.error('Error en flujo de menú', {
                userId: ctx.key.remoteJid,
                numberPhone: ctx.from,
                name: ctx?.pushName,
                error: error.message,
                stack: error.stack,
                context: ctx,
                file: 'menu.js'
            })
        }
    })

module.exports = { menu }
