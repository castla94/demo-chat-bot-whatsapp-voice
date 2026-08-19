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

// ============================================================
// Ventana de ESTABILIZACIÓN por ráfagas de mensajes rápidos.
// Fix: "envío 2/3/4 mensajes del mismo tipo seguidos y se invalida todo".
//
// Cuando el usuario envía mensajes MUY rápido (ej, 4 mensajes de texto seguidos
// en menos de 1s), los listeners internos de BuilderBot (disparar addKeyword)
// y NUESTRO listener (addReceivedFromRawMessage) compiten por orden.
// Un flujo puede nacer con flowVersion desfasado por 1 ó 2 versiones
// simplemente porque nuestro listener corrió 50ms después.
//
// Solución 2 capas:
//   1) FLOW_VERSION_STABILIZATION_MS = 3000ms: mientras la última actividad
//      del usuario sea hace <3s NO CEDER POR VERSIÓN DESFASADA.
//      Dejamos que las versiones se "asienten" en la conversación.
//      Pasados los 3s → sí ceder normalmente.
//   2) MY_MESSAGE_ENTRY_WAIT_MS = 4000ms, polling 100ms: cada flow espera
//      ACTIVAMENTE hasta que SU MENSAJE (el que le disparó) aparezca
//      en el buffer (por messageId o por contenido match). Cuando lo
//      encuentra, toma flowVersion = entry.version de ESE mensaje.
//      Así sin importar el orden de listeners, nace con la correcta.
// ============================================================
const FLOW_VERSION_STABILIZATION_MS = 3 * 1000
const MY_MESSAGE_ENTRY_TICK_MS = 100
const MY_MESSAGE_ENTRY_WAIT_MS = 4 * 1000

// ============================================================
// TTL (Time To Live) para invalidaciones por desfase de versión
// ============================================================
// Fix DESFASE VERSIÓN HUÉRFANA:
//   Si un flow cede por version_mismatch pero luego NUNCA llega un
//   nuevo flow BuilderBot que haga polling por la nueva versión
//   (porque BuilderBot no disparó addKeyword consecutivo, etc.),
//   la conversación quedaba en limbo infinito.
//
// Solución:
//   1) ORPHAN_RESCUE_MS = SILENCE_WINDOW_MS (45s): después de invalidación,
//      si el siguiente flow que intenta ceder detecta que ya pasaron 45s
//      de silencio y hay mensajes listos → ÉL MISMO rescata y responde
//      (aunque no sea "su" versión).
//   2) INVALIDATION_RESET_TTL_MS = 30 * 1000: si desde la invalidación
//      pasan 30s Y NADIE ha cambiado la versión (ni rescató ni respondió),
//      se hace RESET COMPLETO de la conversación (version=0, messages=[]).
//      El siguiente mensaje de texto empieza desde 0, sin desfase.
//   3) GREETINGS_RESET: si el usuario escribe "hola/buenos días/etc"
//      y la conversación está huérfana (≥2min sin responder) → reset.
// ============================================================
const INVALIDATION_RESET_TTL_MS = 30 * 1000
const GREETINGS_ORPHAN_RESET_MS = 2 * 60 * 1000
const GREETINGS_KEYWORDS = ['hola', 'buenos dias', 'buenas tardes', 'buenas noches', 'que tal', 'alo', 'buen dia', 'holi', 'holaa', 'hey', 'hi', 'hello']

// ============================================================
// TIPOS DE MENSAJE SOPORTADOS (VÁLIDOS) PARA LA COORDINACIÓN.
// CUALQUIER otro tipo (sticker, video, document, unknown, reaction, poll, etc.)
// SERÁ COMPLETAMENTE IGNORADO:
//   - NO incrementa version global
//   - NO se agrega al buffer
//   - NO causa invalidaciones ni flujos nuevos
// Así evitamos el "limbo": versión nueva sin flow que la procese.
// ============================================================
const SUPPORTED_TYPES = new Set(['text', 'audio', 'image'])

const isValidType = (type) => SUPPORTED_TYPES.has(String(type || '').toLowerCase())

const isGreetingText = (s) => {
    const t = String(s || '').toLowerCase().trim()
    if (!t) return false
    return GREETINGS_KEYWORDS.some(g => t === g || t.startsWith(g + ' ') || t.startsWith(g + ','))
}

const conversations = new Map()

// Limpiar timer de invalidación de una conversación (si existe)
const clearInvalidationTimer = (conv) => {
    try {
        if (conv && conv.metadata && conv.metadata.invalidationTimer) {
            clearTimeout(conv.metadata.invalidationTimer)
            conv.metadata.invalidationTimer = null
        }
    } catch (_) { /* no-op */ }
}

