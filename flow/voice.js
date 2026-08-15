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
import { getProfilePictureInfo } from '../helpers/whatsappProfile.js'
import {
    markMessageReady,
    waitForTurn,
    isStillMyTurn,
    clearConversationAfterResponse,
    buildCombinedInput,
    getConversationState,
    getCurrentVersion,
    consumeLatestPendingOfType
} from '../helpers/conversationBuffer.js'

 
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
    try {
        const from = ctx.from
        const remoteJid = ctx?.key?.remoteJid ? ctx.key.remoteJid.split('@')[0] : ''
        const remoteJidAlt = ctx?.key?.remoteJidAlt ? ctx.key.remoteJidAlt.split('@')[0] : ''

        if (from && from.length <= 11) return from
        if (remoteJidAlt && remoteJidAlt.length <= 11) return remoteJidAlt
        if (remoteJid && remoteJid.length <= 11) return remoteJid
        return from
    } catch (error) {
        defaultLogger.error('Error extrayendo número', {
            error: error.message,
            stack: error.stack,
            context: ctx,
            action: 'extract_number_error',
            file: 'chatbot.js'
        })
        return ctx.from
    }
}
 
/**
 * Flujo para manejar notas de voz
 * Procesa el audio, lo convierte a texto y genera respuestas
 */
