import { addKeyword, EVENTS } from '@builderbot/bot'
import { run, runUpdatePromptServicesProduct } from '../services/openai/index.js'
import {
    getWhatsapp,
    putWhatsapp,
    whatsappStatus,
    regexAlarm,
    putWhatsappEmailVendor,
    putWhatsappOrderConfirmation,
    getWhatsappWhitelist,
    promptUpdateProductWhatsapp,
    promptGetWhatsapp,
    getWhatsappConversation,
    postWhatsappConversation
} from '../services/aws/index.js'

import { defaultLogger } from '../helpers/cloudWatchLogger.js'
import { getProfilePictureInfo } from '../helpers/whatsappProfile.js'
import {
    markMessageReady,
    waitForTurn,
    isStillMyTurn,
    clearConversationAfterResponse,
    buildCombinedInput,
    getConversationState,
    getCurrentVersion
} from '../helpers/conversationBuffer.js'

// Constantes de configuración
let TIMEOUT_MS = 45000 // Tiempo de espera aleatorio entre 45-60 segundos

// Almacenamiento en memoria para gestionar mensajes de usuarios
const userBuffers = {} // Buffer de mensajes por usuario
const userTimeouts = {} // Timeouts por usuario

/**
 * Función auxiliar para pausar la ejecución
 * @param {number} ms - Milisegundos a esperar
 * @returns {Promise} Promesa que se resuelve después del tiempo especificado
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))


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
 * Flujo principal del chatbot que maneja la conversación por defecto
 * cuando no hay coincidencias con palabras clave
 */
