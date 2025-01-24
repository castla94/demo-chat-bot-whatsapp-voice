const { addKeyword, EVENTS } = require('@bot-whatsapp/bot')
const { 
    putWhatsapp, 
    putWhatsappEmailVendor,
    getWhatsapp,
    whatsappStatus,
    getWhatsappWhitelist 
} = require('../services/aws');
const { downloadMediaMessage } = require("@adiwajshing/baileys")
const fs = require("fs");
const { defaultLogger } = require('../helpers/cloudWatchLogger');

/**
 * Flow para manejar eventos de medios (imágenes) enviados por el usuario
 * Procesa comprobantes de pago y notifica al vendedor
 */
const media = addKeyword(EVENTS.MEDIA)
    .addAction(async (ctx, { flowDynamic, endFlow }) => {
        const userId = ctx.key.remoteJid
        const numberPhone = ctx.from
        const name = ctx?.pushName ?? ''

        try {
            defaultLogger.info('Iniciando procesamiento de imagen', {
                userId,
                numberPhone,
                name,
                action: 'media_received',
                timestamp: new Date().toISOString(),
                file: 'media.js'
            })

            // Validar si el usuario está en lista blanca
            const isWhitelisted = await getWhatsappWhitelist(numberPhone)
            defaultLogger.info('Verificación de whitelist', {
                userId,
                numberPhone,
                name,
                isWhitelisted,
                action: 'whitelist_verification',
                file: 'media.js'
            })

            if (isWhitelisted) {
                defaultLogger.info('Usuario en whitelist, finalizando flujo', {
                    userId,
                    numberPhone,
                    name,
                    action: 'whitelist_end_flow',
                    file: 'media.js'
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
                file: 'media.js'
            })

            if (botStatus && !botStatus.status) {
                defaultLogger.info('Bot desactivado globalmente', {
                    userId,
                    numberPhone,
                    name,
                    action: 'global_status_end_flow',
                    file: 'media.js'
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
                file: 'media.js'
            })

            if (userStatus && !userStatus.status) {
                defaultLogger.info('Usuario desactivado', {
                    userId,
                    numberPhone,
                    name,
                    action: 'user_disabled_end_flow',
                    file: 'media.js'
                })
                return endFlow()
            }

            // Procesar y guardar la imagen recibida
            const buffer = await downloadMediaMessage(ctx, "buffer")
            const fileName = `imagen${numberPhone}-${Date.now()}.jpg`
            const pathImg = `${process.cwd()}/media/${fileName}`
            
            await fs.promises.writeFile(pathImg, buffer)
            defaultLogger.info('Imagen guardada', {
                userId,
                numberPhone,
                name,
                fileName,
                action: 'image_saved',
                file: 'media.js'
            })

            // Notificar al vendedor sobre el nuevo comprobante
            const responseAlarm = await putWhatsappEmailVendor(
                numberPhone,
                name,
                "Comprobante de Pago Enviado."
            )
            
            defaultLogger.info('Notificación enviada al vendedor', {
                userId,
                numberPhone,
                name,
                responseAlarm,
                action: 'vendor_notification_sent',
                file: 'media.js'
            })

            // Enviar respuesta al usuario según disponibilidad
            if (responseAlarm) {
                await flowDynamic([
                    "Gracias por enviar el comprobante de pago",
                    "Voy a validar el pago"
                ])
            } else {
                await flowDynamic(
                    "Lo sentimos, pero no tenemos personal disponible en este momento."
                )
            }

            // Actualizar estado del chat
            await putWhatsapp(numberPhone, name, false)
            defaultLogger.info('Estado del chat actualizado', {
                userId,
                numberPhone,
                name,
                action: 'chat_status_updated',
                file: 'media.js'
            })
            
            return endFlow()

        } catch (error) {
            defaultLogger.error('Error en flujo de medios', {
                userId,
                numberPhone,
                name,
                error: error.message,
                stack: error.stack,
                context: ctx,
                file: 'media.js'
            })
            await flowDynamic(
                "Ocurrió un error al procesar tu imagen. Por favor, intenta nuevamente."
            )
            return endFlow()
        }
    })

module.exports = { media }
