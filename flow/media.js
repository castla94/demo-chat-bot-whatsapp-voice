const { addKeyword, EVENTS } = require('@bot-whatsapp/bot')
const { run } = require('../services/openai')
const {
    getWhatsappConversation,
    putWhatsappEmailVendor,
    getWhatsapp,
    whatsappStatus,
    getWhatsappWhitelist,
    getWhatsappPlanPremiun,
    putWhatsapp,
    regexAlarm,
    postWhatsappConversation
} = require('../services/aws');
const { downloadMediaMessage } = require("@whiskeysockets/baileys")
const fs = require("fs");
const { defaultLogger } = require('../helpers/cloudWatchLogger');
const { processImage } = require("../services/image")


/**
 * Función auxiliar para pausar la ejecución
 * @param {number} ms - Milisegundos a esperar
 * @returns {Promise} Promesa que se resuelve después del tiempo especificado
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))


// Function to check premium plan status
const checkPremiumPlan = async (userId, numberPhone, name, flowDynamic) => {
    const isPremiun = await getWhatsappPlanPremiun()
    defaultLogger.info('Verificación de plan', {
        userId,
        numberPhone,
        name,
        action: 'plan_verification',
        file: 'voice.js'
    })

    if (isPremiun === null) {
        defaultLogger.info('No tiene plan pro, finalizando flujo', {
            userId,
            numberPhone,
            name,
            action: 'without_plan',
            file: 'media.js'
        })
        await flowDynamic([{
            body: "Lo siento, no puedo procesar tu imagen. Por favor, envíame por texto lo que necesitas consultar."
        }])
        return true
    }

    if (isPremiun && (isPremiun.plan !== "Pro" && isPremiun.plan !== "Enterprise")) {
        defaultLogger.info('Debe mejorar plan, finalizando flujo', {
            userId,
            numberPhone,
            name,
            action: 'without_plan_pro',
            file: 'media.js'
        })
        await flowDynamic([{
            body: "Lo siento, no puedo procesar tu imagen. Por favor, envíame por texto lo que necesitas consultar."
        }])
        return true
    }

    return false
}

// Process alarms through dedicated method
const processAlarm = async (ctx, numberPhone, name, flowDynamic, question, UserOrIA) => {
    const hasAlarm = await regexAlarm(question)
    defaultLogger.info('Verificación de alarma', {
        userId: ctx.key.remoteJid,
        numberPhone,
        name,
        messageBody: question,
        hasAlarm,
        action: 'alarm_check',
        file: 'media.js'
    })

    if (hasAlarm) {
        defaultLogger.info('Alarma encontrada, finalizando flujo', {
            userId: ctx.key.remoteJid,
            numberPhone,
            name,
            hasAlarm,
            messageBody: question,
            action: 'alarm_found',
            file: 'media.js'
        })
        await putWhatsapp(numberPhone, name, false)
        return true
    }
    return false
}

/**
 * Flow para manejar eventos de medios (imágenes) enviados por el usuario
 * Procesa comprobantes de pago y notifica al vendedor
 */
