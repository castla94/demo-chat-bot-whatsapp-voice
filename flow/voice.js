const { addKeyword, EVENTS } = require('@bot-whatsapp/bot')
const { handlerAI } = require("../services/audio")
const { run, runDetermine } = require('../services/openai')
const { 
    getWhatsapp,
    putWhatsapp,
    whatsappStatus, 
    regexAlarm,
    putWhatsappEmailVendor,
    getWhatsappWhitelist 
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

            // Procesar alarmas o palabras clave
            const hasAlarm = await regexAlarm(transcribedText)
            defaultLogger.info('Verificación de alarma', {
                userId,
                numberPhone,
                name,
                messageBody: transcribedText,
                hasAlarm,
                action: 'alarm_check',
                file: 'voice.js'
            })

            if (hasAlarm) {
                const alarmResponse = await putWhatsappEmailVendor(numberPhone, name, transcribedText)
                defaultLogger.info('Procesamiento de alarma', {
                    numberPhone,
                    name,
                    message: transcribedText,
                    alarmResponse,
                    action: 'alarm_processing',
                    file: 'voice.js'
                })
                
                await flowDynamic(alarmResponse 
                    ? "Estamos contactando a un vendedor para atenderte."
                    : "Lo sentimos, pero no tenemos personal disponible en este momento."
                )
                
                await putWhatsapp(numberPhone, name, false)
                return endFlow()
            }

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

            // Enviar respuesta en chunks para mejor legibilidad
            const chunks = response.split(/(?<!\d)\.(?=\s|$)|:\n\n/g)

            for (const chunk of chunks) {
                await flowDynamic(chunk)
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

module.exports = { voice }