export const chatbot = addKeyword(EVENTS.WELCOME)
    // ÚNICO addAction: TODO (validaciones, coordinación, espera, IA, enviar) en un solo bloque.
    // Esto evita que BuilderBot encole 2 acciones por usuario separadas (la primera tardando 10s
    // en whitelist/DB y el audio NI ENTRA hasta que termina todo el flujo).
    .addAction(async (ctx, { state, endFlow, flowDynamic, provider }) => {
        try {
            const userId = ctx.key.remoteJid
            const numberPhone = extractNumber(ctx)
            const name = ctx?.pushName ?? ''
            const { profilePictureJid, profilePictureUrl } = await getProfilePictureInfo(ctx, provider, {
                userId,
                numberPhone,
                name,
                file: 'chatbot.js'
            })

            defaultLogger.info('Ctx received', {
                    userId,
                    numberPhone,
                    name,
                    profilePictureJid,
                    profilePictureUrl,
                    messageBody: 'ctx',
                    ctx: ctx,
                    action: 'ctx_received',
                    file: 'chatbot.js'
            })

            if(hasOnlyEmoji(ctx.body)){
                defaultLogger.info('No responder usuario envio solo Emoji', {
                    userId,
                    numberPhone,
                    name,
                    action: 'hasOnlyEmoji',
                    file: 'chatbot.js'
                })
                return endFlow()
            }

            defaultLogger.info('Iniciando procesamiento de mensaje (texto - unico addAction)', {
                userId,
                numberPhone,
                name,
                messageBody: ctx.body,
                action: 'message_received',
                timestamp: new Date().toISOString(),
                file: 'chatbot.js'
            })

            // ================ COORDINACIÓN COMPARTIDA ================
            // REGLA SIMPLIFICADA:
            //   ÚNICAMENTE el listener Baileys PRE-BuilderBot inserta mensajes.
            //   Este flujo solo LEER la versión actual → esta será su flowVersion.
            const myVersion = getCurrentVersion(numberPhone)
            const convStateBefore = getConversationState(numberPhone)
            defaultLogger.info('Conversación compartida (texto - solo lectura)', {
                userId,
                numberPhone,
                name,
                phoneKey: convStateBefore.phoneKey,
                myVersion,
                currentVersion: convStateBefore.version,
                bufferCount: convStateBefore.bufferCount,
                bufferTypes: convStateBefore.bufferTypes,
                lastActivityAt: convStateBefore.lastActivityAt ? new Date(convStateBefore.lastActivityAt).toISOString() : null,
                action: 'conversation_flow_init_text',
                file: 'chatbot.js'
            })
            const curr = state.getMyState() || {}
            await state.update({
                ...curr,
                conversationVersion: myVersion,
                conversationPhoneKey: convStateBefore.phoneKey
            })
            // =========================================================

            // Inicializar buffer de mensajes si no existe (legacy fallback)
            if (!userBuffers[userId]) userBuffers[userId] = []
            // Evitar duplicados legacy
            if (userBuffers[userId].indexOf(ctx.body) !== -1) {
                defaultLogger.info('Mensaje duplicado (legacy buffer), ignorando...', {
                    userId, numberPhone, name,
                    action: 'duplicate_message',
                    file: 'chatbot.js'
                })
                return endFlow()
            }
            userBuffers[userId].push(ctx.body)

            // Reiniciar timeout legacy
            if (userTimeouts[userId]) clearTimeout(userTimeouts[userId])

            // ============ VALIDACIONES (SOLO UNA VEZ - ya no son duplicadas) ============
            const isWhitelisted = await getWhatsappWhitelist(numberPhone)
            defaultLogger.info('Verificación de whitelist', {
                userId, numberPhone, name, isWhitelisted,
                action: 'whitelist_verification',
                file: 'chatbot.js'
            })
            if (isWhitelisted) {
                userBuffers[userId] = []
                defaultLogger.info('Usuario en whitelist, finalizando flujo', {
                    userId, numberPhone, name,
                    action: 'whitelist_end_flow',
                    file: 'chatbot.js'
                })
                return endFlow()
            }

            const botStatus = await whatsappStatus()
            defaultLogger.info('Estado global del bot', {
                userId, numberPhone, name, botStatus,
                action: 'global_status_check',
                file: 'chatbot.js'
            })
            if (botStatus && !botStatus.status) {
                userBuffers[userId] = []
                await postWhatsappConversation(numberPhone, ctx.body, "")
                defaultLogger.info('Bot desactivado globalmente', {
                    action: 'global_status_end_flow',
                    file: 'chatbot.js'
                })
                return endFlow()
            }

            let userStatus = await getWhatsapp(numberPhone, { name, profilePictureUrl })
            defaultLogger.info('Estado del usuario', {
                userId, numberPhone, name, userStatus,
                action: 'user_status_check',
                file: 'chatbot.js'
            })

             if (userStatus && !userStatus.status) {
                userBuffers[userId] = []
                await postWhatsappConversation(numberPhone, ctx.body, "")
                defaultLogger.info('Usuario desactivado', {
                    userId, numberPhone, name,
                    action: 'user_disabled_end_flow',
                    file: 'chatbot.js'
                })
                return endFlow()
            }

            // Actualizar usuario si es NUEVO (antes solo se hacía en segunda acción)
            if (!userStatus) {
                 await putWhatsapp(numberPhone, name, true, profilePictureUrl)
                defaultLogger.info('Nuevo usuario registrado', {
                    userId, numberPhone, name, newUserStatus: userStatus,
                    action: 'new_user_registration',
                    file: 'chatbot.js'
                })
            }
           

            // Alarma
            const shouldEndFlow = await processAlarm(ctx, numberPhone, name, provider, ctx.body, "user")
            if (shouldEndFlow) return endFlow()

            // TIMEOUT_MS random entre 30-45s (solo para legacy fallback cuando conversationVersion <= 0)
            TIMEOUT_MS = Math.floor(Math.random() * (60000 - 45000 + 1) + 45000)

            // ===== HISTORIAL =====
            const historyGlobalStatus = state.getMyState()?.history ?? []
            if (historyGlobalStatus.length <= 0) {
                const historyDB = await getWhatsappConversation(numberPhone);
                defaultLogger.info('Historial de conversación recuperado de la base de datos', {
                    userId, numberPhone, name,
                    historyLength: historyDB?.length || 0,
                    action: 'history_db_retrieved',
                    file: 'chatbot.js'
                })
                defaultLogger.info('Estado actualizado con el historial de conversación', {
                    userId, numberPhone, name,
                    action: 'history_state_updated',
                    file: 'chatbot.js'
                })
                await state.update({ history: historyDB })
            }

            // 1. Enviar estado "escribiendo"
            await provider.vendor.sendPresenceUpdate('composing', ctx.key.remoteJid)

            // =================== PROCESAR RESPUESTA (antes "segunda acción") ===================
            defaultLogger.info('Iniciando etapa de respuesta (texto - único addAction)', {
                userId, numberPhone, name, messageBody: ctx.body,
                action: 'response_stage_start',
                file: 'chatbot.js'
            })

            if (myVersion <= 0) {
                // ---- LEGACY FALLBACK (sin coordinación) ----
                userTimeouts[userId] = setTimeout(async () => {
                    const combinedMessages = userBuffers[userId].join(' ')
                    userBuffers[userId] = []
                    const newHistory = (state.getMyState()?.history ?? [])
                    newHistory.push({ role: 'user', content: combinedMessages })
                    defaultLogger.info('Procesando mensajes acumulados (legacy fallback texto)', {
                        userId, numberPhone, name, combinedMessages, history: newHistory,
                        action: 'processing_messages_legacy',
                        file: 'chatbot.js'
                    })
                    const response = await run(name, newHistory, combinedMessages, numberPhone)
                    // ✅ MARCAR LEÍDO SÓLO AQUÍ (después de IA, antes de enviar respuesta)
                    try { await provider.vendor.readMessages([ctx.key]) } catch (_) {}
                    await respondAndFinalize(response, combinedMessages, name, numberPhone, userId, ctx, provider, flowDynamic, state)
                }, TIMEOUT_MS)
            } else {
                // ===== COORDINACIÓN COMPARTIDA (polling con waitForTurn) =====
                const myState = state.getMyState() || {}
                const flowVersion = Number(myState.conversationVersion || myVersion || 0)
                const myEntryId = myState.conversationEntryId || null

                const turn = await waitForTurn(numberPhone, {
                    flowVersion,
                    flowType: 'text',
                    flowId: `text_${myEntryId || ''}`,
                    file: 'chatbot.js'
                })
                if (!turn.acquired) {
                    defaultLogger.info('Flujo texto cede turno (invalidado)', {
                        userId, numberPhone, name,
                        flowVersion,
                        finalVersion: turn.finalVersion,
                        cancelReason: turn.cancelReason,
                        action: 'conversation_text_cede',
                        file: 'chatbot.js'
                    })
                    userBuffers[userId] = []
                    if (userTimeouts[userId]) { clearTimeout(userTimeouts[userId]); userTimeouts[userId] = null }
                    return endFlow()
                }

                const combinedInput = turn.combinedInput || userBuffers[userId].join(' ')
                userBuffers[userId] = []
                if (userTimeouts[userId]) { clearTimeout(userTimeouts[userId]); userTimeouts[userId] = null }

                const newHistory = (state.getMyState()?.history ?? [])
                newHistory.push({ role: 'user', content: combinedInput })

                defaultLogger.info('Procesando mensajes acumulados (coordinación compartida texto)', {
                    userId, numberPhone, name,
                    flowVersion,
                    combinedInput,
                    combinedLength: String(combinedInput).length,
                    historyLength: newHistory.length,
                    action: 'processing_messages_shared_text',
                    file: 'chatbot.js'
                })

                defaultLogger.info('Inicio consulta IA (texto, coordinado)', {
                    userId, numberPhone, name,
                    flowVersion,
                    combinedLength: String(combinedInput).length,
                    action: 'conversation_ai_request_start',
                    file: 'chatbot.js'
                })
                const response = await run(name, newHistory, combinedInput, numberPhone)
                defaultLogger.info('Respuesta del modelo obtenida (texto, coordinado)', {
                    userId, numberPhone, name,
                    flowVersion,
                    modelResponse: response,
                    action: 'conversation_ai_response_done',
                    file: 'chatbot.js'
                })

                // ===== SEGUNDA VALIDACIÓN POST-IA =====
                if (!isStillMyTurn(numberPhone, { flowVersion, file: 'chatbot.js' })) {
                    defaultLogger.info('Segunda validación falló (texto): llegó otro mensaje durante IA', {
                        userId, numberPhone, name,
                        flowVersion,
                        action: 'conversation_text_post_ai_invalid',
                        file: 'chatbot.js'
                    })
                    return endFlow()
                }

                // ✅ MARCAR LEÍDO SÓLO AQUÍ (después de run + isStillMyTurn, antes de enviar respuesta)
                try { await provider.vendor.readMessages([ctx.key]) } catch (_) {}

                await respondAndFinalize(response, combinedInput, name, numberPhone, userId, ctx, provider, flowDynamic, state, flowVersion)
            }
        } catch (error) {
            defaultLogger.error('Error en flujo texto (único addAction)', {
                userId: ctx.key.remoteJid,
                numberPhone: ctx.host,
                name: ctx?.pushName,
                error: error.message,
                stack: error.stack,
                context: ctx,
                file: 'chatbot.js'
            })
        } finally {
            try {
                // ✅ SÓLO presence paused + sleep (quitamos readMessages de aquí para no marcar sin responder)
                await new Promise(resolve => setTimeout(resolve, 5000));
                await provider.vendor.sendPresenceUpdate('paused', ctx.key.remoteJid)
            } catch (_) { /* no-op: vendor puede estar desconectado */ }
        }
    })