// Programar timer TTL 30s de reset por invalidación huérfana.
// Solo se programa UNA VEZ por invalidación (no re-armar timer si ya hay uno corriendo).
const scheduleInvalidationReset = (conv, phoneKey, phone, callerFile) => {
    if (!conv) return
    // Si ya hay un timer programado, no volver a armar
    if (conv.metadata && conv.metadata.invalidationTimer) return

    const invalidationVersionAtSchedule = Number(conv.version || 0)
    conv.metadata.invalidationVersionExpected = invalidationVersionAtSchedule
    conv.metadata.invalidatedAt = Date.now()

    defaultLogger.info('Programando TTL 30s reset por invalidación huérfana', {
        phoneKey: conv.key,
        phone,
        invalidatedAt: new Date(conv.metadata.invalidatedAt).toISOString(),
        expectedVersionAfterTTL: invalidationVersionAtSchedule,
        action: 'conversation_invalidation_ttl_scheduled',
        file: callerFile
    })

    conv.metadata.invalidationTimer = setTimeout(() => {
        try {
            // Si el timer vence y la versión SIGUE SIENDO LA MISMA que cuando se invalidó
            // significa que NADIE vino a rescatar ni a responder → huérfana confirmada → RESET COMPLETO.
            const stillSameVersion = Number(conv.version || 0) === invalidationVersionAtSchedule
            defaultLogger.info('TTL 30s invalidación vence, check versión...', {
                phoneKey: conv.key,
                phone,
                currentVersion: Number(conv.version || 0),
                expectedVersionAtSchedule: invalidationVersionAtSchedule,
                stillSameVersion,
                meaningfulCount: (conv.messages.filter(m => isValidType(m.type))).length,
                action: 'conversation_invalidation_ttl_fired',
                file: callerFile
            })
            if (stillSameVersion) {
                clearInvalidationTimer(conv)
                conv.metadata.invalidationVersionExpected = 0
                conv.metadata.invalidatedAt = 0
                conv.messages = []
                conv.version = 0
                conv.lastActivityAt = 0
                defaultLogger.info('Conversación reseteada por TTL 30s invalidación huérfana', {
                    phoneKey: conv.key,
                    phone,
                    versionResetFrom: invalidationVersionAtSchedule,
                    action: 'conversation_invalidation_ttl_reset_done',
                    file: callerFile
                })
            }
        } catch (err) {
            defaultLogger.error('Error en TTL invalidación reset', {
                phoneKey: conv?.key,
                phone,
                error: err.message,
                action: 'conversation_invalidation_ttl_error',
                file: callerFile
            })
        }
    }, INVALIDATION_RESET_TTL_MS)
}

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
            metadata: {
                invalidatedAt: 0,
                invalidationVersionExpected: 0,
                invalidationTimer: null
            },
            cleanupTimer: null,
            // ============================================================
            // turnAcquiredLock: previene 2 calls run() duplicadas.
            // Cuando un flujo (mismo tipo u otro) ADQUIERE el turno (allReady + 45s)
            // se marca turnAcquiredLock = { flowId, flowType, flowVersion, at }.
            // Cualquier otro flujo que intente adquirir después (incluso mismo tipo,
            // antes de que se haga clearConversationAfterResponse) → NO adquiere y cede.
            // Se limpia en clearConversationAfterResponse() o MAX_WAIT_MS timeout.
            // ============================================================
            turnAcquiredLock: null
        })
    }
    return conversations.get(key)
}

/**
 * Helper: devuelve el ÚLTIMO mensaje (por receivedAt desc) de TIPOS SOPORTADOS
 * (text/audio/image). No cuenta stickers, documents, videos, etc.
 * Si no hay -> null.
 */
const getLastMeaningfulMessage = (conv) => {
    if (!conv || !conv.messages || conv.messages.length === 0) return null
    const meaningful = conv.messages.filter(m => isValidType(m.type))
    if (meaningful.length === 0) return null
    meaningful.sort((a, b) => Number(b.receivedAt || 0) - Number(a.receivedAt || 0))
    return meaningful[0]
}

// ============================================================
// ✅ NUEVA FUNCIÓN: waitForMyMessageEntryInBuffer
// ============================================================
// Fix RACE CONDITION (orden de listeners Baileys).
//
// Cada flujo BuilderBot (chatbot/voice/media) nace SIN SABER cuál es su
// propia entry en el buffer (porque el listener de coordinación
// addReceivedFromRawMessage puede correrse DESPUÉS del addAction de BBot).
//
// Solución: el flujo usa esta función para ESPERAR ACTIVAMENTE
// a que SU PROPIO MENSAJE aparezca en conv.messages, y así tomar
// flowVersion = entry.version de ESE mensaje (no conv.version general
// que podría ser más alta por otros mensajes).
//
// Busca un mensaje por:
//   1) MATCH EXACTO por messageId (ctx.key.id): match ideal.
//   2) FALLBACK: por type coincidente + receivedAt muy cercano (últimos 4s)
//      + (contentCandidate no vacío = contenido similar).
//
// Retorna: { version (entry.version), entryId, messageId, fromCache }
//   o si timeout -> fallback { version: conv.version }
// ============================================================
/**
 * @param phone string
 * @param type 'text'|'audio'|'image'
 * @param messageId string|null ctx.key.id (id del mensaje según BuilderBot/Baileys
 * @param contentCandidate string|null contenido aprox (ctx.body para texto, caption para image, '' audio)
 * @param file string caller file for logs
 */
