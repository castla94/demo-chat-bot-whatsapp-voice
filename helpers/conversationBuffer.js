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
//   2) pasó la ventana dinámica de silencio desde el último mensaje
//        - Texto / Audio: 5s
//        - Imagen (último mensaje): 45s (da tiempo al usuario a enviar
//          caption/texto de contexto después de la imagen)
//   3) TODOS los mensajes de la ventana están "ready" (procesados)
//
// Los timers pueden coexistir: todos se disparan, solo el "último"
// (mayor versión) adquiere el turno y responde.
// ============================================================

// ============================================================
// VENTANAS DE SILENCIO DINÁMICAS POR TIPO
// ============================================================
// TEXTO / AUDIO: 5s  (rápido, no requieren contexto adicional)
// IMAGEN (último msg): 45s (esperar caption/texto de contexto del usuario)
// ============================================================
const SILENCE_TEXT_AUDIO_MS = 5 * 1000
const SILENCE_IMAGE_MS = 45 * 1000

const POLL_TICK_MS = 1000
const MAX_WAIT_MS = 15 * 60 * 1000 // hard limit para no colgar polling para siempre

// ============================================================
// WATCHDOG: BUFFER VACÍO SIN ENTRY.
// Si waitForTurn arranca (el addAction de BuilderBot disparó) pero
// el listener Baileys NUNCA insertó el mensaje en el buffer
// (addReceivedFromRawMessage) — por race, por doble registerListener,
// por sock null, etc. — no debemos esperar 15min. Cancelamos en 8s.
// ============================================================
const BUFFER_ENTRY_TIMEOUT_MS = 8 * 1000

// ============================================================
// Ventana de ESTABILIZACIÓN por ráfagas (dinámica por tipo).
// Fix: "envío texto + audio rápido (<1s) y texto se invalida erróneamente".
// - Texto/Audio: 1.5s (rápido)
// - Imagen: 5s (coincide con el inicio del largo silencio de imagen).
// ============================================================
const STABILIZATION_TEXT_AUDIO_MS = 1500
const STABILIZATION_IMAGE_MS = 5 * 1000

const MY_MESSAGE_ENTRY_TICK_MS = 100
const MY_MESSAGE_ENTRY_WAIT_MS = 4 * 1000

// Deadlock safety: turnLock mismo tipo se cancela si ganador no terminó en 10s
// (protección si un flow se cuelga dentro de run() sin responder).
const TURN_LOCK_SAME_TYPE_DEADLOCK_MS = 10 * 1000

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
//   1) ORPHAN_RESCUE: usa la misma ventana dinámica de silencio según
//      lastMeaningfulType (5s texto/audio, 45s imagen). Después de ese
//      tiempo sin dueño, el flow que intenta ceder rescata y responde.
//   2) INVALIDATION_RESET_TTL_MS = 60 * 1000: si desde la invalidación
//      pasan 60s Y NADIE ha cambiado la versión (ni rescató ni respondió),
//      se hace RESET COMPLETO de la conversación (version=0, messages=[]).
//      El siguiente mensaje de texto empieza desde 0, sin desfase.
//      (Aumentado de 30s a 60s para no resetear ráfagas de imagen 45s.)
//   3) GREETINGS_RESET: si el usuario escribe "hola/buenos días/etc"
//      y la conversación está huérfana (≥2min sin responder) → reset.
// ============================================================
const INVALIDATION_RESET_TTL_MS = 60 * 1000
const GREETINGS_ORPHAN_RESET_MS = 2 * 60 * 1000
const GREETINGS_KEYWORDS = ['hola', 'buenos dias', 'buenas tardes', 'buenas noches', 'que tal', 'alo', 'buen dia', 'holi', 'holaa', 'hey', 'hi', 'hello']