const displayFile = async (whatsappPrompt, provider,numberPhone) => {
    try{
    const hasValidMenuUrl = whatsappPrompt.url_menu &&
        whatsappPrompt.url_menu !== "" &&
        whatsappPrompt.url_menu !== "NA"
    if (hasValidMenuUrl) {
        await provider.sendMessage(numberPhone, "", { media: whatsappPrompt.url_menu })
    }
    } catch (error) {
        defaultLogger.error('Error en displayFile', {
            numberPhone: numberPhone,
            error: error.message,
            stack: error.stack,
            action: 'displayFile_error',
            file: 'chatbot.js'
        })
    }
}

/**
 * Función común: enviar respuesta al usuario, procesar orden si detecta "datos recibidos",
 * actualizar historial, enviar saludo/menú si corresponde, y SOLO AL FINAL limpiar buffer.
 * @param {number|undefined} flowVersion Si está presente, se usa para 2ª validación y limpieza coordinada.
 */
const respondAndFinalize = async (response, combinedMessages, name, numberPhone, userId, ctx, provider, flowDynamic, state, flowVersion) => {
    const st = state.getMyState() || {}
    const newHistory = (st.history ?? []).slice()

    // Chequear duplicado IA
    if (newHistory.length >= 2 &&
        newHistory[newHistory.length - 2].role === 'assistant' &&
        newHistory[newHistory.length - 2].content === response) {
        defaultLogger.info('Mensaje duplicado OpenIA, ignorando...', {
            userId, numberPhone, name,
            action: 'duplicate_message_openia',
            file: 'chatbot.js'
        })
        if (flowVersion !== undefined) {
            defaultLogger.info('(Coordinado) Flujo se detiene por duplicado pero NO limpia buffer', {
                flowVersion, numberPhone, action: 'conversation_text_duplicate_no_clear', file: 'chatbot.js'
            })
        }
        return { duplicated: true }
    }

    // Alarm IA
    const shouldEndFlow = await processAlarm(ctx, numberPhone, name, provider, response, "IA")
    if (shouldEndFlow) return { alarm: true }

    // Procesar orden "datos recibidos"
    if (response.toLowerCase().includes("datos recibidos")) {
        const whatsappPrompt = await promptGetWhatsapp(combinedMessages);
        if (whatsappPrompt.products_dynamic) {
            const updatePrompt = await runUpdatePromptServicesProduct(response);
            defaultLogger.info('Prompt actualizado', {
                userId, numberPhone, name, updatePrompt,
                action: 'update_prompt_complete', file: 'chatbot.js'
            });
            const responseUpdateProductWhatsapp = await promptUpdateProductWhatsapp(updatePrompt);
            defaultLogger.info('Respuesta de actualización de producto prompt', {
                userId, numberPhone, name, responseUpdateProductWhatsapp,
                action: 'product_update_response', file: 'chatbot.js'
            });
        }
        const orderConfirmation = await putWhatsappOrderConfirmation(name, numberPhone, response, "pending_payment")
        defaultLogger.info('Orden procesada', {
            userId, numberPhone, name, response, orderConfirmation,
            action: 'order_processing', file: 'chatbot.js'
        })
        await putWhatsapp(numberPhone, name, false)
    }

    // Saludo / menú
    const greetings = ['hola', 'como esta', 'buenos dias', 'buenas tardes', 'buenas noches']
    if (greetings.some(greeting => String(ctx.body || '').toLowerCase().includes(greeting))) {
        const whatsappPrompt = await promptGetWhatsapp(String(ctx.body || '').toLowerCase().trim())
        await displayFile(whatsappPrompt, provider, numberPhone)
    }

    defaultLogger.info('Enviando respuesta final al usuario', {
        numberPhone,
        userId,
        responseLength: String(response).length,
        flowVersion: flowVersion !== undefined ? flowVersion : 'legacy',
        responsePreview: String(response).slice(0, 200),
        action: flowVersion !== undefined ? 'conversation_text_response_sending' : 'response_sending',
        file: 'chatbot.js'
    })

    // Enviar respuesta
    if (numberPhone.length <= 11) {
        defaultLogger.info('Enviando chunk por provider.sendMessage', {
            numberPhone, numberPhoneLength: numberPhone.length, chunk: response,
            file: 'chatbot.js'
        })
        await provider.sendMessage(numberPhone, response, { media: null })
    } else {
        defaultLogger.info('Enviando chunk por flowDynamic', {
            numberPhone, numberPhoneLength: numberPhone.length, chunk: response,
            file: 'chatbot.js'
        })
        await flowDynamic(response)
    }

    // Actualizar historial (role assistant)
    // Asegurar que el role user ya está (en legacy no lo garantizamos pero aquí lo hacemos)
    if (newHistory.length === 0 || newHistory[newHistory.length - 1].role !== 'user' || newHistory[newHistory.length - 1].content !== combinedMessages) {
        newHistory.push({ role: 'user', content: combinedMessages })
    }
    newHistory.push({ role: 'assistant', content: response })
    if (newHistory.length > 20) newHistory.splice(0, 2)
    await state.update({ history: newHistory })

    // ============== LIMPIAR BUFFER COORDINADO (solo después de enviar OK) ==============
    if (flowVersion !== undefined) {
        clearConversationAfterResponse(numberPhone, {
            finalVersion: flowVersion,
            file: 'chatbot.js'
        })
    }

    defaultLogger.info('Respuesta enviada correctamente', {
        numberPhone,
        userId,
        flowVersion: flowVersion !== undefined ? flowVersion : 'legacy',
        historyLength: newHistory.length,
        action: flowVersion !== undefined ? 'conversation_text_response_sent' : 'response_sent',
        file: 'chatbot.js'
    })

    return { ok: true }
}

