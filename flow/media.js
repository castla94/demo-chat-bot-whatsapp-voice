import { addKeyword, EVENTS } from '@builderbot/bot';
import { run } from '../services/openai/index.js';
import {
    getWhatsappConversation,
    putWhatsappEmailVendor,
    getWhatsapp,
    whatsappStatus,
    getWhatsappWhitelist,
    getWhatsappPlanPremiun,
    putWhatsapp,
    regexAlarm,
    postWhatsappConversation
} from '../services/aws/index.js';
import fs from "fs";
import { defaultLogger } from '../helpers/cloudWatchLogger.js';
import { processImage } from "../services/image/index.js";
import { getProfilePictureInfo } from '../helpers/whatsappProfile.js';
import {
    markMessageReady,
    waitForTurn,
    isStillMyTurn,
    clearConversationAfterResponse,
    getConversationState,
    getCurrentVersion,
    consumeLatestPendingOfType,
    waitForMyMessageEntryInBuffer,
    isRafagaVivaActive
} from '../helpers/conversationBuffer.js';


/**
 * Función auxiliar para pausar la ejecución
 * @param {number} ms - Milisegundos a esperar
 * @returns {Promise} Promesa que se resuelve después del tiempo especificado
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

// ============================================================
// KEEP-ALIVE DE PRESENCIA ("escribiendo…")
// ============================================================
// WhatsApp Baileys borra el estado "composing" tras ~15s de inactividad.
// Refrescamos cada PRESENCE_REFRESH_MS hasta stop().
// ============================================================
const PRESENCE_REFRESH_MS = 10 * 1000
const startPresenceKeepAlive = (provider, jid, { presenceType = 'composing', file = 'media.js' } = {}) => {
    let stopped = false
    let refreshTimer = null
    const fireAndForgetSend = () => {
        if (stopped || !provider || !provider?.vendor?.sendPresenceUpdate || !jid) return
        ;(async () => {
            try {
                await provider.vendor.sendPresenceUpdate(presenceType, jid)
                defaultLogger.debug('Presence keep-alive reenviado (media flow)', {
                    jid, presenceType,
                    action: 'presence_keepalive_refresh',
                    file
                })
            } catch (e) {
                defaultLogger.debug('Presence keep-alive error silencioso (media flow)', {
                    jid, presenceType,
                    error: e?.message || String(e),
                    action: 'presence_keepalive_error_swallowed',
                    file
                })
            }
        })()
    }
    fireAndForgetSend()
    refreshTimer = setInterval(fireAndForgetSend, PRESENCE_REFRESH_MS)
    const stop = async () => {
        if (stopped) return
        stopped = true
        if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
        try {
            if (provider?.vendor?.sendPresenceUpdate && jid) {
                await provider.vendor.sendPresenceUpdate('paused', jid)
                defaultLogger.debug('Presence keep-alive detenido → paused (media flow)', {
                    jid, presenceType,
                    action: 'presence_keepalive_stopped',
                    file
                })
            }
        } catch (_) {}
    }
    return { stop }
}

// ============================================================
// MENSAJE GENÉRICO FIJO: cuando NO se puede descargar/procesar imagen.
// Texto EXACTO requerido por negocio:
//   "Disculpa, no logré descargar la imagen 😔. ¿Puedes enviármela nuevamente?"
// ============================================================
const IMAGE_DOWNLOAD_ERROR_MSG = 'Disculpa, no logré descargar la imagen 😔. ¿Puedes enviármela nuevamente?'

// ============================================================
// Helper: ENVÍA SEGURO (chunks, numberPhone largo gswa usa flowDynamic).
// ============================================================
const sendReplySafe = async (numberPhone, provider, flowDynamic, text) => {
    try {
        if (!text || !String(text).trim()) return
        if (String(numberPhone || '').length <= 11) {
            await provider.sendMessage(numberPhone, text, { media: null })
        } else {
            await flowDynamic(text)
        }
    } catch (err) {
        defaultLogger.debug('sendReplySafe error silencioso', {
            numberPhone, length: String(text || '').length,
            error: err?.message || String(err),
            action: 'image_send_reply_safe_swallowed', file: 'media.js'
        })
    }
}

// ============================================================
// Helper: procesar caption solo como TEXTO (sin imagen).
// Usado cuando:
//   - imagen throttled PERO tiene caption (NO SILENCIAR caption).
//   - imagen no se pudo descargar Y tiene caption.
//   - imagen corrupta Y tiene caption.
//
// Flujo interno:
//   1. Cargar historial (igual que chatbot).
//   2. Lanzar run(caption).
//   3. Enviar respuesta + actualizar historial + limpiar presence safe.
//
// Nota: NO toca waitForTurn/coordinación. Va por LEGACY directo (como
// chatbot fallback myVersion<=0). Así no espera polling innecesario.
// El usuario SIEMPRE recibe respuesta a su caption.
// Retorna: listo para hacer return endFlow() desde afuera.
// ============================================================
const runCaptionOnlyAsText = async ({
    captionRaw, ctx, numberPhone, userId, name, provider, flowDynamic, state,
    presence
}) => {
    const caption = String(captionRaw || '').trim()
    if (!caption) {
        defaultLogger.debug('runCaptionOnlyAsText llamado sin caption. No-op.', {
            userId, numberPhone,
            action: 'image_caption_only_empty_skip', file: 'media.js'
        })
        return
    }
    defaultLogger.info('Imagen omitida → procesando caption como TEXTO puro (LEGACY directo).', {
        userId, numberPhone, name,
        captionLength: caption.length,
        captionPreview: caption.slice(0, 120),
        action: 'image_caption_only_run_start',
        file: 'media.js'
    })
    // Presence keep-alive si existe el objeto (los caminos de saveFile / throttle
    // post-L418 ya lo crearon; el camino throttle temprano no lo tiene).
    if (!presence) {
        try {
            if (provider?.vendor?.sendPresenceUpdate && ctx?.key?.remoteJid) {
                await provider.vendor.sendPresenceUpdate('composing', ctx.key.remoteJid).catch(() => {})
            }
        } catch (_) {}
    }
    const stopPresenceSafeCaption = async () => {
        try { await new Promise(resolve => setTimeout(resolve, 3000)) } catch (_) {}
        try {
            if (presence && typeof presence.stop === 'function') await presence.stop().catch(() => {})
            else if (provider?.vendor?.sendPresenceUpdate && ctx?.key?.remoteJid) {
                await provider.vendor.sendPresenceUpdate('paused', ctx.key.remoteJid).catch(() => {})
            }
        } catch (_) {}
    }
    try {
        // Pre-cargar historial igual que chatbot/legacy.
        const stBefore = state.getMyState() || {}
        const historyBefore = Array.isArray(stBefore.history) ? stBefore.history.slice() : []
        let historyForRun = historyBefore
        if (historyForRun.length === 0) {
            try {
                const dbHistory = await getWhatsappConversation(numberPhone)
                if (Array.isArray(dbHistory) && dbHistory.length > 0) {
                    historyForRun = dbHistory.slice()
                    await state.update({ ...stBefore, history: historyForRun }).catch(() => {})
                    defaultLogger.info('Caption-only: historial cargado desde DB', {
                        userId, numberPhone, name, len: historyForRun.length,
                        action: 'image_caption_only_history_loaded', file: 'media.js'
                    })
                }
            } catch (_dbErr) { /* no-op: usar [] */ }
        }
        const userContent = `El usuario envió una imagen que no fue procesada. Su texto (caption) es: "${caption}". Responde directamente a este texto como si fuera un mensaje normal.`
        const newHistory = historyForRun.slice()
        newHistory.push({ role: 'user', content: userContent })
        defaultLogger.info('Caption-only: inicio llamada IA run(caption)', {
            userId, numberPhone, name,
            historyLength: newHistory.length,
            action: 'image_caption_only_ia_start',
            file: 'media.js'
        })
        const response = await run(name, newHistory, userContent, numberPhone, null)
        defaultLogger.info('Caption-only: Respuesta del modelo obtenida. ENVIAR SIN INVALIDAR.', {
            userId, numberPhone, name,
            modelResponseLen: String(response || '').length,
            action: 'image_caption_only_model_response',
            file: 'media.js'
        })

        // Marcar leído (solo aquí, cuando está confirmada la respuesta IA).
        try { if (ctx && ctx.key) await provider.vendor.readMessages([ctx.key]).catch(() => {}) } catch (_) {}

        // Enviar respuesta + guardar en historial + alarma IA.
        const alarmResp = await processAlarm(ctx, numberPhone, name, provider, response, "IA")
            .catch(() => false)
        if (alarmResp) {
            await stopPresenceSafeCaption()
            return
        }
        await sendReplySafe(numberPhone, provider, flowDynamic, response)
        const finalHistory = newHistory.slice()
        finalHistory.push({ role: 'assistant', content: String(response || '') })
        if (finalHistory.length > 20) finalHistory.splice(0, 2)
        await state.update({ history: finalHistory }).catch(() => {})
        try {
            await postWhatsappConversation(numberPhone, [
                { role: 'user', content: caption, role_type: 'user' },
                { role: 'assistant', content: String(response || ''), role_type: 'assistant' }
            ]).catch(() => {})
        } catch (_) {}
        defaultLogger.info('Caption-only: respuesta enviada y limpio terminado.', {
            userId, numberPhone, name,
            responseLen: String(response || '').length,
            action: 'image_caption_only_done',
            file: 'media.js'
        })
    } catch (errCaption) {
        defaultLogger.error('Caption-only: error interno. Enviar fallback simple.', {
            userId, numberPhone, name,
            captionPreview: caption.slice(0, 120),
            error: errCaption?.message || String(errCaption),
            stack: errCaption?.stack || null,
            action: 'image_caption_only_runtime_error',
            file: 'media.js'
        })
        // Fallback simple: no dejar al usuario en SILENCIO TOTAL.
        const simpleFallback = 'Vi tu mensaje pero no pude generar respuesta en este momento 😔. Inténtalo en instantes o describe en texto lo que necesites.'
        try { if (ctx && ctx.key) await provider.vendor.readMessages([ctx.key]).catch(() => {}) } catch (_) {}
        await sendReplySafe(numberPhone, provider, flowDynamic, simpleFallback)
    } finally {
        await stopPresenceSafeCaption()
    }
}


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
            file: 'media.js'
        })
    
        await provider.sendMessage(numberPhone,"Lo siento, no puedo procesar tu imagen. Por favor, envíame por texto lo que necesitas consultar.", { media: null})

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
        await provider.sendMessage(numberPhone,"Lo siento, no puedo procesar tu imagen. Por favor, envíame por texto lo que necesitas consultar.", { media: null})
        return true
    }

    return false
}