const media = addKeyword(EVENTS.MEDIA)
    .addAction(async (ctx, { flowDynamic, endFlow, state, provider }) => {
        const userId = ctx.key.remoteJid
        const numberPhone = ctx.from
        const name = ctx?.pushName ?? ''

        try {

            // 1. Enviar estado "escribiendo"
            await provider.vendor.sendPresenceUpdate('composing', ctx.key.remoteJid)

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
                const imageBuffer = fs.readFileSync(pathImg);
                const base64Image = imageBuffer.toString('base64');
                await postWhatsappConversation(numberPhone, "", "", base64Image,"imagen","user");

                return endFlow()
            }


            // Check premium plan status
            const shouldEndFlow = await checkPremiumPlan(userId, numberPhone, name, flowDynamic)
            if (shouldEndFlow) return endFlow()

            await flowDynamic([{
                body: "Dame un momento para revisar."
            }])

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

            const responseImage = await processImage(pathImg, numberPhone, name)

            if (!responseImage && !userStatus.status) {
                defaultLogger.info('Usuario desactivado', {
                    userId,
                    numberPhone,
                    name,
                    action: 'user_disabled_end_flow',
                    file: 'media.js'
                })
                return endFlow()
            }

            defaultLogger.info('Respuesta del modelo obtenida Imagen', {
                userId,
                numberPhone,
                name,
                modelResponse: responseImage.text,
                action: 'model_response',
                file: 'media.js'
            })
            // Get current conversation history from state
            const historyGlobalStatus = state.getMyState()?.history ?? []
            // Check if there's no conversation history
            if (historyGlobalStatus.length <= 0) {
                // Fetch conversation history from database
                const historyDB = await getWhatsappConversation(numberPhone);
                defaultLogger.info('Historial de conversación recuperado de la base de datos', {
                    userId,
                    numberPhone,
                    name,
                    historyLength: historyDB?.length || 0,
                    action: 'history_db_retrieved',
                    file: 'media.js'
                })

                defaultLogger.info('Estado actualizado con el historial de conversación', {
                    userId,
                    numberPhone,
                    name,
                    action: 'history_state_updated',
                    file: 'media.js'
                })
                await state.update({ history: historyDB })
            }

            const newHistory = (state.getMyState()?.history ?? [])

            const question = `Te envio la imagen con la informacion solicitada: *${responseImage.text}*\n\n. 
            IMPORTANTE : confirmo que la informacion es correcta.`

            newHistory.push({
                role: 'user',
                content: question
            })

            // Obtener respuesta del modelo
            const response = await run(name, newHistory, question, numberPhone, responseImage.img)
            defaultLogger.info('Respuesta del modelo obtenida Texto Imagen', {
                userId,
                numberPhone,
                name,
                modelResponse: response,
                action: 'model_response',
                file: 'media.js'
            })

            // Enviar respuesta en chunks
            //const chunks = response.split(/(?<!\d)\.(?=\s|$)|:\n\n/g)
            const chunks = response.split(/:\n\n|\n\n/)

            for (const chunk of chunks) {
                await flowDynamic([{
                    body: chunk.replace(/^[\n]+/, '').trim()
                }])
                await sleep(2000)
            }

            // Actualizar historial
            newHistory.push({
                role: 'assistant',
                content: response
            })

            // Eliminar los primeros 2 elementos
            // Comprobar si el array tiene más de 20 elementos
            if (newHistory.length > 20) {
                // Eliminar los primeros 2 elementos si tiene más de 20 elementos
                newHistory.splice(0, 2);
            }

            await state.update({ history: newHistory })

            responseImage.text = responseImage.text.replace(/\n/g, "<br>").replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")

            // Notificar al vendedor sobre el nuevo comprobante
            const responseAlarm = await putWhatsappEmailVendor(
                numberPhone,
                name,
                `<br><br>${responseImage.text}<br>`,
                responseImage.img
            )

            defaultLogger.info('Notificación enviada al vendedor', {
                userId,
                numberPhone,
                name,
                responseAlarm,
                action: 'vendor_notification_sent',
                file: 'media.js'
            })

            // Call the alarm processing method
            const shouldEndFlowAlarm = await processAlarm(ctx, numberPhone, name, flowDynamic, response, "IA")
            if (shouldEndFlowAlarm) return endFlow()

            fs.unlink(pathImg, (error) => {
                if (error) {
                    defaultLogger.error('Error eliminando Imagen', {
                        userId,
                        numberPhone,
                        name,
                        error: error.message,
                        action: 'delete_image',
                        file: 'media.js'
                    });
                }
            });

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
            return endFlow()
        }finally{
            await provider.vendor.readMessages([ctx.key])
            await new Promise(resolve => setTimeout(resolve, 5000));
            await provider.vendor.sendPresenceUpdate('paused', ctx.key.remoteJid)
        }
    })

module.exports = { media }
