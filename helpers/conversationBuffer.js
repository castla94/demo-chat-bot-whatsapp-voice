import { defaultLogger } from './cloudWatchLogger.js';

// ============================================================
// CONVERSATION BUFFER (único por número de teléfono)
//
// Arquitectura de coordinación entre flujos de texto/audio/imagen.
// Cada flujo sigue procesando su contenido de forma independiente,
// pero comparten UNA SOLA conversación pendiente por teléfono.
//
// La clave es la VERSIÓN GLOBAL: cada mensaje RECIBIDO (físico del usuario)
// incrementa la versión, y el flujo solo responde si:
//   1) su versión coincide con la versión vigente (es el último msg)
//   2) pasaron 45s desde el último mensaje recibido
//   3) TODOS los mensajes de la ventana están "ready" (procesados)
//
// Los timers pueden coexistir: todos se disparan, solo el "último"
// (mayor versión) adquiere el turno y responde.
// ============================================================

const SILENCE_WINDOW_MS = 45 * 1000
const POLL_TICK_MS = 1000
const MAX_WAIT_MS = 15 * 60 * 1000 // hard limit para no colgar polling para siempre

const conversations = new Map()

const normalizeKey = (phone) => {
    // Quitar dominio @s.whatsapp.net si viniera (defensa)
    let s = String(phone || '').split('@')[0]
    // Quitar sufijo de puerto :NN (remoteJid a veces trae 569XXXXXXXXX:23@s.whatsapp.net)
    //   → si no lo quitamos, .replace(/\D/g,'') mete los dígitos del puerto como parte del número.
    s = s.split(':')[0]
    const digits = s.replace(/\D/g, '')
    return digits || String(phone || '')
}

const ensureConversation = (phone) => {
    const key = normalizeKey(phone)
    if (!conversations.has(key)) {
        conversations.set(key, {
            key,
            version: 0,
            lastActivityAt: 0,
            messages: [], // { id, messageId, type, content, status: 'pending'|'ready', caption, receivedAt, processedAt, extra }
            metadata: {},
            cleanupTimer: null
        })
    }
    return conversations.get(key)
}

/**
 * Función interna: dado un mensaje (Baileys raw) extrae el NÚMERO REAL igual que extractNumber(BuilderBot):
 *   1. remoteJidAlt si cumple length 8-20
 *   2. participant si cumple
 *   3. remoteJid si cumple length 8-20 (Número real, NO LID)
 *
 * Importante: remueve el sufijo :NN que trae remoteJid a veces (ej: "569XXXXXXXXX:23@s.whatsapp.net")
 * para NO generar keys distintas entre el listener y los flows.
 */
export const extractPhoneFromRawMessage = (message) => {
    const k = message?.key || {}
    const stripAt = (s) => String(s || '').split('@')[0]                // quita @s.whatsapp.net
    const stripPort = (s) => String(s || '').split(':')[0]               // quita :23 / :16 / puerto
    const toDigits = (s) => String(s || '').replace(/\D/g, '')           // solo dígitos

    const rawRemoteAlt = toDigits(stripPort(stripAt(k.remoteJidAlt)))
    const rawParticipant = toDigits(stripPort(stripAt(k.participant)))
    const rawRemote = toDigits(stripPort(stripAt(k.remoteJid)))

    const looksLikeRealNumber = (s) => s && s.length >= 8 && s.length <= 20

    if (looksLikeRealNumber(rawRemoteAlt)) return rawRemoteAlt
    if (looksLikeRealNumber(rawParticipant)) return rawParticipant
    if (looksLikeRealNumber(rawRemote)) return rawRemote

    // Último fallback (LID etc.) pero con normalización
    return rawRemoteAlt || rawParticipant || rawRemote
}

/**
 * Detectar tipo a partir del mensaje raw Baileys.
 */
export const detectTypeFromRawMessage = (message) => {
    const msg = message?.message || {}
    if (msg.conversation || msg.extendedTextMessage) return 'text'
    if (msg.audioMessage || msg.voiceMessage) return 'audio'
    if (msg.imageMessage) return 'image'
    if (msg.videoMessage) return 'video'
    if (msg.documentMessage) return 'document'
    if (msg.stickerMessage) return 'sticker'
    return 'unknown'
}

const extractTextContent = (message) => {
    const msg = message?.message || {}
    if (typeof msg.conversation === 'string' && msg.conversation.trim()) return msg.conversation
    if (msg.extendedTextMessage && typeof msg.extendedTextMessage.text === 'string' && msg.extendedTextMessage.text.trim()) return msg.extendedTextMessage.text
    return ''
}