// Process alarms through dedicated method
const processAlarm = async (ctx, numberPhone, name, provider, question, UserOrIA ) => {
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

function extractMediaCaption(ctx) {
    // ============================================================
    // NOTA IMPORTANTE sobre orden de candidatos:
    // En BuilderBot EVENTS.MEDIA, ctx.body NO es el caption; contiene
    // el nombre del evento interno tipo "_event_media__UUID". Si lo
    // ponemos primero, captura MAL el texto como nombre del evento.
    //
    // Orden CORRECTO (de más específico a más genérico):
    //   1. imageMessage.caption / videoMessage.caption / documentMessage.caption
    //      (estos provienen DIRECTAMENTE de WhatsApp/Baileys y son el
    //      caption real del usuario que acompañó al medio enviado).
    //   2. ctx.caption / ctx.msg.caption (BuilderBot alias conveniente,
    //      cuando existe es el caption extraído).
    //   3. extendedTextMessage.text (cuando el media trae texto extra
    //      embeddeado; caso poco común pero posible).
    //   4. ctx.body / ctx.msg.body (ÚLTIMO. Solo usar si no hubo nada
    //      más y no se trata de un nombre de evento UUID).
    // ============================================================
    const candidates = [
        ctx?.message?.imageMessage?.caption,
        ctx?.msg?.message?.imageMessage?.caption,
        ctx?.msg?.imageMessage?.caption,
        ctx?.message?.videoMessage?.caption,
        ctx?.msg?.message?.videoMessage?.caption,
        ctx?.msg?.videoMessage?.caption,
        ctx?.message?.documentMessage?.caption,
        ctx?.msg?.message?.documentMessage?.caption,
        ctx?.msg?.documentMessage?.caption,
        ctx?.caption,
        ctx?.msg?.caption,
        ctx?.message?.extendedTextMessage?.text,
        ctx?.msg?.extendedTextMessage?.text,
        ctx?.msg?.message?.extendedTextMessage?.text,
        ctx?.body,
        ctx?.msg?.body
    ];

    for (const candidate of candidates) {
        const value = String(candidate || '').trim();
        if (!value) continue;
        // Protección anti-nombre-de-evento BuilderBot: CUALQUIER string que
        // empiece por "_event_" se considera nombre interno del evento
        // (p. ej. "_event_media__UUID", "_event_voice__xxx",
        //  "_event_document__corto", etc.). NUNCA se toma como caption.
        if (value.startsWith('_event_')) {
            continue;
        }
        // Segunda capa defensiva: match exacto de UUID completo con guiones
        // por si alguien cambiara el prefijo.
        if (/^_event_[a-z0-9]+__[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
            continue;
        }
        return value;
    }

    return '';
}

/**
 * Flow para manejar eventos de medios (imágenes) enviados por el usuario
 * Procesa comprobantes de pago y notifica al vendedor.
 * ESTRUCTURA UNIFICADA igual que chatbot.js/voice.js: 1 solo addAction.
 */
export const media = addKeyword(EVENTS.MEDIA)
    .addAction(async (ctx, { flowDynamic, endFlow, state, provider }) => {
        const userId = ctx.key.remoteJid
        const numberPhone = extractNumber(ctx)
        const name = ctx?.pushName ?? ''
        const mediaCaption = extractMediaCaption(ctx)
        const messageId = ctx?.key?.id || null
        // SCOPE GENERAL: hasCaptionNow lo usan TODOS los branches de error
        // (throttle temprano, saveFile, processImage, catch final, etc.)
        // para NO SILENCIAR al usuario cuando escribió texto con la imagen.
        const hasCaptionNow = Boolean(mediaCaption && String(mediaCaption).trim())

        try {
            defaultLogger.info('Flujo imagen: procesando (sin throttle). Iniciando setup normal.', {
                userId, numberPhone, name, messageId,
                hasCaption: hasCaptionNow,
                mediaCaption: hasCaptionNow ? String(mediaCaption).slice(0, 100) : '',
                action: 'media_flow_start_no_throttle',
                file: 'media.js'
            })

            const { profilePictureUrl } = await getProfilePictureInfo(ctx, provider, {
                userId, numberPhone, name, file: 'media.js'
            })

            defaultLogger.info('Iniciando procesamiento de imagen (único addAction)', {
                userId, numberPhone, name, mediaCaption, profilePictureUrl,
                action: 'media_received',
                timestamp: new Date().toISOString(),
                file: 'media.js'
            })

            // ================ COORDINACIÓN COMPARTIDA ================
            // ✅ NUEVA LÓGICA: esperar a que ESTE mensaje esté en el buffer
            // (por race condition nuestro listener Baileys puede correrse DESPUÉS de BBot).
            // Cuando encontramos la entry de IMAGEN propia → tomamos entry.version como flowVersion.
            let {
                version: myVersion,
                entryId: myImageEntryId,
                matchedBy: myMatchType
            } = await waitForMyMessageEntryInBuffer(numberPhone, {
                type: 'image',
                messageId: ctx?.key?.id || null,
                contentCandidate: String(mediaCaption || ''),
                file: 'media.js'
            })
            // GUARD: timeout sin entry → skip camino coordinado.
            // Para imagen: si myVersion=0 → no marca imagen pending throttled en buffer,
            // y guarda archivo igual. Luego entra al legacy (<=0) y responde.
            if (myMatchType === 'timeout_fallback_global_version' && Number(myVersion || 0) <= 0) {
                defaultLogger.warn('WaitForMyEntry timeout → camino LEGACY (imagen sin coordinación). Listener Baileys no insertó mensaje en buffer', {
                    userId, numberPhone, name,
                    myMatchType,
                    fallbackVersion: Number(myVersion || 0),
                    action: 'conversation_flow_skip_coordinated_timeout_myentry',
                    file: 'media.js'
                })
                myVersion = 0
                if (myImageEntryId) myImageEntryId = null
            }
            let pendingImage = myImageEntryId ? { entryId: myImageEntryId } : consumeLatestPendingOfType(numberPhone, 'image')
            const convStateBefore = getConversationState(numberPhone)
            defaultLogger.info('Conversación compartida (imagen - snapshot después de encontrar mi entry)', {
                userId, numberPhone, name,
                phoneKey: convStateBefore.phoneKey,
                myVersion,
                myImageEntryId,
                myMatchType,
                pendingImageEntryId: pendingImage ? pendingImage.entryId : null,
                pendingImageMessageId: pendingImage ? pendingImage.messageId : null,
                pendingImageReceivedAt: pendingImage && pendingImage.receivedAt ? new Date(pendingImage.receivedAt).toISOString() : null,
                currentVersion: convStateBefore.version,
                bufferCount: convStateBefore.bufferCount,
                meaningfulCount: convStateBefore.meaningfulCount,
                bufferTypes: convStateBefore.bufferTypes,
                lastActivityAt: convStateBefore.lastActivityAt ? new Date(convStateBefore.lastActivityAt).toISOString() : null,
                mediaCaption: String(mediaCaption || '').slice(0, 100),
                action: 'conversation_flow_init_image',
                file: 'media.js'
            })
            await state.update({
                ...(state.getMyState() || {}),
                conversationVersion: myVersion,
                conversationPhoneKey: convStateBefore.phoneKey,
                conversationEntryId: pendingImage ? pendingImage.entryId : null
            })
            // =========================================================

            // ============ VALIDACIONES (1 SOLA VEZ - igual que chatbot/voice) ============
            const isWhitelisted = await getWhatsappWhitelist(numberPhone)
            defaultLogger.info('Verificación de whitelist', {
                userId, numberPhone, name, isWhitelisted,
                action: 'whitelist_verification',
                file: 'media.js'
            })
            if (isWhitelisted) {
                defaultLogger.info('Usuario en whitelist, finalizando flujo', {
                    userId, numberPhone, name,
                    action: 'whitelist_end_flow',
                    file: 'media.js'
                })
                return endFlow()
            }

            const botStatus = await whatsappStatus()
            defaultLogger.info('Estado global del bot', {
                userId, numberPhone, name, botStatus,
                action: 'global_status_check',
                file: 'media.js'
            })
            if (botStatus && !botStatus.status) {
                defaultLogger.info('Bot desactivado globalmente', {
                    action: 'global_status_end_flow',
                    file: 'media.js'
                })
                return endFlow()
            }

            let userStatus = await getWhatsapp(numberPhone, { name, profilePictureUrl })
            defaultLogger.info('Estado del usuario', {
                userId, numberPhone, name, userStatus,
                action: 'user_status_check',
                file: 'media.js'
            })

            if (userStatus && !userStatus.status) {
                defaultLogger.info('Usuario desactivado', {
                    userId, numberPhone, name,
                    action: 'user_disabled_end_flow',
                    file: 'media.js'
                })
                return endFlow()
            }

            // Actualizar usuario NUEVO (igual que chatbot/voice ahora lo hacen)
            if (!userStatus) {
                 await putWhatsapp(numberPhone, name, true, profilePictureUrl)
                defaultLogger.info('Nuevo usuario registrado', {
                    userId, numberPhone, name, newUserStatus: userStatus,
                    action: 'new_user_registration',
                    file: 'media.js'
                })
            }
            

            // Check premium plan
            const shouldEndPremium = await checkPremiumPlan(userId, numberPhone, name, provider)
            if (shouldEndPremium) return endFlow()

            // ===== HISTORIAL (antes de procesar imagen, igual que chatbot/voice) =====
            const historyGlobalStatus = state.getMyState()?.history ?? []
            if (historyGlobalStatus.length <= 0) {
                const historyDB = await getWhatsappConversation(numberPhone);
                defaultLogger.info('Historial de conversación recuperado de la base de datos', {
                    userId, numberPhone, name,
                    historyLength: historyDB?.length || 0,
                    action: 'history_db_retrieved',
                    file: 'media.js'
                })
                defaultLogger.info('Estado actualizado con el historial de conversación', {
                    userId, numberPhone, name,
                    action: 'history_state_updated',
                    file: 'media.js'
                })
                await state.update({ history: historyDB })
            }

            // ===== PROCESAR Y GUARDAR LA IMAGEN (1 SOLA VEZ AHORA - antes estaba duplicado) =====
            // Protegemos SAVE + PROCESS individualmente con try/catch interno.
            // Si sharp/webp o lo que sea falla en runtime, NO colgamos BuilderBot,
            // NO hacemos que el usuario reciba silencio. Si es procesable sigue
            // camino normal. Si NO, enviamos un mensaje SUAVE al usuario
            // ("no pude procesar la imagen") y terminamos limpio.
            // Esto evita que 1 imagen webp corrupta bloquee TODOS los mensajes
            // siguientes en la cola secuencial del mismo número.
            let pathImg = null
            let saveImageError = null
            try {
                pathImg = await provider.saveFile(ctx, { path: `${process.cwd()}/media/` })
                defaultLogger.info('Imagen guardada', {
                    userId, numberPhone, name, pathImg,
                    action: 'image_saved',
                    file: 'media.js'
                })
            } catch (errSave) {
                saveImageError = errSave
                defaultLogger.error('Error al guardar imagen (saveFile). Terminamos flow limpio sin colgar.', {
                    userId, numberPhone, name,
                    error: errSave?.message || String(errSave),
                    stack: errSave?.stack || null,
                    action: 'image_savefile_error_graceful',
                    file: 'media.js'
                })
            }

            // ===== KEEP-ALIVE PRESENCIA "escribiendo…" =====
            // Mantener estado durante: análisis de imagen + polling 25s + IA + respuesta.
            // WhatsApp borra composing tras ~15s → refrescamos cada 10s.
            // 🔥 INICIAMOS AQUÍ (después del throttle, guardado y setup) para no
            //    activar loops en imágenes rechazadas por throttling.
            const presence = startPresenceKeepAlive(provider, ctx.key.remoteJid, {
                presenceType: 'composing', file: 'media.js'
            })
            const stopPresenceSafe = async () => {
                try { await new Promise(resolve => setTimeout(resolve, 5000)) } catch (_) {}
                try { await presence.stop() } catch (_) {}
            }
            // Helper: limpiar archivo temporal + stop presence (para paths tempranos que borran img)
            const cleanupImageAndPresence = async (imgPath) => {
                if (imgPath) {
                    try {
                        fs.unlink(imgPath, (error) => {
                            if (error) defaultLogger.error('Error eliminando Imagen', {
                                userId, numberPhone, name, error: error.message,
                                action: 'delete_image', file: 'media.js'
                            })
                        })
                    } catch (_) {}
                }
                await stopPresenceSafe()
            }

            // ============================================================
            // PATH RÁPIDO: si el saveFile falló (webp corrupto, error sharp
            // pre-save, path sin permisos, etc.)
            // 🟢 SI HAY CAPTION → NO SILENCIAR. Enviar mensaje genérico
            //    IMAGE_DOWNLOAD_ERROR_MSG + luego responder el caption con IA.
            // 🔴 SÓLO mensaje genérico si la imagen venía SIN caption.
            // ============================================================
            if (saveImageError || !pathImg) {
                try { await provider.vendor.readMessages([ctx.key]).catch(() => {}) } catch (_) {}
                try {
                    await sendReplySafe(numberPhone, provider, flowDynamic, IMAGE_DOWNLOAD_ERROR_MSG)
                } catch (_) {}
                defaultLogger.warn('saveFile falló o pathImg vacío. Soft reply genérico enviado.', {
                    userId, numberPhone, name,
                    hasCaption: hasCaptionNow,
                    saveImageErrorMessage: saveImageError?.message || null,
                    action: 'image_savefile_error_generic_reply',
                    file: 'media.js'
                })
                if (hasCaptionNow) {
                    await runCaptionOnlyAsText({
                        captionRaw: mediaCaption, ctx, numberPhone, userId, name,
                        provider, flowDynamic, state, presence
                    })
                }
                await cleanupImageAndPresence(null)
                return endFlow()
            }

            defaultLogger.info('Iniciando etapa de análisis y respuesta (imagen - único addAction)', {
                userId, numberPhone, name, mediaCaption,
                action: 'image_response_stage_start',
                file: 'media.js'
            })

            // ===== ANÁLISIS DE IMAGEN =====
            let responseImage = null
            let processImageError = null
            try {
                responseImage = await processImage(pathImg, numberPhone, name)
            } catch (errProc) {
                processImageError = errProc
                defaultLogger.error('Error processImage (runtime sharp/openai o imagen corrupta). Graceful exit.', {
                    userId, numberPhone, name,
                    error: errProc?.message || String(errProc),
                    stack: errProc?.stack || null,
                    path: pathImg,
                    action: 'image_process_error_graceful',
                    file: 'media.js'
                })
            }
            if (!responseImage) {
                // Imagen vacía O error procesando.
                // 🟢 SI HAY CAPTION: mensaje genérico + responder caption con IA.
                // 🔴 SIN CAPTION: solo mensaje genérico.
                defaultLogger.info('Procesamiento imagen retornó vacío / error (incluye errores silent).', {
                    userId, numberPhone, name,
                    processImageErrorMessage: processImageError?.message || null,
                    hasCaption: hasCaptionNow,
                    action: 'image_process_empty_or_error',
                    file: 'media.js'
                })
                try { await provider.vendor.readMessages([ctx.key]).catch(() => {}) } catch (_) {}
                try {
                    await sendReplySafe(numberPhone, provider, flowDynamic, IMAGE_DOWNLOAD_ERROR_MSG)
                } catch (_) {}
                if (hasCaptionNow) {
                    await runCaptionOnlyAsText({
                        captionRaw: mediaCaption, ctx, numberPhone, userId, name,
                        provider, flowDynamic, state, presence
                    })
                }
                await cleanupImageAndPresence(pathImg)
                return endFlow()
            }
            defaultLogger.info('Respuesta del modelo obtenida Imagen', {
                userId, numberPhone, name,
                modelResponse: responseImage.text,
                action: 'model_response',
                file: 'media.js'
            })

            // ============================================================
            // UNIR CAPTION (texto usuario) + TEXTO OBTENIDO DE LA IMAGEN
            // ============================================================
            // - Prioridad: el caption del usuario es la fuente principal
            //   (lo que el usuario quiso decir explícitamente).
            // - El OCR / análisis de la imagen es apoyo contextual.
            // - La unión se guarda en 3 sitios:
            //     (a) combinedText variable local
            //     (b) responseImage.text → para uso downstream y logs
            //     (c) entry content al marcar READY en buffer
            // ============================================================
            const captionTrim = String(mediaCaption || '').trim()
            const ocrTrim = String(responseImage.text || '').trim()
            let combinedText = ''
            if (captionTrim && ocrTrim) {
                combinedText = `${captionTrim}\n\n[Contenido detectado en la imagen: ${ocrTrim}]`
            } else if (captionTrim) {
                combinedText = captionTrim
            } else if (ocrTrim) {
                combinedText = ocrTrim
            }
            if (combinedText) {
                responseImage.text = combinedText
                defaultLogger.info('Texto combinado (caption + imagen) generado', {
                    userId, numberPhone, name,
                    captionRaw: captionTrim ? captionTrim.slice(0, 150) : '',
                    ocrRaw: ocrTrim ? ocrTrim.slice(0, 150) : '',
                    combinedText: combinedText.slice(0, 300),
                    action: 'image_caption_ocr_combined_ok',
                    file: 'media.js'
                })
            }

            // ================ COORDINACIÓN COMPARTIDA: MARCAR IMAGEN READY ================
            const imageQuestionParts = [];
            if (captionTrim) {
                imageQuestionParts.push(`El usuario envio esta imagen con el siguiente texto o caption: "${captionTrim}".`);
            }
            if (ocrTrim) {
                imageQuestionParts.push(`Contenido detectado en la imagen: *${ocrTrim}*.`);
            }
            if (combinedText) {
                imageQuestionParts.push(`TEXTO UNIFICADO que representa el mensaje completo del usuario: "${combinedText}".`);
            }
            imageQuestionParts.push('IMPORTANTE: usa el caption del usuario como contexto principal, el texto extraído de la imagen como apoyo, y prioriza el TEXTO UNIFICADO cuando corresponda para responder.');
            const imageProcessedContent = imageQuestionParts.join('\n\n');

            const st = state.getMyState() || {}
            const flowVersion = Number(st.conversationVersion || myVersion || 0)
            let myEntryId = st.conversationEntryId || null
            if (!myEntryId || flowVersion > 0) {
                const fallback = consumeLatestPendingOfType(numberPhone, 'image')
                if (fallback && fallback.entryId) {
                    if (!myEntryId) myEntryId = fallback.entryId
                    pendingImage = fallback
                }
            }
            defaultLogger.info('Imagen marcar READY procesada', {
                userId, numberPhone, name,
                flowVersion, myEntryId,
                storedVersion: st.conversationVersion,
                storedEntryId: st.conversationEntryId,
                pendingImageEntryId: pendingImage ? pendingImage.entryId : null,
                action: 'conversation_image_ready',
                file: 'media.js'
            })
            if (flowVersion > 0 && myEntryId) {
                // content que almacenamos en la buffer entry: es el texto
                // COMBINADO REAL (caption + OCR). Esto asegura que cuando
                // consolidateRafagaForTurn construya combinedInput uniéndolo
                // con mensajes de texto anteriores, aparezca la unión real.
                // imageProcessedContent se usa solo como prompt interno de IA.
                markMessageReady(numberPhone, myEntryId, {
                    content: combinedText || imageProcessedContent,
                    caption: captionTrim,
                    extra: {
                        imageAnalysisText: ocrTrim,
                        captionRaw: captionTrim,
                        combinedText
                    },
                    file: 'media.js'
                })
            }
            // ==========================================================

            // ===== ALARMA USER SIDE (igual que chatbot/voice) =====
            const shouldEndFlowUser = await processAlarm(ctx, numberPhone, name, provider, imageProcessedContent, "user")
            if (shouldEndFlowUser) {
                await cleanupImageAndPresence(pathImg)
                return endFlow()
            }

            // ============================================================
            // GUARD DE RÁFAGA VIVA (evita respuestas duplicadas en imagen).
            // REGLA NEGOCIO: imagen -> texto/audio DENTRO 45s debe generar
            // 1 SOLA RESPUESTA UNIFICADA, no 2 separadas.
            // ============================================================
            if (Number(flowVersion || 0) <= 0) {
                const rafagaInfo = isRafagaVivaActive(numberPhone, { file: 'media.js' })
                if (rafagaInfo && rafagaInfo.active) {
                    // Forzamos camino coordinado.
                    const newFlowVer = Number(getCurrentVersion(numberPhone) || 1) || 1
                    defaultLogger.info('Media imagen: ráfaga viva detectada. Forzando camino coordinado (no legacy) para unificar en 1 respuesta.', {
                        userId, numberPhone, name,
                        newCoordinatedVersion: newFlowVer,
                        rafagaDetail: {
                            bufferCount: rafagaInfo.bufferCount,
                            uniqueTypes: rafagaInfo.uniqueTypes,
                            sinceLastMs: rafagaInfo.sinceLastMs
                        },
                        action: 'media_rafaga_viva_force_coordinated_path',
                        file: 'media.js'
                    })
                    flowVersion = newFlowVer
                }
            }

            if (Number(flowVersion || 0) <= 0) {
                // ======== CAMINO LEGACY (sin coordinación) ========
                // newHistory guarda COMBINEDTEXT como texto user real (no el
                // prompt interno imageProcessedContent). run() recibe
                // imageProcessedContent como prompt guía (incluye hints de
                // prioridad caption + OCR).
                const newHistory = (state.getMyState()?.history ?? []).slice()
                newHistory.push({ role: 'user', content: combinedText || imageProcessedContent })
                const response = await run(name, newHistory, imageProcessedContent, numberPhone, responseImage.img)
                defaultLogger.info('Respuesta del modelo obtenida Texto Imagen (legacy). FLUJO COMPROMETIDO: NO INVALIDAR POR NADA', {
                    userId, numberPhone, name,
                    modelResponse: response,
                    action: 'model_response_legacy',
                    combinedTextPreview: combinedText ? combinedText.slice(0, 300) : null,
                    note: 'DESPUÉS DE ESTE PUNTO, SIN 2ª VALIDACIÓN, SE RESPONDE OBLIGATORIAMENTE',
                    file: 'media.js'
                })
                await respondAndFinalize({
                    response,
                    combinedMessages: combinedText || imageProcessedContent,
                    image: responseImage,
                    name, numberPhone, userId, ctx, provider, flowDynamic, state, pathImg
                })
                await stopPresenceSafe()
                return endFlow()
            }

            // ======== CAMINO COORDINADO (igual que chatbot/voice) ========
            const turn = await waitForTurn(numberPhone, {
                flowVersion,
                flowType: 'image',
                flowId: `image_${myEntryId || ''}`,
                file: 'media.js'
            })
            if (!turn.acquired) {
                defaultLogger.info('Flujo imagen cede turno (invalidado)', {
                    userId, numberPhone, name,
                    flowVersion,
                    finalVersion: turn.finalVersion,
                    cancelReason: turn.cancelReason,
                    action: 'conversation_image_cede',
                    file: 'media.js'
                })
                await cleanupImageAndPresence(pathImg)
                return endFlow()
            }

            // El CONSOLIDADOR (consolidateRafagaForTurn) ya unió entries de
            // tipo texto/audio/imagen con sus content REALES guardados en
            // markMessageReady (combinedText para la imagen). Si el turn
            // tiene combinedInput, lo usamos tal cual (ya trae la unión
            // real ráfaga). Si no, fallback a combinedText.
            const combinedInput = turn.combinedInput || combinedText || imageProcessedContent
            const newHistory = (state.getMyState()?.history ?? []).slice()
            newHistory.push({ role: 'user', content: combinedInput })

            defaultLogger.info('Procesando mensajes acumulados (coordinación imagen)', {
                userId, numberPhone, name,
                flowVersion,
                combinedLength: String(combinedInput).length,
                combinedPreview: String(combinedInput).slice(0, 300),
                historyLength: newHistory.length,
                action: 'processing_messages_shared_image',
                file: 'media.js'
            })

            defaultLogger.info('Inicio consulta IA (imagen, coordinado)', {
                userId, numberPhone, name,
                flowVersion,
                combinedLength: String(combinedInput).length,
                action: 'conversation_ai_request_start',
                file: 'media.js'
            })
            const response = await run(name, newHistory, imageProcessedContent, numberPhone, responseImage.img)
            defaultLogger.info('Respuesta del modelo obtenida (imagen, coordinado). FLUJO COMPROMETIDO: NO INVALIDAR POR NADA, RESPONDER SIEMPRE', {
                userId, numberPhone, name,
                flowVersion,
                modelResponse: response,
                action: 'conversation_ai_response_done',
                note: 'DESPUÉS DE ESTE PUNTO, SIN 2ª VALIDACIÓN, SE RESPONDE OBLIGATORIAMENTE',
                file: 'media.js'
            })

            // ✅ REGLA DE NEGOCIO: no hay 2ª validación isStillMyTurn aquí.
            //    Si llegamos hasta aquí con respuesta IA, se envía sí o sí.
            // Alarm IA-side ESTÁ DENTRO de respondAndFinalize (ya lo tenía media.js originalmente)
            await respondAndFinalize({
                response,
                combinedMessages: combinedInput,
                image: responseImage,
                name, numberPhone, userId, ctx, provider, flowDynamic, state,
                flowVersion,
                pathImg
            })
            await stopPresenceSafe()
            return endFlow()

        } catch (error) {
            defaultLogger.error('Error en flujo de medios (único addAction) → Respuesta SUAVE no silencio.', {
                userId, numberPhone, name,
                error: error.message,
                stack: error.stack,
                context: ctx,
                hasCaption: hasCaptionNow,
                action: 'media_flow_trycatch_generic_error',
                file: 'media.js'
            })
            // 🟢 SIEMPRE responder algo. No dejar usuario en SILENCIO.
            try {
                try { if (ctx && ctx.key) await provider.vendor.readMessages([ctx.key]).catch(() => {}) } catch (_) {}
                try {
                    await sendReplySafe(numberPhone, provider, flowDynamic, IMAGE_DOWNLOAD_ERROR_MSG)
                } catch (_) {}
                if (hasCaptionNow) {
                    await runCaptionOnlyAsText({
                        captionRaw: mediaCaption, ctx, numberPhone, userId, name,
                        provider, flowDynamic, state, presence: null
                    })
                }
            } catch (_superFinal) {
                defaultLogger.debug('Catch final generic media: super error enviando replies. SILENCIO evitable, logueado.', {
                    userId, numberPhone,
                    error: _superFinal?.message || String(_superFinal),
                    action: 'media_flow_generic_catch_final_reply_error',
                    file: 'media.js'
                })
            }
            return endFlow()
        } finally {
            try {
                // Parada defensiva (siempre paused). Los paths exitosos ya llamaron
                // a stopPresenceSafe (con 5s grace + interval clear). Aquí sin sleep
                // para no bloquear el finally de BuilderBot.
                if (provider?.vendor?.sendPresenceUpdate && ctx?.key?.remoteJid) {
                    try { await provider.vendor.sendPresenceUpdate('paused', ctx.key.remoteJid) } catch (_) {}
                }
            } catch (_) { /* no-op */ }
        }
    })

// respondAndFinalize para flujo de imagen (encapsula: duplicado, alarma, chunks, historial, email vendor, limpiar img)
const respondAndFinalize = async ({
    response,
    combinedMessages,
    image,
    name,
    numberPhone,
    userId,
    ctx,
    provider,
    flowDynamic,
    state,
    flowVersion,
    pathImg
}) => {
    // Alarm IA
    const shouldEndFlowAlarm = await processAlarm(ctx, numberPhone, name, provider, response, "IA")
    if (shouldEndFlowAlarm) {
        if (pathImg) fs.unlink(pathImg, (error) => {
            if (error) defaultLogger.error('Error eliminando Imagen', { userId, numberPhone, name, error: error.message, action: 'delete_image', file: 'media.js' });
        });
        return { alarm: true }
    }

    // ✅ MARCAR LEÍDO SÓLO AQUÍ (después de run + isStillMyTurn + alarm IA, justo ANTES de enviar respuesta)
    // Nota: respondAndFinalize es llamado SÓLO cuando todos los checks anteriores pasaron (legacy y coordinado).
    try { if (ctx && ctx.key) await provider.vendor.readMessages([ctx.key]) } catch (_) {}

    defaultLogger.info('Enviando respuesta final al usuario (media)', {
        numberPhone, userId,
        responseLength: String(response).length,
        flowVersion: flowVersion !== undefined ? flowVersion : 'legacy',
        responsePreview: String(response).slice(0, 200),
        action: flowVersion !== undefined ? 'conversation_image_response_sending' : 'response_sending',
        file: 'media.js'
    })

    if (numberPhone.length <= 11) {
        await provider.sendMessage(numberPhone, response, { media: null })
    } else {
        await flowDynamic(response)
    }

    // Actualizar historial
    const st = state.getMyState() || {}
    const newHistory = (st.history ?? []).slice()
    if (newHistory.length === 0 || newHistory[newHistory.length - 1].role !== 'user' || newHistory[newHistory.length - 1].content !== combinedMessages) {
        newHistory.push({ role: 'user', content: combinedMessages })
    }
    newHistory.push({ role: 'assistant', content: response })
    if (newHistory.length > 20) newHistory.splice(0, 2)
    await state.update({ history: newHistory })

    // Notificación al vendedor (la conservamos solo para imagen, como hacía originalmente media.js)
    try {
        if (image && typeof image === 'object' && image.text) {
            const htmlText = String(image.text)
                .replace(/\n/g, "<br>")
                .replace(/\*\*(.*?)\*\*/g, "<b>$1</b>")
            const responseAlarm = await putWhatsappEmailVendor(
                numberPhone,
                name,
                `<br><br>${htmlText}<br>`,
                image.img
            )
            defaultLogger.info('Notificación enviada al vendedor', {
                userId, numberPhone, name, responseAlarm,
                action: 'vendor_notification_sent',
                file: 'media.js'
            })
        }
    } catch (e) {
        defaultLogger.error('Error al notificar al vendedor', {
            userId, numberPhone, name,
            error: e.message, action: 'vendor_notification_error',
            file: 'media.js'
        })
    }

    // Limpiar buffer coordinado (solo después de enviar OK)
    if (flowVersion !== undefined) {
        clearConversationAfterResponse(numberPhone, {
            finalVersion: flowVersion,
            file: 'media.js'
        })
    }

    defaultLogger.info('Respuesta enviada correctamente (media)', {
        numberPhone, userId,
        flowVersion: flowVersion !== undefined ? flowVersion : 'legacy',
        historyLength: newHistory.length,
        action: flowVersion !== undefined ? 'conversation_image_response_sent' : 'response_sent',
        file: 'media.js'
    })

    // Limpiar imagen temporal
    if (pathImg) {
        fs.unlink(pathImg, (error) => {
            if (error) defaultLogger.error('Error eliminando Imagen', { userId, numberPhone, name, error: error.message, action: 'delete_image', file: 'media.js' });
        });
    } else if (image && typeof image === 'object' && image._path) {
        fs.unlink(image._path, (error) => {
            if (error) defaultLogger.error('Error eliminando Imagen', { userId, numberPhone, name, error: error.message, action: 'delete_image', file: 'media.js' });
        });
    }

    return { ok: true }
}
