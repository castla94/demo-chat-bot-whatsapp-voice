const { addKeyword, EVENTS } = require('@bot-whatsapp/bot')
const { handlerAI } = require("../services/audio")
const { run, runDetermine, runUpdatePromptServicesProduct } = require('../services/openai')
const { 
    getWhatsapp,
    putWhatsapp,
    whatsappStatus, 
    regexAlarm,
    putWhatsappEmailVendor,
    getWhatsappWhitelist,
    putWhatsappOrderConfirmation,
    promptUpdateProductWhatsapp ,
    promptGetWhatsapp,
    getWhatsappConversation
} = require('../services/aws')
const { setTimeout } = require('timers/promises')
const { defaultLogger } = require('../helpers/cloudWatchLogger')

/**
 * Flujo para manejar notas de voz
 * Procesa el audio, lo convierte a texto y genera respuestas
 */
const voice = addKeyword(EVENTS.VOICE_NOTE)
    // Primera acción: Validación inicial y análisis de intención
    .addAction(async (ctx, { state, endFlow }) => {
        const userId = ctx.key.remoteJid
        const numberPhone = ctx.from
        const name = ctx?.pushName ?? ''

        try {
            defaultLogger.info('Iniciando procesamiento de nota de voz', {
                userId,
                numberPhone,
                name,
                action: 'voice_note_received',
                file: 'voice.js'
            })

            // Validar si el usuario está en lista blanca
            const isWhitelisted = await getWhatsappWhitelist(numberPhone)
            defaultLogger.info('Verificación de whitelist', {
                userId,
                numberPhone,
                name,
                isWhitelisted,
                action: 'whitelist_verification',
                file: 'voice.js'
            })

            if (isWhitelisted) {
                defaultLogger.info('Usuario en whitelist, finalizando flujo', {
                    userId,
                    numberPhone,
                    name,
                    action: 'whitelist_end_flow',
                    file: 'voice.js'
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
                file: 'voice.js'
            })

            if (botStatus && !botStatus.status) {
                defaultLogger.info('Bot desactivado globalmente', {
                    action: 'global_status_end_flow',
                    file: 'voice.js'
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
                file: 'voice.js'
            })

            if (userStatus && !userStatus.status) {
                defaultLogger.info('Usuario desactivado', {
                    userId,
                    numberPhone,
                    name,
                    action: 'user_disabled_end_flow',
                    file: 'voice.js'
                })
                return endFlow()
            }


            // Get current conversation history from state
            const historyGlobalStatus = state.getMyState()?.history ?? []
            // Check if there's no conversation history
            if(historyGlobalStatus.length <= 0){
                // Fetch conversation history from database
                const historyDB = await getWhatsappConversation(numberPhone);
                defaultLogger.info('Historial de conversación recuperado de la base de datos', {
                    userId,
                    numberPhone,
                    name,
                    historyLength: historyDB?.length || 0,
                    action: 'history_db_retrieved',
                    file: 'voice.js'
                })

                defaultLogger.info('Estado actualizado con el historial de conversación', {
                    userId,
                    numberPhone,
                    name,
                    action: 'history_state_updated',
                    file: 'voice.js'
                })
                await state.update({ history: historyDB })
            }

            // Analizar intención del usuario
            const history = state.getMyState()?.history ?? []
            const intention = await runDetermine(history, numberPhone)
            defaultLogger.info('Intención detectada', {
                userId,
                numberPhone,
                name,
                intention: intention.toLowerCase(),
                history,
                action: 'intention_detected',
                file: 'voice.js'
            })

        } catch (error) {
            defaultLogger.error('Error en primera acción de voz', {
                userId,
                numberPhone,
                name,
                error: error.message,
                stack: error.stack,
                context: ctx,
                file: 'voice.js'
            })
            return endFlow()
        }
    })
    // Segunda acción: Procesamiento de audio y generación de respuesta
    .addAction(async (ctx, { flowDynamic, endFlow, state }) => {
        const userId = ctx.key.remoteJid
        const name = ctx?.pushName ?? ''
        const numberPhone = ctx.from

        try {
            defaultLogger.info('Iniciando segunda acción de voz', {
                userId,
                numberPhone,
                name,
                action: 'second_action_start',
                file: 'voice.js'
            })

            // Validaciones de seguridad
            const isWhitelisted = await getWhatsappWhitelist(numberPhone)
            defaultLogger.info('Verificación de whitelist', {
                userId,
                numberPhone,
                name,
                isWhitelisted,
                action: 'whitelist_verification',
                file: 'voice.js'
            })

            if (isWhitelisted) {
                defaultLogger.info('Usuario en whitelist, finalizando flujo', {
                    userId,
                    numberPhone,
                    name,
                    action: 'whitelist_end_flow',
                    file: 'voice.js'
                })
                return endFlow()
            }

            const botStatus = await whatsappStatus()
            defaultLogger.info('Estado global del bot', {
                userId,
                numberPhone,
                name,
                botStatus,
                action: 'global_status_check',
                file: 'voice.js'
            })

            if (botStatus && !botStatus.status) {
                defaultLogger.info('Bot desactivado globalmente', {
                    action: 'global_status_end_flow',
                    file: 'voice.js'
                })
                return endFlow()
            }

            const userStatus = await getWhatsapp(numberPhone)
            defaultLogger.info('Estado del usuario', {
                userId,
                numberPhone,
                name,
                userStatus,
                action: 'user_status_check',
                file: 'voice.js'
            })

            if (userStatus && !userStatus.status) {
                defaultLogger.info('Usuario desactivado', {
                    userId,
                    numberPhone,
                    name,
                    action: 'user_disabled_end_flow',
                    file: 'voice.js'
                })
                return endFlow()
            }

            // Convertir audio a texto
            const transcribedText = await handlerAI(ctx, numberPhone)
            defaultLogger.info('Audio transcrito', {
                userId,
                numberPhone,
                name,
                transcribedText,
                action: 'audio_transcription',
                file: 'voice.js'
            })

            // Call the alarm processing method
            const shouldEndFlow = await processAlarm(ctx, numberPhone, name, flowDynamic, transcribedText,transcribedText,"user")
            if (shouldEndFlow) return endFlow()

            // Actualizar historial de conversación
            const newHistory = state.getMyState()?.history ?? []
            newHistory.push({
                role: 'user',
                content: transcribedText
            })

            defaultLogger.info('Procesando mensajes acumulados', {
                userId,
                numberPhone,
                name,
                transcribedText,
                history: newHistory,
                action: 'processing_messages',
                file: 'voice.js'
            })

            // Obtener respuesta del modelo
            const response = await run(name, newHistory, transcribedText, numberPhone)
            defaultLogger.info('Respuesta del modelo obtenida', {
                userId,
                numberPhone,
                name,
                modelResponse: response,
                action: 'model_response',
                file: 'voice.js'
            })

            // Call the alarm processing method
            const shouldEndFlow2 = await processAlarm(ctx, numberPhone, name, flowDynamic, response,transcribedText,"IA")
            if (shouldEndFlow2) return endFlow()

            // Procesar orden si se detecta
            if (response.toLowerCase().includes("datos recibidos")) {

                const whatsappPrompt = await promptGetWhatsapp();
                if(whatsappPrompt.products_dynamic){
                        const updatePrompt = await runUpdatePromptServicesProduct(response);
                        defaultLogger.info('Prompt actualizado', {
                            userId,
                            numberPhone,
                            name,
                            updatePrompt,
                            action: 'update_prompt_complete',
                            file: 'voice.js'
                        });

                        const responseUpdateProductWhatsapp = await promptUpdateProductWhatsapp(updatePrompt);
                        defaultLogger.info('Respuesta de actualización de producto prompt', {
                            userId,
                            numberPhone,
                            name,
                            responseUpdateProductWhatsapp,
                            action: 'product_update_response',
                            file: 'voice.js'
                        });
                }

                const orderConfirmation = await putWhatsappOrderConfirmation(name, numberPhone, response, "pending_payment")
                defaultLogger.info('Orden procesada', {
                    userId,
                    numberPhone,
                    name,
                    response,
                    orderConfirmation,
                    action: 'order_processing',
                    file: 'voice.js'
                })
            }

            // Enviar respuesta en chunks para mejor legibilidad
            const chunks = response.split(/(?<!\d)\.(?=\s|$)|:\n\n/g)

            for (const chunk of chunks) {
                await flowDynamic(chunk.replace(/^[\n]+/, '').trim())
                await setTimeout(1000)
            }

            // Actualizar historial con respuesta
            newHistory.push({
                role: 'assistant',
                content: response
            })
            await state.update({ history: newHistory })

            // Actualizar estado del usuario si es nuevo
            if (!userStatus) {
                const newUserStatus = await putWhatsapp(numberPhone, name, true)
                defaultLogger.info('Nuevo usuario registrado', {
                    userId,
                    numberPhone,
                    name,
                    newUserStatus,
                    action: 'new_user_registration',
                    file: 'voice.js'
                })
            }

        } catch (error) {
            defaultLogger.error('Error en segunda acción de voz', {
                userId,
                numberPhone,
                name,
                error: error.message,
                stack: error.stack,
                context: ctx,
                file: 'voice.js'
            })
            return endFlow()
        }
    })


    // Process alarms through dedicated method
const processAlarm = async (ctx, numberPhone, name, flowDynamic, question,message,UserOrIA) => {
    const hasAlarm = await regexAlarm(question)
    defaultLogger.info('Verificación de alarma', {
        userId: ctx.key.remoteJid,
        numberPhone,
        name,
        messageBody: question,
        hasAlarm,
        action: 'alarm_check',
        file: 'chatbot.js'
    })

    if (hasAlarm) {
        const alarmResponse = await putWhatsappEmailVendor(numberPhone, name, message)
        defaultLogger.info('Procesamiento de alarma', {
            numberPhone,
            name,
            message: ctx.body,
            alarmResponse,
            action: 'alarm_processing',
            file: 'chatbot.js'
        })

        const messageFlow = UserOrIA === "user" ? "Gracias por tu mensaje. En breve nos pondremos en contacto contigo." : question

        await flowDynamic(alarmResponse 
            ? messageFlow
            : "Lo sentimos, pero no tenemos personal disponible en este momento."
        )
        
        await putWhatsapp(numberPhone, name, false)
        return true
    }
    return false
}

module.exports = { voice }