const extractImageCaption = (message) => {
    const msg = message?.message || {}
    const cand = [
        msg?.imageMessage?.caption,
        msg?.videoMessage?.caption,
        msg?.documentMessage?.caption
    ]
    for (const c of cand) if (String(c || '').trim()) return String(c).trim()
    return ''
}

const placeholderFor = (type, extra = {}) => {
    if (type === 'audio') return '(audio en transcripción)'
    if (type === 'image') {
        if (extra.caption) return `(imagen en análisis) Caption: "${extra.caption}"`
        return '(imagen en análisis)'
    }
    if (type === 'video') return '(video sin procesar)'
    if (type === 'document') return '(documento sin procesar)'
    if (type === 'sticker') return '(sticker)'
    return ''
}

const typeHeaderFor = (type) => {
    switch (type) {
        case 'text': return 'TEXTO'
        case 'audio': return 'AUDIO'
        case 'image': return 'IMAGEN'
        case 'video': return 'VIDEO'
        case 'document': return 'DOCUMENTO'
        case 'sticker': return 'STICKER'
        default: return String(type || 'OTRO').toUpperCase()
    }
}

// ============================================================
// API PÚBLICA
// ============================================================

/**
 * Registrar un mensaje RECIBIDO físicamente (aún sin procesar).
 * Incrementa la versión global y lastActivityAt (usando receivedTimestamp del mensaje si existe).
 * Desduplica por messageId (key.id de WhatsApp).
 *
 * - Para texto: status=ready y content real.
 * - Para audio: status=pending y placeholder "(audio en transcripción)".
 * - Para imagen: status=pending y placeholder "(imagen en análisis)".
 *
 * @returns {{ phoneKey: string, version: number, entryId: string, type: string, duplicated: boolean, receivedAt: number }}
 */