// ============================================================
// THROTTLING DE IMÁGENES (anti-saturación):
// Sólo se acepta 1 imagen por usuario cada IMAGE_THROTTLE_MS (20s).
// Cualquier imagen adicional dentro de esa ventana se ignora
// completamente (no entra al buffer, no incrementa versión).
// ============================================================
const IMAGE_THROTTLE_MS = 20 * 1000

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
            messages: [], // { id, messageId, type, content, status: 'pending'|'ready', caption, receivedAt, processedAt, extra, version }
            metadata: {
                invalidatedAt: 0,
                invalidationVersionExpected: 0,
                invalidationTimer: null
            },
            cleanupTimer: null,
            turnAcquiredLock: null,
            // firstFlowVersionByType: { text: 1, audio: 3, image: 4 }
            // Guarda cuál fue la PRIMERA versión de cada tipo (el FLOW OWNER
            // que tiene permitido ganar y combinar todos los mensajes de esa ráfaga).
            // NUEVOS flows del MISMO TIPO (texto 2, texto 3) → NUNCA ganan,
            //   ceden turn lock automáticamente al OWNER (texto 1) para que este
            //   haga el combinedInput con TODO.
            // NUEVOS flows de TIPO DIFERENTE (ej, imagen 4 llegó después de texto 1)
            //   → si está DENTRO de la ventana dinámica de silencio (5s texto/audio,
            //     45s imagen), NO ceden, ambos siguen vivos y el OWNER cuyo tipo
            //     coincide con el ÚLTIMO mensaje al vencer silencio responde.
            // ============================================================
            firstFlowVersionByType: {},
            // ============================================================
            // aliveFlowsCount: contador de flows polling vivos en esta conversación
            // Lo usamos en GREETINGS_RESET: si hay >0 aliveFlows → NO RESETEAR
            // (probablemente se está procesando algo, no es huérfana).
            // ============================================================
            aliveFlowsCount: 0,
            // ============================================================
            // lastImageAcceptedAt: timestamp de la ÚLTIMA imagen ACEPTADA
            // (no rechazada por throttle). Usado por IMAGE_THROTTLE_MS.
            // lastImageAcceptedMessageId: messageId de esa ÚLTIMA imagen
            // aceptada. isImageMessageThrottled() lo usa para NO matar
            // por accidente a la MISMA imagen que se acaba de aceptar
            // (race condition fallback global de ventana de 20s).
            // ============================================================
            lastImageAcceptedAt: 0,
            lastImageAcceptedMessageId: null,
            // ============================================================
            // throttledImageMessageIds: lista de messageIds de imágenes
            // que fueron RECHAZADAS por throttling (con TTL de 30s).
            // media.js consulta esto al inicio para salir sin esperar.
            // ============================================================
            throttledImageMessageIds: [] // [{ id, expiresAt }]
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
    // Si la conversación está HUÉRFANA REAL (no hay flows vivos = nada procesando):
    //   - tiene metadata.invalidatedAt + >= INVALIDATION_RESET_TTL_MS (30s)
    //   - O han pasado > GREETINGS_ORPHAN_RESET_MS (2min) desde lastActivityAt
    //     Y el usuario ESCRIBE UN SALUDO (hola/buenos dias/que tal/etc.)
    //   -> Y TAMBIÉN: conv.aliveFlowsCount === 0 (IMPORTANTE: no resetear si hay
    //      2+ flows polling vivos en la ráfaga mixta texto+audio+imagen).
    // → Hacemos RESET COMPLETO ANTES de insertar este nuevo mensaje
    //   para que empiece desde cero sin desfase de versión.
    // ============================================================
    const now = Date.now()
    const greetingsText = (typeNorm === 'text') ? String(content || '') : ''
    const hasOldInvalidation = !!(conv.metadata && conv.metadata.invalidatedAt && (now - Number(conv.metadata.invalidatedAt)) >= INVALIDATION_RESET_TTL_MS)
    const hasOrphanExpired = (conv.messages.length > 0 && conv.lastActivityAt && (now - conv.lastActivityAt) >= GREETINGS_ORPHAN_RESET_MS)
    const isGreeting = isGreetingText(greetingsText)
    const anyFlowsAlive = Number(conv.aliveFlowsCount || 0) > 0
    const shouldResetBeforeInsert = !anyFlowsAlive && (conv.version > 0 && conv.messages.length > 0 && (
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
            aliveFlowsCountNow: conv.aliveFlowsCount || 0,
            anyFlowsAlive,
            versionBeforeReset: conv.version,
            messagesBeforeResetCount: conv.messages.length,
            lastActivityAt: conv.lastActivityAt ? new Date(conv.lastActivityAt).toISOString() : null,
            invalidatedAt: conv.metadata?.invalidatedAt ? new Date(conv.metadata.invalidatedAt).toISOString() : null,
            action: 'conversation_orphan_reset_before_insert',
            file
        })
        conv.metadata.invalidatedAt = 0
        conv.metadata.invalidationVersionExpected = 0
        conv.firstFlowVersionByType = {}
        conv.messages = []
        conv.version = 0
        conv.lastActivityAt = 0
        conv.aliveFlowsCount = 0
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
// THROTTLING DE IMÁGENES — helper público.
// ============================================================
// Retorna { allowed: boolean, waitMs: number, lastAcceptedAt: number, now: number }
//   - allowed=true  → se acepta la imagen y se actualiza lastImageAcceptedAt.
//   - allowed=false → dentro de ventana de throttle, omitir.
//
// Uso:
//   media.js: al inicio del addAction, si !allowed → return endFlow()
//   addReceivedMessage: si tipo=image y !allowed → return null (ignorado)
// ============================================================
export const checkAndSetImageThrottle = (phone, {
    file = 'conversationBuffer.js',
    setOnAllow = true,
    messageId = null,
    extraLog = {}
} = {}) => {
    const conv = ensureConversation(phone)
    const phoneKey = normalizeKey(phone)
    const now = Date.now()
    const lastAcceptedAt = Number(conv.lastImageAcceptedAt || 0)
    const elapsedMs = lastAcceptedAt > 0 ? (now - lastAcceptedAt) : (IMAGE_THROTTLE_MS + 1)
    const waitMs = lastAcceptedAt > 0 ? Math.max(0, IMAGE_THROTTLE_MS - elapsedMs) : 0

    // Limpiar entries expiradas de throttledImageMessageIds
    if (Array.isArray(conv.throttledImageMessageIds) && conv.throttledImageMessageIds.length > 0) {
        const beforeCount = conv.throttledImageMessageIds.length
        conv.throttledImageMessageIds = conv.throttledImageMessageIds.filter(e =>
            e && e.id && Number(e.expiresAt || 0) > now
        )
        if (beforeCount !== conv.throttledImageMessageIds.length) {
            defaultLogger.debug('Limpieza TTL: throttledImageMessageIds reducido', {
                phoneKey, phone,
                beforeCount, afterCount: conv.throttledImageMessageIds.length,
                action: 'image_throttle_cleanup_expired',
                file
            })
        }
    }

    if (lastAcceptedAt > 0 && elapsedMs < IMAGE_THROTTLE_MS) {
        // Registrar messageId en lista de throttled (para consulta rápida desde media.js)
        if (messageId && String(messageId).trim()) {
            const id = String(messageId).trim()
            if (!conv.throttledImageMessageIds.find(e => e && e.id === id)) {
                conv.throttledImageMessageIds.push({
                    id,
                    expiresAt: now + Math.max(IMAGE_THROTTLE_MS, 30 * 1000)
                })
                defaultLogger.debug('Image messageId registrada como throttled', {
                    phoneKey, phone,
                    messageId: id,
                    expiresAt: new Date(now + Math.max(IMAGE_THROTTLE_MS, 30 * 1000)).toISOString(),
                    action: 'image_throttle_id_registered',
                    file
                })
            }
        }
        defaultLogger.info('Image throttle BLOQUEADO: dentro de ventana de 20s desde última imagen aceptada', {
            phoneKey, phone,
            messageId: messageId ? String(messageId).trim() : null,
            lastImageAcceptedAt: lastAcceptedAt ? new Date(lastAcceptedAt).toISOString() : null,
            elapsedSinceLastAcceptedMs: elapsedMs,
            waitRemainingMs: waitMs,
            throttleWindowMs: IMAGE_THROTTLE_MS,
            action: 'image_throttle_blocked',
            file,
            ...(extraLog && typeof extraLog === 'object' ? extraLog : {})
        })
        return { allowed: false, waitMs, lastAcceptedAt, now }
    }

    if (setOnAllow) {
        conv.lastImageAcceptedAt = now
        if (messageId && String(messageId).trim()) {
            conv.lastImageAcceptedMessageId = String(messageId).trim()
        }
    }
    defaultLogger.info('Image throttle PERMITIDO: aceptando imagen', {
        phoneKey, phone,
        messageId: messageId ? String(messageId).trim() : null,
        previousLastAcceptedAt: lastAcceptedAt ? new Date(lastAcceptedAt).toISOString() : null,
        elapsedSinceLastAcceptedMs: elapsedMs,
        throttleWindowMs: IMAGE_THROTTLE_MS,
        nowAcceptedAt: new Date(now).toISOString(),
        action: 'image_throttle_allowed',
        file,
        ...(extraLog && typeof extraLog === 'object' ? extraLog : {})
    })
    return { allowed: true, waitMs: 0, lastAcceptedAt, now }
}