export const waitForMyMessageEntryInBuffer = async (phone, {
    type = 'text',
    messageId = null,
    contentCandidate = null,
    file = 'conversationBuffer.js'
} = {}) => {
    const phoneKey = normalizeKey(phone)
    const conv = ensureConversation(phone)
    const typeNorm = String(type || '').toLowerCase()
    const startedAt = Date.now()
    const idTarget = String(messageId || '').trim()
    const contentNorm = String(contentCandidate || '').trim()

    defaultLogger.info('waitForMyMessageEntryInBuffer: esperando a que mi mensaje entre al buffer', {
        phoneKey, phone,
        type: typeNorm,
        messageId: idTarget,
        contentLength: contentNorm.length,
        contentPreview: contentNorm.slice(0, 100),
        currentVersionAtStart: conv.version,
        currentBufferCountAtStart: conv.messages.length,
        action: 'conversation_wait_my_entry_start',
        file
    })

    // Función: buscar en conv.messages mi entry propia.
    const findMyEntry = () => {
        // Intento 1: match por messageId
        if (idTarget) {
            const byId = conv.messages.find(m =>
                (String(m.id) === idTarget || String(m.messageId) === idTarget)
                && (!typeNorm ? String(m.type).toLowerCase() === typeNorm : true)
            )
            if (byId) return { entry: byId, matchedBy: 'messageId' }
        }
        // Intento 2: match por tipo + receivedAt reciente + contenido similar
        const recentItems = conv.messages
            .filter(m => String(m.type).toLowerCase() === typeNorm)
            .sort((a, b) => Number(b.receivedAt || 0) - Number(a.receivedAt || 0))
        if (recentItems.length === 0) return null
        const entry = recentItems[0] // el ÚLTIMO de este tipo
        const ageMs = startedAt - Number(entry.receivedAt || startedAt)
        if (ageMs < 0 || ageMs > MY_MESSAGE_ENTRY_WAIT_MS + 1000) return null
        // Si hay contenido candidato → chequear similaridad
        if (contentNorm) {
            const entryContent = String(entry.content || '').trim()
            const entryCaption = String(entry.caption || '').trim()
            const matchContent = contentNorm && (
                entryContent.startsWith(contentNorm.slice(0, 20))
                || entryCaption.startsWith(contentNorm.slice(0, 20))
                || contentNorm.startsWith(entryContent.slice(0, 20))
            )
            if (!matchContent && entryContent.length > 0) {
                // No hay contenido de confianza → mirar si solo 1 candidato en ventana
                const candidatesInWindow = recentItems.filter(m =>
                    (startedAt - Number(m.receivedAt || startedAt)) >= -500
                    && (startedAt - Number(m.receivedAt || startedAt)) <= MY_MESSAGE_ENTRY_WAIT_MS + 1000
                )
                if (candidatesInWindow.length === 1) {
                    return { entry: candidatesInWindow[0], matchedBy: 'onlyRecentCandidateInWindow' }
                }
                return null
            }
        }
        return { entry, matchedBy: 'recentTypeMatch' }
    }

    let lastFoundLog = 0
    while (true) {
        const now = Date.now()
        const found = findMyEntry()
        if (found) {
            defaultLogger.info('waitForMyMessageEntryInBuffer: encontrada mi entry en buffer', {
                phoneKey, phone,
                type: typeNorm,
                waitedMs: now - startedAt,
                matchedBy: found.matchedBy,
                myVersion: Number(found.entry.version),
                myEntryId: found.entry.id,
                myMessageId: found.entry.messageId,
                receivedAt: new Date(found.entry.receivedAt || 0).toISOString(),
                bufferCountNow: conv.messages.length,
                currentGlobalVersionNow: conv.version,
                action: 'conversation_wait_my_entry_found',
                file
            })
            return {
                version: Number(found.entry.version),
                entryId: found.entry.id,
                messageId: found.entry.messageId,
                matchedBy: found.matchedBy
            }
        }
        // Timeout → retornar fallback de conv.version + warn
        if ((now - startedAt) >= MY_MESSAGE_ENTRY_WAIT_MS) {
            const fallbackVersion = conv.version || 0
            defaultLogger.warn('waitForMyMessageEntryInBuffer: TIMEOUT. Fallback a conv.version actual', {
                phoneKey, phone,
                type: typeNorm,
                waitedMs: MY_MESSAGE_ENTRY_WAIT_MS,
                fallbackVersion,
                bufferCountNow: conv.messages.length,
                messageId: idTarget,
                contentPreview: contentNorm.slice(0, 100),
                action: 'conversation_wait_my_entry_timeout_fallback',
                file
            })
            return {
                version: Number(fallbackVersion),
                entryId: null,
                messageId: idTarget || null,
                matchedBy: 'timeout_fallback_global_version'
            }
        }
        // Log cada ~1s
        if (!lastFoundLog || (now - lastFoundLog) > 1000) {
            lastFoundLog = now
            defaultLogger.debug('waitForMyMessageEntryInBuffer: esperando siguiente tick', {
                phoneKey, phone,
                type: typeNorm,
                waitedMs: now - startedAt,
                remainingMs: MY_MESSAGE_ENTRY_WAIT_MS - (now - startedAt),
                currentBufferCount: conv.messages.length,
                action: 'conversation_wait_my_entry_tick',
                file
            })
        }
        await new Promise(res => setTimeout(res, MY_MESSAGE_ENTRY_TICK_MS))
    }
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
    // ============================================================
    // BLOQUEO TIPOS NO SOPORTADOS (protección limbo / versión huérfana).
    // Si el tipo NO es text/audio/image -> IGNORAR COMPLETAMENTE:
    //   - no incrementa version
    //   - no entra al buffer
    //   - no causa invalidaciones
    // ============================================================
    const typeNorm = String(type || '').toLowerCase()
    if (!isValidType(typeNorm)) {
        defaultLogger.info('Tipo de mensaje NO SOPORTADO por coordinación: ignorado completamente', {
            phone: phone ? String(phone) : '',
            messageId: messageId ? String(messageId) : '',
            type: typeNorm,
            action: 'conversation_type_ignored_unsupported',
            file
        })
        return null
    }

    const conv = ensureConversation(phone)
    const id = String(messageId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)

    // ============================================================
    // Fix C: GREETINGS + ORPHAN RESET ANTES DE INSERTAR NUEVO MENSAJE
    // Si la conversación está huérfana:
    //   - tiene metadata.invalidatedAt (hubo una invalidación)
    //   - O han pasado más de GREETINGS_ORPHAN_RESET_MS (2min) desde lastActivityAt
    //     Y el usuario ESCRIBE UN SALUDO (hola/buenos dias/que tal/etc.)
    // → Hacemos RESET COMPLETO ANTES de insertar este nuevo mensaje
    //   para que empiece desde cero sin desfase de versión.
    // ============================================================
    const now = Date.now()
    const greetingsText = (typeNorm === 'text') ? String(content || '') : ''
    const hasOldInvalidation = !!(conv.metadata && conv.metadata.invalidatedAt && (now - Number(conv.metadata.invalidatedAt)) >= INVALIDATION_RESET_TTL_MS)
    const hasOrphanExpired = (conv.messages.length > 0 && conv.lastActivityAt && (now - conv.lastActivityAt) >= GREETINGS_ORPHAN_RESET_MS)
    const isGreeting = isGreetingText(greetingsText)
    const shouldResetBeforeInsert = (conv.version > 0 && conv.messages.length > 0 && (
        hasOldInvalidation || (hasOrphanExpired && isGreeting)
    ))

    if (shouldResetBeforeInsert) {
        clearInvalidationTimer(conv)
        defaultLogger.info('Reset de conversación HUÉRFANA antes de insertar nuevo mensaje', {
            phoneKey: conv.key,
            phone,
            whyResetBecause: [
                hasOldInvalidation ? 'old_invalidation_expired' : null,
                (hasOrphanExpired && isGreeting) ? 'greeting_after_orphan_expired' : null
            ].filter(Boolean).join('+'),
            hasOldInvalidation,
            hasOrphanExpired,
            isGreeting,
            greetingsText: greetingsText ? greetingsText.slice(0, 100) : '',
            versionBeforeReset: conv.version,
            messagesBeforeResetCount: conv.messages.length,
            lastActivityAt: conv.lastActivityAt ? new Date(conv.lastActivityAt).toISOString() : null,
            invalidatedAt: conv.metadata?.invalidatedAt ? new Date(conv.metadata.invalidatedAt).toISOString() : null,
            action: 'conversation_orphan_reset_before_insert',
            file
        })
        conv.metadata.invalidatedAt = 0
        conv.metadata.invalidationVersionExpected = 0
        conv.messages = []
        conv.version = 0
        conv.lastActivityAt = 0
    }

    // ============================================================
    // Cancelar timer TTL invalidación cuando LLEGA NUEVA ACTIVIDAD VÁLIDA.
    // Si había un timer de reset programado porque antes y ahora viene un nuevo mensaje
    // significa que el usuario sigue interactuando (o hay flows vivos.
    // No hay que resetear nada: cancelar el timer.
    // ============================================================
    if (!shouldResetBeforeInsert && conv.metadata && conv.metadata.invalidationTimer) {
        defaultLogger.info('Cancelado TTL invalidación por nueva actividad válida', {
            phoneKey: conv.key,
            phone,
            incomingType: typeNorm,
            action: 'conversation_invalidation_ttl_cancelled_by_activity',
            file
        })
        clearInvalidationTimer(conv)
        conv.metadata.invalidatedAt = 0
        conv.metadata.invalidationVersionExpected = 0
    }

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
    const meaningfulMessages = conv.messages.filter(m => isValidType(m.type))
    const anyPendingMeaningful = meaningfulMessages.some(m => m.status === 'pending')
    return {
        phoneKey: conv.key,
        version: conv.version,
        lastActivityAt: conv.lastActivityAt,
        bufferCount: conv.messages.length,
        meaningfulCount: meaningfulMessages.length,
        unsupportedCount: conv.messages.length - meaningfulMessages.length,
        bufferTypes: conv.messages.map(m => m.type),
        // FIX LIMBO: allReady ya se calcula solo sobre tipos válidos (diagnóstico correcto)
        allReady: meaningfulMessages.length === 0 ? false : !anyPendingMeaningful,
        anyPendingMeaningful,
        messages: conv.messages.map(m => ({
            id: m.id, messageId: m.messageId, type: m.type,
            status: m.status, receivedAt: m.receivedAt, processedAt: m.processedAt,
            version: m.version,
            meaningful: isValidType(m.type)
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
    // FIX LIMBO: solo considera pendientes los tipos SOPORTADOS (text/audio/image).
    // Un sticker pending no debe considerarse "mensaje pendiente que espera procesamiento".
    return conv.messages.some(m => isValidType(m.type) && m.status === 'pending')
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
    // FIX LIMBO: tipo no soportado retorna null inmediatamente.
    if (!isValidType(typeNorm)) return null
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

        // ============================================================
        // NUEVA REGLA DE INVALIDACIÓN (POR TIPO DE MENSAJE, NO POR VERSIÓN):
        //
        //  🟢 MISMO TIPO que el ÚLTIMO mensaje (text→text, audio→audio, image→image):
        //     NUNCA INVALIDAR, NUNCA CEDER, NUNCA PROGRAMAR TTL.
        //     Esperar hasta 45s silencio y responder combinado.
        //
        //  🔴 TIPO DISTINTO que el ÚLTIMO mensaje (text→image, audio→text, etc):
        //     SÍ INVALIDAR (ceder) + ORPHAN RESCUE si corresponde.
        //
        // La ventana de estabilización 3s sigue aplicando: si la última actividad
        // es <3s y TIPO DISTINTO, esperamos a ver si el usuario sigue escribiendo
        // (evitamos invalidar texto por una imagen que llegó 0.5s después y luego
        //  otro texto 1s después → 3 cambios de tipo en 2s).
        // ============================================================
        const lastMeaningful = getLastMeaningfulMessage(conv)
        const lastMeaningfulType = lastMeaningful ? String(lastMeaningful.type).toLowerCase() : null
        const flowTypeNorm = String(flowType || '').toLowerCase()
        const sinceLastActivity = conv.lastActivityAt ? (now - conv.lastActivityAt) : FLOW_VERSION_STABILIZATION_MS + 1
        const inStabilizationWindow = sinceLastActivity < FLOW_VERSION_STABILIZATION_MS

        let shouldCede = false
        let cedeReason = null

        if (lastMeaningfulType && flowTypeNorm && (flowTypeNorm !== lastMeaningfulType)) {
            // TIPO DISTINTO al último mensaje significativo.
            if (inStabilizationWindow) {
                // pero <3s de la última actividad: NO CEDER TODAVÍA (ventana estabilización)
                if (!lastLogAt || (now - lastLogAt) > 1000) {
                    lastLogAt = now
                    defaultLogger.debug('Flujo TIPO DISTINTO pero <3s de última actividad: no cede (ventana estabilización)', {
                        phoneKey, phone,
                        flowType: flowTypeNorm,
                        lastType: lastMeaningfulType,
                        sinceLastActivityMs: sinceLastActivity,
                        flowVersion, currentVersion: conv.version,
                        action: 'conversation_invalidation_skipped_stabilization_window',
                        file
                    })
                }
                // skip cede → continue con abajo (acquire check)
                shouldCede = false
            } else {
                shouldCede = true
                cedeReason = 'different_type_from_last_message'
            }
        } else {
            // MISMO TIPO o sin mensajes todavía → NO CEDER NUNCA.
            // Incluso aunque flowVersion sea 1 y conv.version sea 5 (textos 2,3,4).
            // El flujo TEXTO1 original sigue vivo para esperar los 45s y responder.
            shouldCede = false
        }

        if (shouldCede) {
            // ============================================================
            // ORPHAN RESCUE antes de ceder (igual que antes, pero ahora POR TIPO).
            // ============================================================
            const meaningfulMessagesCurr = conv.messages.filter(m => isValidType(m.type))
            const anyPendingMeaningfulCurr = meaningfulMessagesCurr.some(m => m.status === 'pending')
            const allReadyMeaningfulCurr = meaningfulMessagesCurr.length > 0 && !anyPendingMeaningfulCurr
            const silenceElapsedCurr = conv.lastActivityAt ? (now - conv.lastActivityAt) : 0
            const silenceCompletedCurr = silenceElapsedCurr >= SILENCE_WINDOW_MS

            if (meaningfulMessagesCurr.length > 0 && allReadyMeaningfulCurr && silenceCompletedCurr) {
                const combinedInput = buildCombinedInput(phone, { file })
                defaultLogger.warn('ORPHAN RESCUE (por tipo): flujo tipo viejo rescata conversación huérfana y responde', {
                    phoneKey, phone,
                    flowType: flowTypeNorm,
                    lastType: lastMeaningfulType,
                    flowId,
                    flowVersion, currentVersion: conv.version,
                    bufferCount: conv.messages.length,
                    meaningfulCount: meaningfulMessagesCurr.length,
                    bufferTypes: meaningfulMessagesCurr.map(m => m.type),
                    silenceElapsedMs: silenceElapsedCurr,
                    combinedLength: String(combinedInput || '').length,
                    action: 'conversation_orphan_rescue_acquired',
                    file
                })
                clearInvalidationTimer(conv)
                if (conv.metadata) {
                    conv.metadata.invalidatedAt = 0
                    conv.metadata.invalidationVersionExpected = 0
                }
                return {
                    acquired: true,
                    cancelReason: null,
                    combinedInput,
                    finalVersion: conv.version,
                    orphanRescue: true
                }
            }

            // ============================================================
            // PROGRAMAR TTL 30s reset (si nadie vino en 30s → resetear).
            // ============================================================
            scheduleInvalidationReset(conv, phoneKey, phone, file)

            defaultLogger.info('Flujo invalidado CEDIDO por TIPO DISTINTO al último mensaje (nuevo tipo vigente)', {
                phoneKey,
                phone,
                flowType: flowTypeNorm,
                lastType: lastMeaningfulType,
                flowId,
                flowVersion,
                currentVersion: conv.version,
                bufferCount: conv.messages.length,
                meaningfulCount: (conv.messages.filter(m => isValidType(m.type))).length,
                cedeReason,
                sinceLastActivityMs: sinceLastActivity,
                invalidationTtlScheduled: Boolean(conv.metadata?.invalidationTimer),
                invalidationExpectedVersion: conv.metadata?.invalidationVersionExpected || 0,
                action: 'conversation_invalidated_different_type',
                file
            })
            return {
                acquired: false,
                cancelReason: cedeReason || 'different_type_from_last_message',
                combinedInput: null,
                finalVersion: conv.version
            }
        }

        const silenceElapsed = conv.lastActivityAt ? (now - conv.lastActivityAt) : 0

        // ============================================================
        // FIX LIMBO: SOLO considerar mensajes de TIPOS VÁLIDOS (text/audio/image)
        // para las condiciones de "allReady" y "buffer no vacío".
        //
        // Si históricamente se colaron tipos no soportados (sticker, document, video, etc.)
        // con status='pending' (o cualquier estado), LOS IGNORAMOS COMPLETAMENTE.
        // De lo contrario, un único sticker pendiente bloquea TODO el ciclo para siempre
        // (ya que no hay flow BuilderBot que lo marque ready) → limbo sin respuesta.
        // ============================================================
        const meaningfulMessages = conv.messages.filter(m => isValidType(m.type))
        const anyPendingMeaningful = meaningfulMessages.some(m => m.status === 'pending')
        const allReadyMeaningful = meaningfulMessages.length > 0 && !anyPendingMeaningful

        // ¿Hay algún mensaje pending todavía? (legacy, solo para logs)
        const anyPending = conv.messages.some(m => m.status === 'pending')
        const allReady = allReadyMeaningful  // ← ESTE es el que usamos para adquirir turno

        // ¿Ventana de silencio completada?
        const silenceCompleted = silenceElapsed >= SILENCE_WINDOW_MS

        // Estado de polling para logs (cada ~5s)
        if (!lastLogAt || (now - lastLogAt) > 5000) {
            lastLogAt = now
            defaultLogger.debug('Flujo esperando turno (polling)', {
                phoneKey,
                phone,
                flowType: flowTypeNorm,
                lastType: lastMeaningfulType,
                flowId,
                flowVersion,
                currentVersion: conv.version,
                inStabilizationWindow,
                sinceLastActivityMs: sinceLastActivity,
                bufferCount: conv.messages.length,
                meaningfulCount: meaningfulMessages.length,
                unsupportedCount: conv.messages.length - meaningfulMessages.length,
                allReady,
                allReadyMeaningful,
                anyPending,
                anyPendingMeaningful,
                silenceElapsedMs: silenceElapsed,
                remainingSilenceMs: Math.max(0, SILENCE_WINDOW_MS - silenceElapsed),
                // info turn lock
                turnAcquiredByOther: Boolean(conv.turnAcquiredLock),
                turnLockOwnerFlowId: conv.turnAcquiredLock?.flowId || null,
                turnLockOwnerType: conv.turnAcquiredLock?.flowType || null,
                action: 'conversation_polling_wait',
                file
            })
        }

        // ============================================================
        // TURNO DUPLICADO PROTECCIÓN (turnAcquiredLock):
        //   Si otro flujo (mismo tipo o distinto) YA ADQUIRIÓ el turno previamente
        //   y está procesando IA / enviando / esperando clearConversation →
        //   ESTE flujo cede inmediatamente para no duplicar respuesta.
        // ============================================================
        if (conv.turnAcquiredLock) {
            defaultLogger.info('Flujo NO adquiere turno: otro flujo ya lo adquirió (turnAcquiredLock)', {
                phoneKey, phone,
                flowType: flowTypeNorm,
                flowId,
                myFlowVersion: flowVersion,
                turnLockOwnerFlowId: conv.turnAcquiredLock?.flowId,
                turnLockOwnerType: conv.turnAcquiredLock?.flowType,
                turnLockOwnerVersion: conv.turnAcquiredLock?.flowVersion,
                turnLockAt: conv.turnAcquiredLock?.at ? new Date(conv.turnAcquiredLock.at).toISOString() : null,
                action: 'conversation_ceded_turn_already_acquired',
                file
            })
            return {
                acquired: false,
                cancelReason: 'turn_already_acquired_other_flow',
                combinedInput: null,
                finalVersion: conv.version
            }
        }

        // Condición de adquirir turno:
        //   - soy el tipo vigente (ya no hay shouldCede arriba)
        //   - meaningfulMessages no vacío (al menos 1 text/audio/image)
        //   - todos los meaningful están ready
        //   - silenceCompleted
        if (meaningfulMessages.length > 0 && allReadyMeaningful && silenceCompleted) {
            // MARCAR LOCK antes de construir combined.
            conv.turnAcquiredLock = {
                flowId, flowType: flowTypeNorm, flowVersion, at: now
            }
            const combinedInput = buildCombinedInput(phone, { file })
            defaultLogger.info('Flujo ADQUIERE turno y construye contexto combinado', {
                phoneKey,
                phone,
                flowType: flowTypeNorm,
                lastType: lastMeaningfulType,
                flowId,
                flowVersion,
                currentVersion: conv.version,
                bufferCount: conv.messages.length,
                meaningfulCount: meaningfulMessages.length,
                bufferTypes: meaningfulMessages.map(m => m.type),
                silenceElapsedMs: silenceElapsed,
                combinedLength: String(combinedInput || '').length,
                turnLockAcquired: true,
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
            // Antes de salir por timeout: limpiar lock turno si SOY el dueño (no limpiar de otros).
            if (conv.turnAcquiredLock && conv.turnAcquiredLock.flowId === flowId) {
                conv.turnAcquiredLock = null
                defaultLogger.info('MAX WAIT TIMEOUT: limpié turnAcquiredLock propio por seguridad', {
                    phoneKey, phone, flowId, flowTypeNorm: String(flowType||'').toLowerCase(),
                    action: 'conversation_polling_timeout_cleared_own_lock',
                    file
                })
            }
            defaultLogger.warn('Flujo cancelado por timeout máximo de polling', {
                phoneKey,
                phone,
                flowType,
                flowId,
                flowVersion,
                currentVersion: conv.version,
                waitedMs: now - startedAt,
                maxWaitMs: MAX_WAIT_MS,
                // info lock final
                turnLockOwnerFlowId: conv.turnAcquiredLock?.flowId || null,
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

    // ============================================================
    // FIX LIMBO: SOLO incluir en el combined input TIPOS VÁLIDOS
    // (text/audio/image). Ignorar sticker/document/video/unknown
    // que se pudieron colar históricamente (no deben contaminar el prompt a la IA).
    // ============================================================
    const meaningfulMessages = conv.messages.filter(m => isValidType(m.type))
    if (meaningfulMessages.length === 0) return ''

    const parts = []
    for (const m of meaningfulMessages) {
        let body = String(m.content || '').trim()
        if (m.type === 'image' && m.caption && String(m.caption).trim()) {
            if (!body) body = `(contenido de la imagen sin texto). Caption del usuario: "${String(m.caption).trim()}"`
            else body = body + `\n\nCaption del usuario: "${String(m.caption).trim()}"`
        }
        if (body) parts.push(body)
    }
    const combined = parts.join('\n\n')

    defaultLogger.info('Contexto combinado construido (SIN prefijos + solo tipos válidos)', {
        phoneKey: conv.key,
        phone,
        bufferCount: conv.messages.length,
        meaningfulCount: meaningfulMessages.length,
        bufferTypes: meaningfulMessages.map(m => m.type),
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
 *
 * También limpia cualquier timer de invalidación huérfana (ya que la respuesta
 * fue enviada con éxito, no hay nada que rescatar ni resetear).
 */
export const clearConversationAfterResponse = (phone, {
    finalVersion,
    file = 'conversationBuffer.js'
} = {}) => {
    const conv = ensureConversation(phone)
    const totalBeforeCount = conv.messages.length

    // ============================================================
    // FIX IMPORTANTE: NUNCA PERDER MENSAJES NUEVOS QUE LLEGARON
    // DURANTE EL PROCESAMIENTO DE LA IA.
    //
    // Escenario normal:
    //   T=0s Usuario envía msg 1 (version=1)
    //   T=45s Flujo adquiere turno, llama a run()
    //   T=48s (mientras IA piensa) Usuario envía msg 2 (version=2)
    //   T=50s run() termina, flujo original responde con version finalVersion=1
    //   T=50s clearConversationAfterResponse(1) es llamado.
    //
    // ANTES: conv.messages = [] (TODO borrado). msg 2 se perdía. 🔴
    // AHORA: solo borro mensajes con version<=1. msg 2 se conserva! 🟢
    //
    // Así el msg 2 (version=2) activará BuilderBot addKeyword automáticamente
    // y se procesará en un FLUJO NUEVO COMPLETAMENTE INDEPENDIENTE,
    // tal como pidió explícitamente la regla de negocio.
    // ============================================================
    let removedCount = 0
    let preservedCount = 0
    let preservedVersions = []
    if (finalVersion !== undefined && Number(conv.version) !== Number(finalVersion)) {
        // Caso: HUBO MENSAJES NUEVOS DURANTE IA. Conservarlos.
        const currentTotal = totalBeforeCount
        conv.messages = conv.messages.filter(m => {
            if (Number(m.version || 0) <= Number(finalVersion)) {
                removedCount++
                return false // eliminar
            }
            preservedCount++
            preservedVersions.push(Number(m.version || 0))
            return true // conservar
        })
        defaultLogger.info('Clear post-respuesta: hubo mensajes nuevos durante IA → CONSERVADOS (flujo nuevo independiente)', {
            phoneKey: conv.key,
            phone,
            totalBeforeCount,
            removedOlderVersions: removedCount,
            preservedNewerCount: preservedCount,
            preservedVersions: preservedCount < 20 ? preservedVersions : `${preservedCount} items (omit list)`,
            finalVersionResponded: Number(finalVersion),
            currentVersionStill: Number(conv.version),
            lastActivityStill: conv.lastActivityAt ? new Date(conv.lastActivityAt).toISOString() : null,
            note: 'LOS MENSAJES CONSERVADOS SERÁN PROCESADOS EN UN FLUJO NUEVO DE BUILDERBOT',
            action: 'conversation_cleared_preserved_new_messages',
            file
        })
    } else {
        // Caso: NO hubo mensajes nuevos durante IA → limpiar todo normal.
        removedCount = totalBeforeCount
        preservedCount = 0
        conv.messages = []
    }

    // ============================================================
    // Fix D: Cancelar timer TTL invalidación después de RESPUESTA EXITOSA.
    // ============================================================
    clearInvalidationTimer(conv)
    if (conv.metadata) {
        conv.metadata.invalidatedAt = 0
        conv.metadata.invalidationVersionExpected = 0
    }

    // ============================================================
    // Limpiar lock de adquirir turno (otro flujo podría correr luego).
    conv.turnAcquiredLock = null

    // Resetear version/lastActivityAt SÓLO cuando NO se conservaron mensajes nuevos
    // (es decir, cuando respondimos la versión actual con exactamente la misma).
    // Si conservamos mensajes nuevos, NO reseteamos (de lo contrario la versión
    // de esos mensajes nuevos quedaría huérfana con un version=0 global y todo).
    if (finalVersion !== undefined && Number(conv.version) === Number(finalVersion)) {
        conv.lastActivityAt = 0
        conv.version = 0
    }
    defaultLogger.info('Buffer de conversación limpio (respuesta enviada OK)', {
        phoneKey: conv.key,
        phone,
        totalBeforeCount,
        removedCount,
        preservedCount,
        finalVersion,
        currentVersion: conv.version,
        invalidationTimerCancelled: !(conv.metadata && conv.metadata.invalidationTimer),
        turnLockCleared: true,
        preservedNewerMessagesExist: preservedCount > 0,
        note: preservedCount > 0 ? 'NUEVO FLUJO BuilderBot disparará para mensajes conservados' : null,
        action: 'conversation_cleared_after_response',
        file
    })
    return { removedCount, preservedCount, phoneKey: conv.key }
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