export const voice = addKeyword(EVENTS.VOICE_NOTE)
    // ÚNICO addAction: TODO (validaciones, coordinación, transcripción, espera, IA, enviar) en un solo bloque.
    // Esto evita que BuilderBot encole 2 acciones separadas por usuario y bloquee la llegada de otros flujos.
    .addAction(async (ctx, { state, endFlow, flowDynamic, provider }) => {
        const userId = ctx.key.remoteJid
        const name = ctx?.pushName ?? ''
        const numberPhone = extractNumber(ctx)

        try {
            const { profilePictureUrl } = await getProfilePictureInfo(ctx, provider, {
                userId, numberPhone, name, file: 'voice.js'
            })
            defaultLogger.info('Iniciando procesamiento de nota de voz (único addAction)', {
                userId, numberPhone, name, profilePictureUrl,
                action: 'voice_note_received',
                file: 'voice.js'
            })

            // ================ COORDINACIÓN COMPARTIDA ================
            // REGLA SIMPLIFICADA:
            //   ÚNICAMENTE el listener Baileys inserta en el buffer.
            //   Este flujo solo:
            //     1) lee versión actual global (flowVersion para reclamar turno luego)
            //     2) guarda entryId del ÚLTIMO audio PENDING para marcar READY cuando transcriba.
            const myVersion = getCurrentVersion(numberPhone)
            let pendingAudio = consumeLatestPendingOfType(numberPhone, 'audio')
            const convStateBefore = getConversationState(numberPhone)
            defaultLogger.info('Conversación compartida (audio - solo lectura)', {
                userId, numberPhone, name,
                phoneKey: convStateBefore.phoneKey,
                myVersion,
                pendingAudioEntryId: pendingAudio ? pendingAudio.entryId : null,
                pendingAudioMessageId: pendingAudio ? pendingAudio.messageId : null,
                pendingAudioReceivedAt: pendingAudio && pendingAudio.receivedAt ? new Date(pendingAudio.receivedAt).toISOString() : null,
                currentVersion: convStateBefore.version,
                bufferCount: convStateBefore.bufferCount,
                bufferTypes: convStateBefore.bufferTypes,
                lastActivityAt: convStateBefore.lastActivityAt ? new Date(convStateBefore.lastActivityAt).toISOString() : null,
                action: 'conversation_flow_init_audio',
                file: 'voice.js'
            })
            const cur = state.getMyState() || {}
            await state.update({
                ...cur,
                conversationVersion: myVersion,
                conversationPhoneKey: convStateBefore.phoneKey,
                conversationEntryId: pendingAudio ? pendingAudio.entryId : null
            })
            // =========================================================

            // ============ VALIDACIONES (SOLO UNA VEZ - ya no son 2 veces en 2 acciones) ============
            const isWhitelisted = await getWhatsappWhitelist(numberPhone)
            defaultLogger.info('Verificación de whitelist', {
                userId, numberPhone, name, isWhitelisted,
                action: 'whitelist_verification',
                file: 'voice.js'
            })
            if (isWhitelisted) {
                defaultLogger.info('Usuario en whitelist, finalizando flujo', {
                    userId, numberPhone, name,
                    action: 'whitelist_end_flow',
                    file: 'voice.js'
                })
                return endFlow()
            }

            const botStatus = await whatsappStatus()
            defaultLogger.info('Estado global del bot', {
                userId, numberPhone, name, botStatus,
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

            let userStatus = await getWhatsapp(numberPhone, { name, profilePictureUrl })
            defaultLogger.info('Estado del usuario', {
                userId, numberPhone, name, userStatus,
                action: 'user_status_check',
                file: 'voice.js'
            })
            // Actualizar usuario NUEVO (antes solo se hacía en segunda acción)
            if (!userStatus) {
                userStatus = await putWhatsapp(numberPhone, name, true, profilePictureUrl)
                defaultLogger.info('Nuevo usuario registrado', {
                    userId, numberPhone, name, newUserStatus: userStatus,
                    action: 'new_user_registration',
                    file: 'voice.js'
                })
            }
            if (userStatus && !userStatus.status) {
                defaultLogger.info('Usuario desactivado', {
                    userId, numberPhone, name,
                    action: 'user_disabled_end_flow',
                    file: 'voice.js'
                })
                return endFlow()
            }

            // Check premium plan
            const shouldEndPremium = await checkPremiumPlan(userId, numberPhone, name, provider)
            if (shouldEndPremium) return endFlow()

            // ===== HISTORIAL =====
            const historyGlobalStatus = state.getMyState()?.history ?? []
            if (historyGlobalStatus.length <= 0) {
                const historyDB = await getWhatsappConversation(numberPhone);
                defaultLogger.info('Historial de conversación recuperado de la base de datos', {
                    userId, numberPhone, name,
                    historyLength: historyDB?.length || 0,
                    action: 'history_db_retrieved',
                    file: 'voice.js'
                })
                defaultLogger.info('Estado actualizado con el historial de conversación', {
                    userId, numberPhone, name,
                    action: 'history_state_updated',
                    file: 'voice.js'
                })
                await state.update({ history: historyDB })
            }

            // 1. Enviar estado "escribiendo"
            await provider.vendor.sendPresenceUpdate('composing', ctx.key.remoteJid)

            defaultLogger.info('Iniciando etapa de transcripción y respuesta (audio - único addAction)', {
                userId, numberPhone, name, profilePictureUrl,
                action: 'audio_response_stage_start',
                file: 'voice.js'
            })

            // ===== CONVERTIR AUDIO A TEXTO =====
            const transcribedText = await handlerAI(ctx, provider, numberPhone)
            defaultLogger.info('Audio transcrito', {
                userId, numberPhone, name, transcribedText,
                action: 'audio_transcription',
                file: 'voice.js'
            })
            if (transcribedText === "ERROR") {
                await provider.sendMessage(numberPhone, "Disculpa, no entendí tu mensaje. Por favor, puedes enviarlo de nuevo.", { media: null })
                return endFlow()
            }

            // ================ COORDINACIÓN COMPARTIDA: MARCAR AUDIO READY ================
            // Re-leer entryId desde state (última fuente verdad) o fallback consumeLatestPendingOfType.
            const myState = state.getMyState() || {}
            const flowVersion = Number(myState.conversationVersion || myVersion || 0)
            let myEntryId = myState.conversationEntryId || null
            if (!myEntryId || flowVersion > 0) {
                const fallbackAudio = consumeLatestPendingOfType(numberPhone, 'audio')
                if (fallbackAudio && fallbackAudio.entryId) {
                    if (!myEntryId) myEntryId = fallbackAudio.entryId
                    pendingAudio = fallbackAudio  // actualizar por si la primera llamada (arriba) cogió uno antiguo
                }
            }
            defaultLogger.info('Voz marcar READY audio transcrito', {
                userId, numberPhone, name,
                flowVersion, myEntryId,
                storedVersion: myState.conversationVersion,
                storedEntryId: myState.conversationEntryId,
                pendingAudioEntryId: pendingAudio ? pendingAudio.entryId : null,
                action: 'conversation_voice_ready',
                file: 'voice.js'
            })
            if (flowVersion > 0 && myEntryId) {
                markMessageReady(numberPhone, myEntryId, {
                    content: transcribedText,
                    file: 'voice.js'
                })
            }
            // ==========================================================

            // Alarma user-side
            const shouldEndFlow = await processAlarm(ctx, numberPhone, name, provider, transcribedText, transcribedText, "user")
            if (shouldEndFlow) return endFlow()

            if (flowVersion <= 0) {
                // ====== CAMINO LEGACY (sin coordinación compartida) =====
                const newHistory = (state.getMyState()?.history ?? []).slice()
                newHistory.push({ role: 'user', content: transcribedText })
                defaultLogger.info('Procesando mensajes acumulados (legacy audio)', {
                    userId, numberPhone, name, transcribedText,
                    history: newHistory, action: 'processing_messages_legacy', file: 'voice.js'
                })
                const response = await run(name, newHistory, transcribedText, numberPhone)
                defaultLogger.info('Respuesta del modelo obtenida (legacy audio)', {
                    userId, numberPhone, name, modelResponse: response,
                    action: 'model_response', file: 'voice.js'
                })
                const shouldEndFlow2 = await processAlarm(ctx, numberPhone, name, provider, response, transcribedText, "IA")
                if (shouldEndFlow2) return endFlow()
                // ✅ MARCAR LEÍDO SÓLO AQUÍ (después de run + alarm IA, antes de enviar respuesta)
                try { await provider.vendor.readMessages([ctx.key]) } catch (_) {}
                await respondAndFinalize(response, transcribedText, name, numberPhone, userId, ctx, provider, flowDynamic, state)
                return null
            }

            // ====== CAMINO COORDINADO ======
            // Esperar turno (45s silencio + todos listos + yo soy última versión)
            const turn = await waitForTurn(numberPhone, {
                flowVersion,
                flowType: 'audio',
                flowId: `audio_${myEntryId || ''}`,
                file: 'voice.js'
            })
            if (!turn.acquired) {
                defaultLogger.info('Flujo audio cede turno (invalidado)', {
                    userId, numberPhone, name,
                    flowVersion,
                    finalVersion: turn.finalVersion,
                    cancelReason: turn.cancelReason,
                    action: 'conversation_audio_cede',
                    file: 'voice.js'
                })
                return endFlow()
            }

            const combinedInput = turn.combinedInput || transcribedText

            const newHistory = (state.getMyState()?.history ?? []).slice()
            newHistory.push({ role: 'user', content: combinedInput })

            defaultLogger.info('Procesando mensajes acumulados (coordinación audio)', {
                userId, numberPhone, name,
                flowVersion,
                combinedInput,
                combinedLength: String(combinedInput).length,
                historyLength: newHistory.length,
                action: 'processing_messages_shared_audio',
                file: 'voice.js'
            })

            defaultLogger.info('Inicio consulta IA (audio, coordinado)', {
                userId, numberPhone, name,
                flowVersion,
                combinedLength: String(combinedInput).length,
                action: 'conversation_ai_request_start',
                file: 'voice.js'
            })
            const response = await run(name, newHistory, combinedInput, numberPhone)
            defaultLogger.info('Respuesta del modelo obtenida (audio, coordinado)', {
                userId, numberPhone, name,
                flowVersion,
                modelResponse: response,
                action: 'conversation_ai_response_done',
                file: 'voice.js'
            })

            if (!isStillMyTurn(numberPhone, { flowVersion, file: 'voice.js' })) {
                defaultLogger.info('Segunda validación falló (audio): llegó otro mensaje durante IA', {
                    userId, numberPhone, name,
                    flowVersion,
                    action: 'conversation_audio_post_ai_invalid',
                    file: 'voice.js'
                })
                return endFlow()
            }

            const shouldEndFlow2 = await processAlarm(ctx, numberPhone, name, provider, response, transcribedText, "IA")
            if (shouldEndFlow2) return endFlow()

            // ✅ MARCAR LEÍDO SÓLO AQUÍ (después de run + isStillMyTurn + alarm IA, antes de enviar respuesta)
            try { await provider.vendor.readMessages([ctx.key]) } catch (_) {}

            await respondAndFinalize(response, combinedInput, name, numberPhone, userId, ctx, provider, flowDynamic, state, flowVersion)

        } catch (error) {
            defaultLogger.error('Error en flujo audio (único addAction)', {
                userId, numberPhone, name,
                error: error.message,
                stack: error.stack,
                context: ctx,
                file: 'voice.js'
            })
            return endFlow()
        } finally {
            try {
                // ✅ SÓLO presence paused + sleep (quitamos readMessages de aquí para no marcar sin responder)
                await new Promise(resolve => setTimeout(resolve, 5000));
                await provider.vendor.sendPresenceUpdate('paused', ctx.key.remoteJid)
            } catch (_) { /* no-op */ }
        }
    })


const respondAndFinalize = async (response, combinedMessages, name, numberPhone, userId, ctx, provider, flowDynamic, state, flowVersion) => {
    const st = state.getMyState() || {}
    const newHistory = (st.history ?? []).slice()

    // Duplicado IA
    if (newHistory.length >= 2 &&
        newHistory[newHistory.length - 2].role === 'assistant' &&
        newHistory[newHistory.length - 2].content === response) {
        defaultLogger.info('Mensaje duplicado OpenIA (voice), ignorando...', {
            userId, numberPhone, name,
            action: 'duplicate_message_openia',
            file: 'voice.js'
        })
        return { duplicated: true }
    }

    // Orden "datos recibidos"
    if (response.toLowerCase().includes("datos recibidos")) {
        const whatsappPrompt = await promptGetWhatsapp(combinedMessages);
        if (whatsappPrompt.products_dynamic) {
            const updatePrompt = await runUpdatePromptServicesProduct(response);
            defaultLogger.info('Prompt actualizado (voice)', {
                userId, numberPhone, name, updatePrompt,
                action: 'update_prompt_complete', file: 'voice.js'
            });
            const responseUpdateProductWhatsapp = await promptUpdateProductWhatsapp(updatePrompt);
            defaultLogger.info('Respuesta de actualización de producto prompt (voice)', {
                userId, numberPhone, name, responseUpdateProductWhatsapp,
                action: 'product_update_response', file: 'voice.js'
            });
        }
        const orderConfirmation = await putWhatsappOrderConfirmation(name, numberPhone, response, "pending_payment")
        defaultLogger.info('Orden procesada (voice)', {
            userId, numberPhone, name, response, orderConfirmation,
            action: 'order_processing', file: 'voice.js'
        })
    }

    defaultLogger.info('Enviando respuesta final al usuario (voice)', {
        numberPhone, userId,
        responseLength: String(response).length,
        flowVersion: flowVersion !== undefined ? flowVersion : 'legacy',
        responsePreview: String(response).slice(0, 200),
        action: flowVersion !== undefined ? 'conversation_audio_response_sending' : 'response_sending',
        file: 'voice.js'
    })

    if (numberPhone.length <= 11) {
        await provider.sendMessage(numberPhone, response, { media: null })
    } else {
        await flowDynamic(response)
    }

    if (newHistory.length === 0 || newHistory[newHistory.length - 1].role !== 'user' || newHistory[newHistory.length - 1].content !== combinedMessages) {
        newHistory.push({ role: 'user', content: combinedMessages })
    }
    newHistory.push({ role: 'assistant', content: response })
    if (newHistory.length > 20) newHistory.splice(0, 2)
    await state.update({ history: newHistory })

    if (flowVersion !== undefined) {
        clearConversationAfterResponse(numberPhone, {
            finalVersion: flowVersion,
            file: 'voice.js'
        })
    }

    defaultLogger.info('Respuesta enviada correctamente (voice)', {
        numberPhone, userId,
        flowVersion: flowVersion !== undefined ? flowVersion : 'legacy',
        historyLength: newHistory.length,
        action: flowVersion !== undefined ? 'conversation_audio_response_sent' : 'response_sent',
        file: 'voice.js'
    })
    return { ok: true }
}

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