function hasOnlyEmoji(str) {
    // Eliminar espacios por si el usuario pone espacios antes o después
    const texto = str.trim();
  
    // Verifica que la longitud del string en puntos de código sea 1
    const codePoints = [...texto];
    if (codePoints.length !== 1) return false;
  
    // Obtener el código Unicode del único carácter
    const code = codePoints[0].codePointAt(0);
  
    // Rango básico de emojis (puedes ampliarlo si necesitas más cobertura)
    return (
      (code >= 0x1F600 && code <= 0x1F64F) || // Emoticonos
      (code >= 0x1F300 && code <= 0x1F5FF) || // Símbolos y pictogramas
      (code >= 0x1F680 && code <= 0x1F6FF) || // Transporte/mapas
      (code >= 0x1F1E6 && code <= 0x1F1FF) || // Banderas
      (code >= 0x2600 && code <= 0x26FF) ||   // Símbolos diversos
      (code >= 0x2700 && code <= 0x27BF) ||   // Otros símbolos
      (code >= 0x1F900 && code <= 0x1F9FF) || // Emoji adicionales
      (code >= 0x1FA70 && code <= 0x1FAFF)    // Emoji nuevos
    );
  }

// Process alarms through dedicated method
const processAlarm = async (ctx, numberPhone, name, provider, question, UserOrIA) => {
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

        if (UserOrIA === "user") {
            await postWhatsappConversation(numberPhone, question, "");
        } /*else {
            await postWhatsappConversation(numberPhone, "", question);
        }*/
        
        const alarmResponse = await putWhatsappEmailVendor(numberPhone, name, ctx.body)
        defaultLogger.info('Procesamiento de alarma', {
            numberPhone,
            name,
            message: ctx.body,
            alarmResponse,
            action: 'alarm_processing',
            file: 'chatbot.js'
        })

        const message = UserOrIA === "user" ? "Gracias por tu mensaje. En breve nos pondremos en contacto contigo." : question

        const responseMessage = alarmResponse
            ? message
            : "Lo sentimos, pero no tenemos personal disponible en este momento."

        await provider.sendMessage(numberPhone,responseMessage, { media: null})

        await putWhatsapp(numberPhone, name, false)
        return true
    }
    return false
}