// ============================================================
// Helper para media.js: detecta rápidamente si un messageId
// específico fue rechazado por throttling de imágenes.
// Retorna { throttled: boolean, waitMs: number, reason: string }
//
// ⚠️ IMPORTANTE (BUG FIX): esta función NO debe matar a la IMAGEN
// QUE SÍ FUE ACEPTADA (la primera en la ventana de 20s).
// La fuente de verdad del throttling es checkAndSetImageThrottle()
// ejecutado en el listener Baileys, quien decide allowed=true/false
// y REGISTRA explícitamente cada messageId:
//   - Si fue RECHAZADA → entra a throttledImageMessageIds
//   - Si fue ACEPTADA → entra a lastImageAcceptedMessageId
//
// Por lo tanto, acá las reglas son:
//   A) Si targetId existe → SÓLO bloquear SI ESTÁ REGISTRADO EN
//      throttledImageMessageIds (bloqueo EXPLÍCITO). NUNCA usar
//      "ventana global de 20s" como fallback cuando messageId
//      está presente, porque eso mataría a la imagen aceptada.
//   B) Si targetId NO existe (null/undefined/vacío, caso raro) →
//      recién ahí usar el fallback de ventana.
//   C) Excepción extra: si targetId === lastImageAcceptedMessageId
//      → es la MISMA imagen que fue aceptada → NO THROTTLED JAMÁS.
// ============================================================
export const isImageMessageThrottled = (phone, messageId, {
    file = 'conversationBuffer.js'
} = {}) => {
    const conv = ensureConversation(phone)
    const phoneKey = normalizeKey(phone)
    const now = Date.now()
    const targetId = messageId ? String(messageId).trim() : ''

    // Limpiar entries expiradas
    if (Array.isArray(conv.throttledImageMessageIds) && conv.throttledImageMessageIds.length > 0) {
        conv.throttledImageMessageIds = conv.throttledImageMessageIds.filter(e =>
            e && e.id && Number(e.expiresAt || 0) > now
        )
    }

    const lastAcceptedId = conv.lastImageAcceptedMessageId
        ? String(conv.lastImageAcceptedMessageId).trim()
        : null

    // ============================================================
    // 🔥 EXCEPCIÓN PRIORIDAD 0:
    //    si este messageId es la MISMA imagen que fue ACEPTADA
    //    (el listener checkAndSetImageThrottle marcó allowed=true)
    //    → NO THROTTLED. Nunca matar a la propia imagen aceptada.
    // ============================================================
    if (targetId && lastAcceptedId && targetId === lastAcceptedId) {
        defaultLogger.debug('isImageMessageThrottled: SKIP. messageId = lastImageAcceptedMessageId (imagen permitida)', {
            phoneKey, phone,
            messageId: targetId,
            lastImageAcceptedAt: conv.lastImageAcceptedAt
                ? new Date(Number(conv.lastImageAcceptedAt || 0)).toISOString()
                : null,
            action: 'image_throttle_skip_own_accepted_image',
            file
        })
        return { throttled: false, waitMs: 0, reason: 'own_accepted_image' }
    }

    // ============================================================
    // 1) Chequeo EXPLÍCITO: por id registrado en throttledImageMessageIds.
    //    Este es el único camino BLOQUEANTE cuando messageId existe.
    // ============================================================
    if (targetId && Array.isArray(conv.throttledImageMessageIds)) {
        const found = conv.throttledImageMessageIds.find(e => e.id === targetId)
        if (found) {
            const remaining = Math.max(0, Number(found.expiresAt || 0) - now)
            defaultLogger.info('isImageMessageThrottled: messageId encontrado en lista de throttled (bloqueo explícito)', {
                phoneKey, phone,
                messageId: targetId,
                remainingMs: remaining,
                action: 'image_throttle_id_check_hit',
                file
            })
            return { throttled: true, waitMs: remaining, reason: 'explicit_id_in_throttled_list' }
        }
    }

    // ============================================================
    // 2) FALLBACK: solo se activa SI NO HAY messageId (raro).
    //    Con messageId presente, jamás bloquear por fallback global
    //    (evitamos matar a la imagen aceptada por race listener / BBot).
    // ============================================================
    const lastAcceptedAt = Number(conv.lastImageAcceptedAt || 0)
    if (!targetId && lastAcceptedAt > 0) {
        const elapsed = now - lastAcceptedAt
        if (elapsed < IMAGE_THROTTLE_MS) {
            const remaining = Math.max(0, IMAGE_THROTTLE_MS - elapsed)
            defaultLogger.info('isImageMessageThrottled: fallback global throttle (SIN messageId)', {
                phoneKey, phone,
                messageId: null,
                lastImageAcceptedAt: new Date(lastAcceptedAt).toISOString(),
                elapsedSinceLastAcceptedMs: elapsed,
                remainingMs: remaining,
                action: 'image_throttle_global_check_hit_only_no_id',
                file
            })
            return { throttled: true, waitMs: remaining, reason: 'global_window_fallback_no_id' }
        }
    }

    // ============================================================
    // 3) LLEGÓ HASTA ACÁ = NO THROTTLED.
    //    Casos:
    //      - messageId presente y NO está en throttledList (libre).
    //      - messageId presente y es la aceptada.
    //      - sin messageId y venció ventana.
    // ============================================================
    defaultLogger.debug('isImageMessageThrottled: NO throttled', {
        phoneKey, phone,
        messageId: targetId || null,
        hasMessageId: Boolean(targetId),
        lastImageAcceptedMessageId: lastAcceptedId || null,
        lastImageAcceptedAt: lastAcceptedAt
            ? new Date(lastAcceptedAt).toISOString()
            : null,
        action: 'image_throttle_check_miss',
        file
    })
    return { throttled: false, waitMs: 0, reason: targetId ? 'not_in_throttled_list' : 'window_expired_or_empty' }
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
        silenceWindowRule: '5s texto/audio, 45s imagen (último mensaje)',
        tickMs: POLL_TICK_MS,
        bufferCount: conv.messages.length,
        file
    })

    let lastLogAt = 0

    // ============================================================
    // REGISTRO: ESTE FLOW HA NACIDO (ALIVE)
    // Incrementamos aliveFlowsCount para:
    //   - GREETINGS_RESET NO borre conversación con flows vivos
    //   - diagnostics en logs
    // Lo decrementamos en TODO return (antes exit).
    // ============================================================
    conv.aliveFlowsCount = Number(conv.aliveFlowsCount || 0) + 1
    const myFlowIndex = conv.aliveFlowsCount
    const decrementAlive = () => {
        try {
            if (conv && (Number(conv.aliveFlowsCount || 0) > 0)) conv.aliveFlowsCount--
        } catch (_) { /* no-op */ }
    }

    // ============================================================
    // REGISTRO FIRST FLOW OWNER POR TIPO
    // Si soy el PRIMERO flowType en firstFlowVersionByType → me guardo como OWNER.
    // Ej: chatbot.js texto v1 nace → firstFlowVersionByType.text = 1 (OWNER)
    //     chatbot.js texto v2 nace → existe firstFlowVersionByType.text → NO owner,
    //        deberá ceder después de ventana estabilización (para que owner 1 responda todo).
    // ============================================================
    const flowTypeNorm = String(flowType || '').toLowerCase()
    let imOwnerOfMyType = false
    if (flowTypeNorm && SUPPORTED_TYPES.has(flowTypeNorm)) {
        if (!conv.firstFlowVersionByType || !conv.firstFlowVersionByType[flowTypeNorm]) {
            conv.firstFlowVersionByType = conv.firstFlowVersionByType || {}
            conv.firstFlowVersionByType[flowTypeNorm] = Number(flowVersion || 0)
            imOwnerOfMyType = true
        } else {
            imOwnerOfMyType = Number(conv.firstFlowVersionByType[flowTypeNorm] || 0) === Number(flowVersion || 0)
        }
    }

    defaultLogger.debug('Flow registrado: aliveCount y ownerType guardados', {
        phoneKey, phone,
        flowType: flowTypeNorm, flowId, flowVersion,
        imOwnerOfMyType,
        ownerVersionForMyType: conv.firstFlowVersionByType[flowTypeNorm] || 0,
        aliveFlowsCountNow: conv.aliveFlowsCount,
        myFlowIndex,
        action: 'conversation_flow_registered_alive',
        file
    })

    while (true) {
        const now = Date.now()
        const elapsedTotalMs = now - startedAt

        // ============================================================
        // CÁLCULOS GLOBALES PRIMERO (orden correcto, sin refs forward).
        // lastMeaningful / sinceLastActivity necesarios en: firstTickLog,
        // watchdog empty buffer, ventanas dinámicas, silenceCompleted, etc.
        // ============================================================
        const lastMeaningful = getLastMeaningfulMessage(conv)
        const lastMeaningfulType = lastMeaningful ? String(lastMeaningful.type).toLowerCase() : null
        const sinceLastActivity = conv.lastActivityAt ? (now - conv.lastActivityAt) : 0

        const totalMessagesInConv = conv.messages.length
        const totalValidInConv = conv.messages.filter(m => isValidType(m.type)).length

        // ============================================================
        // PRIMER TICK + WATCHDOG BUFFER VACÍO.
        // ============================================================
        if (elapsedTotalMs < POLL_TICK_MS + 2) {
            defaultLogger.info('Polling primer tick: estado actual del buffer', {
                phoneKey, phone,
                flowType: flowTypeNorm, flowId, flowVersion,
                currentVersion: conv.version,
                lastActivityAt: conv.lastActivityAt ? new Date(conv.lastActivityAt).toISOString() : null,
                sinceLastActivityMs: sinceLastActivity,
                totalMessagesInConv,
                totalValidInConv,
                aliveFlowsCountNow: conv.aliveFlowsCount,
                lastType: lastMeaningfulType || null,
                turnAcquiredByOther: Boolean(conv.turnAcquiredLock),
                elapsedTotalMs,
                bufferEntryTimeoutRemaining: Math.max(0, BUFFER_ENTRY_TIMEOUT_MS - elapsedTotalMs),
                action: 'conversation_polling_first_tick_snapshot',
                file
            })
        }
        if (elapsedTotalMs >= BUFFER_ENTRY_TIMEOUT_MS && totalValidInConv === 0) {
            if (conv.turnAcquiredLock && conv.turnAcquiredLock.flowId === flowId) {
                conv.turnAcquiredLock = null
            }
            defaultLogger.warn('Polling BUFFER VACÍO después de watchdog timeout: listener Baileys no insertó mensaje', {
                phoneKey, phone,
                flowType: flowTypeNorm, flowId, flowVersion,
                currentVersion: conv.version,
                lastActivityAt: conv.lastActivityAt ? new Date(conv.lastActivityAt).toISOString() : null,
                totalMessagesInConv,
                totalValidInConv,
                aliveFlowsCountNow: conv.aliveFlowsCount,
                waitedMs: elapsedTotalMs,
                bufferEntryTimeoutMs: BUFFER_ENTRY_TIMEOUT_MS,
                action: 'conversation_polling_buffer_empty_timeout',
                note: 'Causa probable: race en registerListener, sock null, o filtro anti-noise descartó el mensaje. Ver logs conversation_listener_* en app.js.',
                file
            })
            decrementAlive()
            return {
                acquired: false,
                cancelReason: 'buffer_empty_no_message_within_timeout',
                combinedInput: null,
                finalVersion: conv.version,
                bufferEmpty: true
            }
        }

        // ============================================================
        // 🔥 PRIMERO: check TURNO DUPLICADO (turnAcquiredLock).
        // 🔴 IMPORTANTE: esto va ANTES de TODO: shouldCede, orphan rescue,
        //    allReady. La razón: en ticks concurrentes (mismo 1s de polling),
        //    si flow1 (texto último tipo) va por la vía "normal" y marca lock,
        //    flow2 (audio) NO DEBE entrar por ORPHAN RESCUE duplicado.
        // ============================================================
        if (conv.turnAcquiredLock) {
            const lockOwner = conv.turnAcquiredLock
            const isLockMe = lockOwner.flowId === flowId
            const lockType = String(lockOwner.flowType || '').toLowerCase()
            const lockAgeMs = lockOwner.at ? (now - Number(lockOwner.at || 0)) : 0
            const sameTypeAsLock = lockType === flowTypeNorm
            const deadlockBroken = sameTypeAsLock && lockAgeMs >= TURN_LOCK_SAME_TYPE_DEADLOCK_MS

            if (!isLockMe && !deadlockBroken) {
                if (!lastLogAt || (now - lastLogAt) > 5000) {
                    lastLogAt = now
                    defaultLogger.info('Flujo NO adquiere turno (lock previo): otro flujo ya adquirió', {
                        phoneKey, phone,
                        flowType: flowTypeNorm, flowId, myFlowVersion: flowVersion,
                        turnLockOwnerFlowId: lockOwner.flowId,
                        turnLockOwnerType: lockType,
                        turnLockOwnerVersion: lockOwner.flowVersion,
                        turnLockAgeMs: lockAgeMs,
                        sameTypeAsLock,
                        deadlockBroken: false,
                        checkedBeforeShouldCede: true,
                        action: 'conversation_ceded_turn_already_acquired_early',
                        file
                    })
                }
                decrementAlive()
                return {
                    acquired: false,
                    cancelReason: 'turn_already_acquired_other_flow',
                    combinedInput: null,
                    finalVersion: conv.version
                }
            }
            if (deadlockBroken) {
                defaultLogger.warn('DEADLOCK BROKEN (early check): mismo tipo lock >= 10s old', {
                    phoneKey, phone,
                    flowType: flowTypeNorm, flowId,
                    oldLockOwnerFlowId: lockOwner.flowId,
                    oldLockAgeMs: lockAgeMs,
                    oldLockVersion: lockOwner.flowVersion,
                    action: 'conversation_turn_lock_deadlock_broken_same_type_early',
                    file
                })
                conv.turnAcquiredLock = null
            }
        }

        // ============================================================
        // HELPER: ventana dinámica según tipo del ÚLTIMO mensaje significativo.
        // - Texto/Audio: 5s silencio + 1.5s estabilización (rápido)
        // - Imagen: 45s silencio + 5s estabilización (dar tiempo al usuario
        //   a enviar caption/texto de contexto después de la imagen sola)
        // - Sin tipo aún (frontera): texto por defecto (mínimo 5s)
        // ============================================================
        const isLastImage = (lastMeaningfulType === 'image')
        const silenceWindowMs = isLastImage ? SILENCE_IMAGE_MS : SILENCE_TEXT_AUDIO_MS
        const stabilizationMs = isLastImage ? STABILIZATION_IMAGE_MS : STABILIZATION_TEXT_AUDIO_MS

        const inSilenceWindow45s = sinceLastActivity < silenceWindowMs
        const inStabilizationWindow = sinceLastActivity < stabilizationMs

        // ============================================================
        // NUEVA REGLA DE INVALIDACIÓN (DEFINITIVA):
        //
        // DENTRO DE VENTANA DINÁMICA DE SILENCIO (RÁFAGA ACTIVA):
        //   🟢 NUNCA CEDER POR TIPO DISTINTO
        //      (texto 1, audio 2 dentro 5s o imagen 3 dentro 45s: siguen vivos).
        //   🟡 SOLO CEDEN flows NUEVOS de MISMO TIPO que NO son OWNER,
        //      pero DENTRO de la ventana de silencio NO ceden nunca
        //      (igual que el resto). La cesión solo sucede FUERA de ventana,
        //      por tipo distinto al último.
        //
        // FUERA DE VENTANA (pasó ventana dinámica sin nueva actividad):
        //   🟢 Si yo soy el tipo que coincide con el último mensaje significativo → NO ceder, ganar.
        //   🔴 Si yo NO coincido con el último tipo (y no tiene sentido espere más) → ceder.
        // ============================================================
        let shouldCede = false
        let cedeReason = null

        if (inSilenceWindow45s) {
            // ==================================================================
            // DENTRO DE VENTANA DINÁMICA (RÁFAGA ACTIVA):
            //   🔥 NUNCA CEDER POR NADA — EXPLÍCITO POR REGLAS DE NEGOCIO.
            //
            //   - TIPOS DISTINTOS: todos siguen vivos esperando (combinación mixed).
            //   - MISMO TIPO non-owner: no ceder dentro ventana (evita limbo por
            //     race listener/timeout). Ambos esperan, fuera de ventana el que
            //     adquiera turno lock primero responde TODO, el otro cede por
            //     turnLock (mismo tipo deadlock 10s safety).
            // ==================================================================
            shouldCede = false
            cedeReason = null
        } else {
            // ==================================================================
            // FUERA DE VENTANA DINÁMICA (RÁFAGA TERMINÓ):
            //   Solo gana el flow cuyo tipo coincida con EL ÚLTIMO mensaje de la ráfaga.
            //   Todos los demás tipos ceden (no tienen dueño del último mensaje).
            // ==================================================================
            if (lastMeaningfulType && flowTypeNorm && flowTypeNorm !== lastMeaningfulType) {
                shouldCede = true
                cedeReason = 'different_type_outside_45s_window_last_msg_type_different'
            } else {
                // Soy el tipo que coincide con el último mensaje, o solo 1 tipo: NO ceder.
                shouldCede = false
            }
        }

        // ============================================================
        // LOG estabilización cada 1s si estoy en ventana.
        // ============================================================
        if (inStabilizationWindow && (!lastLogAt || (now - lastLogAt) > 1000)) {
            lastLogAt = now
            defaultLogger.debug('Flujo en ráfaga/estabilización: sigue vivo, no se invalida', {
                phoneKey, phone,
                flowType: flowTypeNorm, flowId, flowVersion,
                imOwnerOfMyType,
                ownerVersionForMyType: conv.firstFlowVersionByType?.[flowTypeNorm] || 0,
                lastType: lastMeaningfulType,
                sinceLastActivityMs: sinceLastActivity,
                stabilizationMs,
                silenceWindowMs,
                insideSilenceWindow: inSilenceWindow45s,
                aliveFlowsCountNow: conv.aliveFlowsCount,
                shouldCedeNow: shouldCede,
                cedeReason,
                action: 'conversation_in_stabilization_window_same_mixed_types',
                file
            })
        }

        if (shouldCede) {
            // ============================================================
            // ORPHAN RESCUE: antes de ceder, ¿está huérfana sin dueño respondiendo?
            //   (allReady + se cumplió la ventana dinámica de silencio)
            // ============================================================
            const meaningfulMessagesCurr = conv.messages.filter(m => isValidType(m.type))
            const anyPendingMeaningfulCurr = meaningfulMessagesCurr.some(m => m.status === 'pending')
            const allReadyMeaningfulCurr = meaningfulMessagesCurr.length > 0 && !anyPendingMeaningfulCurr
            const silenceCompletedCurr = sinceLastActivity >= silenceWindowMs
            if (meaningfulMessagesCurr.length > 0 && allReadyMeaningfulCurr && silenceCompletedCurr) {
                // 🔥 MARCAR TURNO LOCK TAMBIÉN AQUÍ (antes de return)
                // Para evitar que un 3er flow en mismo tick entre por ORPHAN RESCUE duplicado.
                conv.turnAcquiredLock = { flowId, flowType: flowTypeNorm, flowVersion, at: now, orphan: true }
                const combinedInput = buildCombinedInput(phone, { file })
                defaultLogger.warn('ORPHAN RESCUE: flujo cedido rescata huérfana (lock marcado orphan)', {
                    phoneKey, phone,
                    flowType: flowTypeNorm, flowId, flowVersion,
                    cedeReasonWouldBe: cedeReason,
                    lastType: lastMeaningfulType,
                    bufferCount: conv.messages.length,
                    meaningfulCount: meaningfulMessagesCurr.length,
                    turnLockAcquired: true,
                    orphanLock: true,
                    action: 'conversation_orphan_rescue_acquired',
                    file
                })
                clearInvalidationTimer(conv)
                if (conv.metadata) {
                    conv.metadata.invalidatedAt = 0
                    conv.metadata.invalidationVersionExpected = 0
                }
                decrementAlive()
                return {
                    acquired: true, cancelReason: null,
                    combinedInput, finalVersion: conv.version, orphanRescue: true
                }
            }

            // ============================================================
            // PROGRAMAR TTL 60s RESET SOLO EN CASO EXTREMO (fuera de ventana,
            // no hay dueño claro y nadie responde).
            // SIEMPRE que llega un mensaje nuevo después se CANCELA ESTE TIMER,
            // así no borramos ráfagas válidas (incluyendo imagen 45s).
            // ============================================================
            if (!inSilenceWindow45s) {
                scheduleInvalidationReset(conv, phoneKey, phone, file)
            }

            defaultLogger.info('Flujo CEDIDO (definitivo)', {
                phoneKey, phone,
                flowType: flowTypeNorm, flowId, flowVersion,
                lastType: lastMeaningfulType,
                sinceLastActivityMs: sinceLastActivity,
                insideSilenceWindow45s: inSilenceWindow45s,
                silenceWindowUsedMs: silenceWindowMs,
                imOwnerOfMyType,
                ownerVersionForMyType: conv.firstFlowVersionByType?.[flowTypeNorm] || 0,
                aliveFlowsCountNow: conv.aliveFlowsCount,
                cedeReason,
                action: 'conversation_invalidated_ceded_definitive',
                file
            })
            decrementAlive()
            return {
                acquired: false, cancelReason: cedeReason,
                combinedInput: null, finalVersion: conv.version
            }
        }

        const silenceElapsed = sinceLastActivity

        // ============================================================
        // FIX LIMBO: SOLO considerar mensajes de TIPOS VÁLIDOS (text/audio/image)
        // para las condiciones de "allReady" y "buffer no vacío".
        // ============================================================
        const meaningfulMessages = conv.messages.filter(m => isValidType(m.type))
        const anyPendingMeaningful = meaningfulMessages.some(m => m.status === 'pending')
        const allReadyMeaningful = meaningfulMessages.length > 0 && !anyPendingMeaningful
        const anyPending = conv.messages.some(m => m.status === 'pending')
        const allReady = allReadyMeaningful
        const silenceCompleted = sinceLastActivity >= silenceWindowMs

        // Cada ~5s log del polling.
        if (!lastLogAt || (now - lastLogAt) > 5000) {
            lastLogAt = now
            defaultLogger.debug('Flujo esperando turno (polling)', {
                phoneKey, phone,
                flowType: flowTypeNorm, lastType: lastMeaningfulType,
                flowId, flowVersion,
                currentVersion: conv.version,
                imOwnerOfMyType,
                ownerVersionForMyType: conv.firstFlowVersionByType?.[flowTypeNorm] || 0,
                inStabilizationWindow,
                sinceLastActivityMs: sinceLastActivity,
                insideSilenceWindow45s: inSilenceWindow45s,
                aliveFlowsCountNow: conv.aliveFlowsCount,
                bufferCount: conv.messages.length,
                meaningfulCount: meaningfulMessages.length,
                unsupportedCount: conv.messages.length - meaningfulMessages.length,
                allReady, allReadyMeaningful,
                anyPending, anyPendingMeaningful,
                silenceElapsedMs: silenceElapsed,
                silenceWindowUsedMs: silenceWindowMs,
                remainingSilenceMs: Math.max(0, silenceWindowMs - silenceElapsed),
                turnAcquiredByOther: Boolean(conv.turnAcquiredLock),
                turnLockOwnerFlowId: conv.turnAcquiredLock?.flowId || null,
                turnLockOwnerType: conv.turnAcquiredLock?.flowType || null,
                action: 'conversation_polling_wait',
                file
            })
        }

        // Condición de adquirir turno:
        //   - shouldCede = false (pasamos arriba)
        //   - turnAcquiredLock está null (por el early check AL PRINCIPIO del while, nadie duplicó)
        //   - meaningfulMessages no vacío
        //   - todos meaningful están ready
        //   - silenceCompleted
        if (meaningfulMessages.length > 0 && allReadyMeaningful && silenceCompleted) {
            conv.turnAcquiredLock = { flowId, flowType: flowTypeNorm, flowVersion, at: now }
            const combinedInput = buildCombinedInput(phone, { file })
            defaultLogger.info('Flujo ADQUIERE turno y construye contexto combinado', {
                phoneKey, phone,
                flowType: flowTypeNorm, lastType: lastMeaningfulType,
                flowId, flowVersion, currentVersion: conv.version,
                imOwnerOfMyType,
                ownerVersionForMyType: conv.firstFlowVersionByType?.[flowTypeNorm] || 0,
                bufferCount: conv.messages.length,
                meaningfulCount: meaningfulMessages.length,
                bufferTypes: meaningfulMessages.map(m => m.type),
                silenceElapsedMs: silenceElapsed,
                combinedLength: String(combinedInput || '').length,
                turnLockAcquired: true,
                aliveFlowsCountNow: conv.aliveFlowsCount,
                action: 'conversation_turn_acquired',
                file
            })
            decrementAlive()
            return {
                acquired: true, cancelReason: null,
                combinedInput, finalVersion: conv.version
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
                aliveFlowsCountNow: conv.aliveFlowsCount,
                turnLockOwnerFlowId: conv.turnAcquiredLock?.flowId || null,
                action: 'conversation_polling_timeout',
                file
            })
            decrementAlive()
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
    // Escenario normal (texto):
    //   T=0s Usuario envía msg 1 (version=1)
    //   T=5s Flujo adquiere turno (ventana texto=5s), llama a run()
    //   T=7s (mientras IA piensa) Usuario envía msg 2 (version=2)
    //   T=10s run() termina, flujo original responde con version finalVersion=1
    //   T=10s clearConversationAfterResponse(1) es llamado.
    //
    // Escenario imagen (ventana 45s):
    //   T=0s Usuario envía imagen (version=1)
    //   T=45s Flujo imagen adquiere turno, llama a run()
    //   T=47s Usuario envía texto de contexto (version=2)
    //   T=50s run() termina, responde con v=1; clearConversationAfterResponse(1).
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
    let preservedVersionsBefore = []
    let preservedLastActivityAt = 0
    let preservedMaxVersion = 0
    if (finalVersion !== undefined && Number(conv.version) !== Number(finalVersion)) {
        const rawPreserved = conv.messages.filter(m => {
            if (Number(m.version || 0) <= Number(finalVersion)) {
                removedCount++
                return false
            }
            preservedCount++
            preservedVersionsBefore.push(Number(m.version || 0))
            preservedMaxVersion = Math.max(preservedMaxVersion, Number(m.version || 0))
            preservedLastActivityAt = Math.max(preservedLastActivityAt, Number(m.receivedAt || 0))
            return true
        })

        // ============================================================
        // 🔥 IMPORTANTE: "NUEVO FLUJO" para los mensajes preservados.
        // Tal como pidió el usuario: estos mensajes NO dependen del
        // flujo anterior, son completamente INDEPENDIENTES.
        //
        // Para eso renumeramos sus versiones EMPEZANDO EN 1,2,3...
        // (como si fuera una conversación nueva), y reseteamos
        // conv.version al nuevo total, lastActivityAt al último
        // receivedAt preservado, y vaciamos firstFlowVersionByType
        // para que los nuevos flows que BuilderBot dispare se
        // registren como OWNERs correctamente (sin map viejo).
        // ============================================================
        if (preservedCount > 0) {
            rawPreserved.sort((a,b) => Number(a.receivedAt || 0) - Number(b.receivedAt || 0))
            const renumeratedPreserved = rawPreserved.map((entry, idxZeroBased) => ({
                ...entry,
                version: idxZeroBased + 1   // viejas versiones 3,4,5 → nuevas 1,2,3 (nuevo flujo!)
            }))
            conv.messages = renumeratedPreserved
            conv.version = preservedCount                // nuevo global version = # mensajes preservados.
            conv.lastActivityAt = preservedLastActivityAt  // lastActivity = último msg preservado.
        } else {
            conv.messages = rawPreserved // preservedCount=0, lista vacía.
        }

        // NUEVO FLUJO: limpiamos el mapa de owners (para que los flows de
        // BuilderBot que disparen los mensajes preservados sean los primeros).
        conv.firstFlowVersionByType = {}

        const preservedVersionsAfter = preservedCount > 0
            ? conv.messages.map(m => Number(m.version || 0))
            : []

        defaultLogger.info('Clear post-respuesta: hubo mensajes nuevos durante IA → CONSERVADOS (flujo nuevo independiente)', {
            phoneKey: conv.key,
            phone,
            totalBeforeCount,
            removedOlderVersions: removedCount,
            preservedNewerCount: preservedCount,
            preservedVersionsBefore: preservedCount < 20 ? preservedVersionsBefore : `${preservedCount} items (omit list)`,
            preservedVersionsAfterRenumber: preservedCount < 20 ? preservedVersionsAfter : `${preservedCount} items (omit list)`,
            finalVersionResponded: Number(finalVersion),
            newVersionGlobalNow: Number(conv.version),
            newLastActivityAtNow: preservedLastActivityAt ? new Date(preservedLastActivityAt).toISOString() : null,
            firstFlowOwnersReset: true,
            note: '🔥 RENUMERADAS VERSIONES A 1,2,3 NUEVO FLUJO BUILDERBOT INDEPENDIENTE. LAST ACTIVITY ACTUALIZADA.',
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
    // (preservedCount === 0, respondimos exactamente el último msg).
    // Si preservedCount > 0: los mensajes ya fueron renumerados a 1,2,3 (nuevo flujo)
    //        y lastActivityAt ya fue actualizado al último receivedAt preservado.
    if (preservedCount === 0) {
        conv.lastActivityAt = 0
        conv.version = 0
        conv.firstFlowVersionByType = {}
        if (Number(conv.aliveFlowsCount || 0) <= 0) conv.aliveFlowsCount = 0
    }
    defaultLogger.info('Buffer de conversación limpio (respuesta enviada OK)', {
        phoneKey: conv.key,
        phone,
        totalBeforeCount,
        removedCount,
        preservedCount,
        finalVersion,
        currentVersion: conv.version,
        firstFlowOwnersReset: (preservedCount === 0) || (conv.firstFlowVersionByType && Object.keys(conv.firstFlowVersionByType).length === 0),
        aliveFlowsCountNow: conv.aliveFlowsCount || 0,
        invalidationTimerCancelled: !(conv.metadata && conv.metadata.invalidationTimer),
        turnLockCleared: true,
        preservedNewerMessagesExist: preservedCount > 0,
        note: preservedCount > 0 ? 'NUEVO FLUJO BuilderBot disparará para mensajes conservados (version 1..N, lastActivity actualizado)' : null,
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
