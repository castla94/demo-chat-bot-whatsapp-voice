import { addKeyword, EVENTS } from '@builderbot/bot'
import { handlerAI } from "../services/audio/index.js"
import { run, runUpdatePromptServicesProduct } from '../services/openai/index.js'   
import { 
    getWhatsapp,
    putWhatsapp,
    whatsappStatus, 
    regexAlarm,
    putWhatsappEmailVendor,
    getWhatsappWhitelist,
    putWhatsappOrderConfirmation,
    promptUpdateProductWhatsapp ,
    promptGetWhatsapp,
    getWhatsappConversation,
    postWhatsappConversation,
    getWhatsappPlanPremiun
} from '../services/aws/index.js'
import { setTimeout } from 'timers/promises'
import { defaultLogger } from '../helpers/cloudWatchLogger.js'

 
// Function to check premium plan status
const checkPremiumPlan = async (userId, numberPhone, name, provider) => {
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
            file: 'voice.js'
        })
        
        await provider.sendMessage(numberPhone,"Lo siento, no puedo procesar notas de voz en este momento. Por favor, escribe tu consulta en un mensaje de texto.", { media: null})

        return true
    }
    console.log("isPremiun",isPremiun)
    if (isPremiun && (isPremiun.plan !== "Pro" && isPremiun.plan !== "Enterprise")) {
        defaultLogger.info('Debe mejorar plan, finalizando flujo', {
            userId,
            numberPhone,
            name,
            action: 'without_plan_pro',
            file: 'voice.js'
        })

        await provider.sendMessage(numberPhone,"Lo siento, no puedo procesar notas de voz en este momento. Por favor, escribe tu consulta en un mensaje de texto.", { media: null})

        return true
    }

    return false
}


function extractNumber(ctx) {
    const from = ctx.from
    const remoteJid = ctx.key.remoteJid.split('@')[0]
    const remoteJidAlt = ctx.key.remoteJidAlt.split('@')[0]

    if (from && from.length <= 11) return from
    if (remoteJidAlt && remoteJidAlt.length <= 11) return remoteJidAlt
    if (remoteJid && remoteJid.length <= 11) return remoteJid
    return from
}
 
/**
 * Flujo para manejar notas de voz
 * Procesa el audio, lo convierte a texto y genera respuestas
 */
export const voice = addKeyword(EVENTS.VOICE_NOTE)
    // Primera acción: Validación inicial y análisis de intención
    .addAction(async (ctx, { state, endFlow,flowDynamic, provider }) => {
        const userId = ctx.key.remoteJid
        const numberPhone = extractNumber(ctx)
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

            // Check premium plan status
            const shouldEndFlow = await checkPremiumPlan(userId, numberPhone, name, provider)
            if (shouldEndFlow) return endFlow()

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
    .addAction(async (ctx, { flowDynamic, endFlow, state, provider }) => {
        const userId = ctx.key.remoteJid
        const name = ctx?.pushName ?? ''
        const numberPhone = extractNumber(ctx)

        try {
            // 1. Enviar estado "escribiendo"
            await provider.vendor.sendPresenceUpdate('composing', ctx.key.remoteJid)

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
            const transcribedText = await handlerAI(ctx,provider, numberPhone)
            defaultLogger.info('Audio transcrito', {
                userId,
                numberPhone,
                name,
                transcribedText,
                action: 'audio_transcription',
                file: 'voice.js'
            })

            if(transcribedText === "ERROR"){
                await provider.sendMessage(numberPhone,"Disculpa, no entendí tu mensaje. Por favor, puedes enviarlo de nuevo.", { media: null})
                return endFlow()
            }

            // Call the alarm processing method
            const shouldEndFlow = await processAlarm(ctx, numberPhone, name, provider, transcribedText,transcribedText,"user")
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
            const shouldEndFlow2 = await processAlarm(ctx, numberPhone, name, provider, response,transcribedText,"IA")
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
            //const chunks = response.split(/(?<!\d)\.(?=\s|$)|:\n\n/g)
            const chunks = response.split(/:\n\n|\n\n/)

            for (const chunk of chunks) {
                await provider.sendMessage(numberPhone,chunk.replace(/^[\n]+/, '').trim(), { media: null})
                await setTimeout(2000)
            }

            // Actualizar historial con respuesta
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
        }finally{
            await provider.vendor.readMessages([ctx.key])
            await new Promise(resolve => setTimeout(resolve, 5000));
            await provider.vendor.sendPresenceUpdate('paused', ctx.key.remoteJid)
        }
    })


    // Process alarms through dedicated method
const processAlarm = async (ctx, numberPhone, name, provider, question,message,UserOrIA) => {
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

        if(UserOrIA === "user"){
            await postWhatsappConversation(numberPhone,question,"");
        }else{
            await postWhatsappConversation(numberPhone,"",question);
        }

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

        await provider.sendMessage(numberPhone,alarmResponse 
            ? messageFlow
            : "Lo sentimos, pero no tenemos personal disponible en este momento.", { media: null})
        
        await putWhatsapp(numberPhone, name, false)
        return true
    }
    return false
}