export const addReceivedMessage = (phone, {
    messageId,
    type,
    content,
    receivedAtMs,   // timestamp de recepción real (msg.messageTimestamp * 1000 o Date.now())
    caption,
    file = 'conversationBuffer.js'
} = {}) => {
    const conv = ensureConversation(phone)
    const id = String(messageId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

    // DESDUPLICACIÓN por messageId (previene re-emisiones de Baileys/BuilderBot)
    const existing = conv.messages.find(m => m.messageId === id || m.id === id)
    if (existing) {
        defaultLogger.info('Mensaje ya registrado (desduplicado)', {
            phoneKey: conv.key,
            phone,
            messageId: id,
            type: existing.type,
            version: conv.version,
            status: existing.status,
            action: 'conversation_dup_hit',
            file
        })
        return {
            phoneKey: conv.key,
            version: conv.version,
            entryId: existing.id,
            type: existing.type,
            duplicated: true,
            receivedAt: existing.receivedAt
        }
    }

    // INCREMENTAR VERSIÓN GLOBAL (una por cada mensaje FÍSICO del usuario)
    conv.version += 1
    const assignedVersion = conv.version

    // Actualizar última actividad (solo con mensajes RECIBIDOS, no con procesamiento interno).
    const receivedAt = receivedAtMs && Number(receivedAtMs) > 0 ? Number(receivedAtMs) : Date.now()
    if (receivedAt > (conv.lastActivityAt || 0)) {
        conv.lastActivityAt = receivedAt
    }

    const status = (type === 'text') ? 'ready' : 'pending'
    let entryContent = content
    if (!entryContent) entryContent = placeholderFor(type, { caption: caption || '' })

    const entry = {
        id: id,
        messageId: id,
        type: String(type || 'text').toLowerCase(),
        content: String(entryContent || ''),
        status,
        caption: caption ? String(caption) : '',
        receivedAt,
        processedAt: status === 'ready' ? receivedAt : 0,
        version: assignedVersion,
        extra: {}
    }
    conv.messages.push(entry)
    conv.messages.sort((a, b) => Number(a.receivedAt || 0) - Number(b.receivedAt || 0))

    defaultLogger.info('Mensaje agregado al buffer de conversación (RECIBIDO)', {
        phoneKey: conv.key,
        phone,
        messageId: entry.messageId,
        type: entry.type,
        version: assignedVersion,
        status: entry.status,
        bufferCount: conv.messages.length,
        lastActivityAt: new Date(conv.lastActivityAt).toISOString(),
        receivedAt: new Date(entry.receivedAt).toISOString(),
        contentPreview: String(entry.content || '').slice(0, 100),
        captionPreview: String(caption || '').slice(0, 100),
        action: 'conversation_msg_added',
        file
    })

    return {
        phoneKey: conv.key,
        version: assignedVersion,
        entryId: entry.id,
        type: entry.type,
        duplicated: false,
        receivedAt: entry.receivedAt
    }
}

/**
 * Marcar un mensaje como PROCESADO (listo para combinar).
 * - audio: cuando termina handlerAI -> actualiza content = transcripción
 * - image: cuando termina processImage -> actualiza content = texto extraido
 * - text: no se usa (ya llega ready)
 * NO incrementa versión, NO cambia lastActivityAt (eso es solo para mensajes RECIBIDOS).
 */
export const markMessageReady = (phone, messageId, {
    content,
    caption,
    extra = {},
    file = 'conversationBuffer.js'
} = {}) => {
    const conv = ensureConversation(phone)
    const target = String(messageId || '')
    const idx = conv.messages.findIndex(m => m.id === target || m.messageId === target)
    if (idx < 0) {
        defaultLogger.warn('markMessageReady: mensaje no encontrado en buffer', {
            phoneKey: conv.key,
            phone,
            messageId,
            version: conv.version,
            action: 'conversation_ready_miss',
            file
        })
        return null
    }
    const wasPending = conv.messages[idx].status === 'pending'
    if (typeof content === 'string') conv.messages[idx].content = content
    if (typeof caption === 'string' && caption) conv.messages[idx].caption = caption
    if (extra && typeof extra === 'object') {
        conv.messages[idx].extra = { ...(conv.messages[idx].extra || {}), ...extra }
    }
    conv.messages[idx].status = 'ready'
    conv.messages[idx].processedAt = Date.now()

    defaultLogger.info('Mensaje marcado como READY (procesado)', {
        phoneKey: conv.key,
        phone,
        messageId: conv.messages[idx].messageId,
        type: conv.messages[idx].type,
        version: conv.version,
        wasPending,
        processedAt: new Date(conv.messages[idx].processedAt).toISOString(),
        contentPreview: String(conv.messages[idx].content || '').slice(0, 100),
        action: 'conversation_msg_ready',
        file
    })

    return conv.messages[idx]
}

// ============================================================
// CONSULTA DE ESTADO
// ============================================================

export const getConversationState = (phone) => {
    const conv = ensureConversation(phone)
    return {
        phoneKey: conv.key,
        version: conv.version,
        lastActivityAt: conv.lastActivityAt,
        bufferCount: conv.messages.length,
        bufferTypes: conv.messages.map(m => m.type),
        allReady: conv.messages.length === 0 ? false : conv.messages.every(m => m.status === 'ready'),
        messages: conv.messages.map(m => ({
            id: m.id, messageId: m.messageId, type: m.type,
            status: m.status, receivedAt: m.receivedAt, processedAt: m.processedAt,
            version: m.version
        })),
        silenceElapsedMs: conv.lastActivityAt ? (Date.now() - conv.lastActivityAt) : 0
    }
}

export const getCurrentVersion = (phone) => {
    return ensureConversation(phone).version
}

export const hasPendingMessages = (phone) => {
    const conv = ensureConversation(phone)
    if (conv.messages.length === 0) return false
    return conv.messages.some(m => m.status === 'pending')
}

/**
 * Devuelve el ÚLTIMO mensaje de un tipo con status='pending'.
 * Super simple: cuando voice.js termina de transcribir, lo llama para marcar el ÚLTIMO audio pending como ready.
 * No requiere IDs ni nada: el último audio pending en este número es, lógicamente, el que acaba de transcribirse
 * (solo se envía un audio a la vez por usuario, y los listener insertan cronológicamente).
 */
export const consumeLatestPendingOfType = (phone, type) => {
    const conv = ensureConversation(phone)
    const typeNorm = String(type || '').toLowerCase()
    const pendings = conv.messages
        .filter(m => String(m.type).toLowerCase() === typeNorm && m.status === 'pending')
        .sort((a, b) => Number(b.receivedAt || 0) - Number(a.receivedAt || 0))
    if (pendings.length === 0) return null
    const last = pendings[0]
    return { entryId: last.id, messageId: last.messageId, receivedAt: last.receivedAt, version: last.version }
}

// ============================================================
// POLLING unificado (usado por los 3 flows)
// Espera hasta que se den 3 condiciones y luego retorna acquired=true
// o retorna acquired=false (el flujo se invalida y debe terminar silenciosamente).
//
// args:
//   phone, flowVersion (la versión con la que nació el flow), flowType ('text'|'audio'|'image'),
//   flowId (nombre para logs), file
//
// resuelve a:
//   { acquired: boolean, cancelReason: string|null, combinedInput: string|null, finalVersion: number }
// ============================================================
export const waitForTurn = async (phone, {
    flowVersion,
    flowType,
    flowId = 'flow',
    file = 'conversationBuffer.js'
} = {}) => {
    const phoneKey = normalizeKey(phone)
    const conv = ensureConversation(phone)
    const startedAt = Date.now()

    defaultLogger.info('Iniciando polling de turno para flujo', {
        phoneKey,
        phone,
        flowType,
        flowId,
        flowVersion,
        currentVersion: conv.version,
        action: 'conversation_polling_start',
        silenceWindowMs: SILENCE_WINDOW_MS,
        tickMs: POLL_TICK_MS,
        bufferCount: conv.messages.length,
        file
    })

    let lastLogAt = 0

    while (true) {
        const now = Date.now()

        // Verificación de versión: si el flujo no corresponde a la última versión → ceder inmediatamente.
        if (Number(flowVersion || 0) !== Number(conv.version)) {
            defaultLogger.info('Flujo invalidado por versión (cede turno)', {
                phoneKey,
                phone,
                flowType,
                flowId,
                flowVersion,
                currentVersion: conv.version,
                bufferCount: conv.messages.length,
                action: 'conversation_invalidated_version_mismatch',
                file
            })
            return {
                acquired: false,
                cancelReason: 'version_mismatch',
                combinedInput: null,
                finalVersion: conv.version
            }
        }

        const silenceElapsed = conv.lastActivityAt ? (now - conv.lastActivityAt) : 0

        // ¿Hay algún mensaje pending todavía?
        const anyPending = conv.messages.some(m => m.status === 'pending')
        const allReady = conv.messages.length > 0 && !anyPending

        // ¿Ventana de silencio completada?
        const silenceCompleted = silenceElapsed >= SILENCE_WINDOW_MS

        // Estado de polling para logs (cada ~5s)
        if (!lastLogAt || (now - lastLogAt) > 5000) {
            lastLogAt = now
            defaultLogger.debug('Flujo esperando turno (polling)', {
                phoneKey,
                phone,
                flowType,
                flowId,
                flowVersion,
                currentVersion: conv.version,
                bufferCount: conv.messages.length,
                allReady,
                anyPending,
                silenceElapsedMs: silenceElapsed,
                remainingSilenceMs: Math.max(0, SILENCE_WINDOW_MS - silenceElapsed),
                action: 'conversation_polling_wait',
                file
            })
        }

        // Condición de adquirir turno:
        //   - soy la versión vigente (check arriba)
        //   - buffer no vacío
        //   - todos ready
        //   - silenceCompleted
        if (conv.messages.length > 0 && allReady && silenceCompleted) {
            const combinedInput = buildCombinedInput(phone, { file })
            defaultLogger.info('Flujo ADQUIERE turno y construye contexto combinado', {
                phoneKey,
                phone,
                flowType,
                flowId,
                flowVersion,
                currentVersion: conv.version,
                bufferCount: conv.messages.length,
                bufferTypes: conv.messages.map(m => m.type),
                silenceElapsedMs: silenceElapsed,
                combinedLength: String(combinedInput || '').length,
                action: 'conversation_turn_acquired',
                file
            })
            return {
                acquired: true,
                cancelReason: null,
                combinedInput,
                finalVersion: conv.version
            }
        }

        // Hard timeout de seguridad (15min) para no dejar polling colgado infinitamente.
        if ((now - startedAt) > MAX_WAIT_MS) {
            defaultLogger.warn('Flujo cancelado por timeout máximo de polling', {
                phoneKey,
                phone,
                flowType,
                flowId,
                flowVersion,
                currentVersion: conv.version,
                waitedMs: now - startedAt,
                maxWaitMs: MAX_WAIT_MS,
                action: 'conversation_polling_timeout',
                file
            })
            return {
                acquired: false,
                cancelReason: 'max_polling_timeout',
                combinedInput: null,
                finalVersion: conv.version
            }
        }

        // Esperar tick (no bloquea otros flujos; esto es un await no-bloqueante por event loop)
        await new Promise(res => setTimeout(res, POLL_TICK_MS))
    }
}

/**
 * Construye la entrada combinada ordenada cronológicamente.
 * SIN PREFIJOS [TEXTO]/[AUDIO]/[IMAGEN] — solo el contenido real del usuario,
 * separado por doble salto de línea entre mensajes.
 *
 * Formato final:
 *   "contenido del texto\n\ncontenido del audio transcrito\n\ncontenido de la imagen + caption"
 */
export const buildCombinedInput = (phone, { file = 'conversationBuffer.js' } = {}) => {
    const conv = ensureConversation(phone)
    if (conv.messages.length === 0) return ''

    const parts = []
    for (const m of conv.messages) {
        let body = String(m.content || '').trim()
        if (m.type === 'image' && m.caption && String(m.caption).trim()) {
            if (!body) body = `(contenido de la imagen sin texto). Caption del usuario: "${String(m.caption).trim()}"`
            else body = body + `\n\nCaption del usuario: "${String(m.caption).trim()}"`
        }
        if (body) parts.push(body)
    }
    const combined = parts.join('\n\n')

    defaultLogger.info('Contexto combinado construido (SIN prefijos)', {
        phoneKey: conv.key,
        phone,
        bufferCount: conv.messages.length,
        bufferTypes: conv.messages.map(m => m.type),
        combinedLength: combined.length,
        combinedPreview: combined.slice(0, 300),
        version: conv.version,
        action: 'conversation_combined_built',
        file
    })

    return combined
}

/**
 * Segunda validación: justo antes de enviar la respuesta al usuario,
 * comprobar que NO llegó otro mensaje físico (versión sigue igual)
 * durante la llamada a la IA.
 *
 * @returns {boolean} true → aún es la versión vigente, puede enviar. false → cancelar envío.
 */
export const isStillMyTurn = (phone, { flowVersion, file = 'conversationBuffer.js' } = {}) => {
    const conv = ensureConversation(phone)
    const ok = Number(flowVersion || 0) === Number(conv.version)
    defaultLogger.info('Segunda validación antes de enviar respuesta', {
        phoneKey: conv.key,
        phone,
        flowVersion,
        currentVersion: conv.version,
        isStillValid: ok,
        bufferCount: conv.messages.length,
        action: 'conversation_turn_pre_send_check',
        file
    })
    return ok
}

/**
 * Limpiar buffer ÚNICAMENTE después de que la respuesta se envió con éxito.
 * Elimina TODOS los mensajes acumulados de la conversación (todos los que
 * se procesaron en este bloque) y resetea lastActivityAt/version a 0.
 */
export const clearConversationAfterResponse = (phone, {
    finalVersion,
    file = 'conversationBuffer.js'
} = {}) => {
    const conv = ensureConversation(phone)
    const removedCount = conv.messages.length
    conv.messages = []
    // Solo si la versión actual coincide con la respondida, resetear última actividad.
    // Si entre que respondimos y el clear llegó otro mensaje (aunque sea raro por la 2ª validación),
    // conservar estado para no perderlo.
    if (finalVersion !== undefined && Number(conv.version) === Number(finalVersion)) {
        conv.lastActivityAt = 0
        conv.version = 0
    }
    defaultLogger.info('Buffer de conversación limpio (respuesta enviada OK)', {
        phoneKey: conv.key,
        phone,
        removedCount,
        finalVersion,
        currentVersion: conv.version,
        action: 'conversation_cleared_after_response',
        file
    })
    return { removedCount, phoneKey: conv.key }
}

/**
 * Wrapper para registrar desde Baileys raw message (lo usa el listener de app.js).
 * Es el punto más temprano donde conocemos número / tipo / id / timestamp real.
 */
export const addReceivedFromRawMessage = (message, { file = 'app.js' } = {}) => {
    try {
        if (!message || !message?.message) return null
        if (message?.key?.fromMe === true) return null

        const phone = extractPhoneFromRawMessage(message)
        if (!phone) return null

        const type = detectTypeFromRawMessage(message)
        if (!type || type === 'unknown') return null

        const messageId = message?.key?.id
        const messageTs = message?.messageTimestamp
            ? Number(message.messageTimestamp) * 1000
            : Date.now()

        let content = ''
        let caption = ''
        if (type === 'text') {
            content = extractTextContent(message)
            if (!content) return null
        } else if (type === 'image') {
            caption = extractImageCaption(message)
            content = placeholderFor('image', { caption })
        } else if (type === 'audio') {
            content = placeholderFor('audio')
        } else {
            content = placeholderFor(type)
        }

        return addReceivedMessage(phone, {
            messageId,
            type,
            content,
            caption,
            receivedAtMs: messageTs,
            file
        })
    } catch (error) {
        defaultLogger.error('Error al registrar mensaje raw desde listener Baileys', {
            error: error.message,
            stack: error.stack,
            remoteJid: message?.key?.remoteJid,
            action: 'conversation_raw_add_error',
            file
        })
        return null
    }
}
