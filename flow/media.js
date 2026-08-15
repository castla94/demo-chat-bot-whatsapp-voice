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
    consumeLatestPendingOfType
} from '../helpers/conversationBuffer.js';


/**
 * Función auxiliar para pausar la ejecución
 * @param {number} ms - Milisegundos a esperar
 * @returns {Promise} Promesa que se resuelve después del tiempo especificado
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))


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
    const candidates = [
        ctx?.body,
        ctx?.caption,
        ctx?.message?.imageMessage?.caption,
        ctx?.message?.videoMessage?.caption,
        ctx?.message?.extendedTextMessage?.text,
        ctx?.msg?.caption,
        ctx?.msg?.body,
        ctx?.msg?.imageMessage?.caption,
        ctx?.msg?.message?.imageMessage?.caption,
        ctx?.message?.documentMessage?.caption
    ];

    for (const candidate of candidates) {
        const value = String(candidate || '').trim();
        if (value) {
            return value;
        }
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

        try {
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
            // REGLA SIMPLIFICADA (igual que chatbot/voice):
            //   ÚNICAMENTE el listener Baileys inserta en el buffer.
            //   Este flujo SOLO LEE versión actual y entryId del último image PENDING.
            const myVersion = getCurrentVersion(numberPhone)
            let pendingImage = consumeLatestPendingOfType(numberPhone, 'image')
            const convStateBefore = getConversationState(numberPhone)
            defaultLogger.info('Conversación compartida (imagen - solo lectura)', {
                userId, numberPhone, name,
                phoneKey: convStateBefore.phoneKey,
                myVersion,
                pendingImageEntryId: pendingImage ? pendingImage.entryId : null,
                pendingImageMessageId: pendingImage ? pendingImage.messageId : null,
                pendingImageReceivedAt: pendingImage && pendingImage.receivedAt ? new Date(pendingImage.receivedAt).toISOString() : null,
                currentVersion: convStateBefore.version,
                bufferCount: convStateBefore.bufferCount,
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
            // Actualizar usuario NUEVO (igual que chatbot/voice ahora lo hacen)
            if (!userStatus) {
                userStatus = await putWhatsapp(numberPhone, name, true, profilePictureUrl)
                defaultLogger.info('Nuevo usuario registrado', {
                    userId, numberPhone, name, newUserStatus: userStatus,
                    action: 'new_user_registration',
                    file: 'media.js'
                })
            }
            if (userStatus && !userStatus.status) {
                defaultLogger.info('Usuario desactivado', {
                    userId, numberPhone, name,
                    action: 'user_disabled_end_flow',
                    file: 'media.js'
                })
                return endFlow()
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
            const pathImg = await provider.saveFile(ctx, { path: `${process.cwd()}/media/` })
            defaultLogger.info('Imagen guardada', {
                userId, numberPhone, name, pathImg,
                action: 'image_saved',
                file: 'media.js'
            })

            // 1. Enviar estado "escribiendo" (después de setup, igual que chatbot/voice)
            await provider.vendor.sendPresenceUpdate('composing', ctx.key.remoteJid)

            defaultLogger.info('Iniciando etapa de análisis y respuesta (imagen - único addAction)', {
                userId, numberPhone, name, mediaCaption,
                action: 'image_response_stage_start',
                file: 'media.js'
            })

            // ===== ANÁLISIS DE IMAGEN =====
            const responseImage = await processImage(pathImg, numberPhone, name)
            if (!responseImage) {
                defaultLogger.info('Procesamiento imagen retornó vacío', {
                    userId, numberPhone, name,
                    action: 'image_process_empty',
                    file: 'media.js'
                })
                fs.unlink(pathImg, (error) => {
                    if (error) defaultLogger.error('Error eliminando Imagen', { userId, numberPhone, name, error: error.message, action: 'delete_image', file: 'media.js' });
                });
                return endFlow()
            }
            defaultLogger.info('Respuesta del modelo obtenida Imagen', {
                userId, numberPhone, name,
                modelResponse: responseImage.text,
                action: 'model_response',
                file: 'media.js'
            })

            // ================ COORDINACIÓN COMPARTIDA: MARCAR IMAGEN READY ================
            const imageQuestionParts = [];
            if (mediaCaption) {
                imageQuestionParts.push(`El usuario envio esta imagen con el siguiente texto o caption: "${mediaCaption}".`);
            }
            if (responseImage?.text) {
                imageQuestionParts.push(`Contenido detectado en la imagen: *${responseImage.text}*.`);
            }
            imageQuestionParts.push('IMPORTANTE: usa el caption del usuario como contexto principal y la imagen como apoyo para responder.');
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
                markMessageReady(numberPhone, myEntryId, {
                    content: imageProcessedContent,
                    caption: mediaCaption,
                    extra: { imageAnalysisText: responseImage?.text || '' },
                    file: 'media.js'
                })
            }
            // ==========================================================

            // ===== ALARMA USER SIDE (igual que chatbot/voice) =====
            const shouldEndFlowUser = await processAlarm(ctx, numberPhone, name, provider, imageProcessedContent, "user")
            if (shouldEndFlowUser) {
                fs.unlink(pathImg, (error) => {
                    if (error) defaultLogger.error('Error eliminando Imagen', { userId, numberPhone, name, error: error.message, action: 'delete_image', file: 'media.js' });
                });
                return endFlow()
            }

            if (flowVersion <= 0) {
                // ======== CAMINO LEGACY (sin coordinación) ========
                const newHistory = (state.getMyState()?.history ?? []).slice()
                newHistory.push({ role: 'user', content: imageProcessedContent })
                const response = await run(name, newHistory, imageProcessedContent, numberPhone, responseImage.img)
                defaultLogger.info('Respuesta del modelo obtenida Texto Imagen (legacy)', {
                    userId, numberPhone, name,
                    modelResponse: response,
                    action: 'model_response_legacy',
                    file: 'media.js'
                })
                await respondAndFinalize({
                    response,
                    combinedMessages: imageProcessedContent,
                    image: responseImage,
                    name, numberPhone, userId, ctx, provider, flowDynamic, state, pathImg
                })
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
                fs.unlink(pathImg, (error) => {
                    if (error) defaultLogger.error('Error eliminando Imagen', { userId, numberPhone, name, error: error.message, action: 'delete_image', file: 'media.js' });
                });
                return endFlow()
            }

            const combinedInput = turn.combinedInput || imageProcessedContent
            const newHistory = (state.getMyState()?.history ?? []).slice()
            newHistory.push({ role: 'user', content: combinedInput })

            defaultLogger.info('Procesando mensajes acumulados (coordinación imagen)', {
                userId, numberPhone, name,
                flowVersion,
                combinedLength: String(combinedInput).length,
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
            const response = await run(name, newHistory, combinedInput, numberPhone, responseImage.img)
            defaultLogger.info('Respuesta del modelo obtenida (imagen, coordinado)', {
                userId, numberPhone, name,
                flowVersion,
                modelResponse: response,
                action: 'conversation_ai_response_done',
                file: 'media.js'
            })

            // ===== SEGUNDA VALIDACIÓN POST-IA =====
            if (!isStillMyTurn(numberPhone, { flowVersion, file: 'media.js' })) {
                defaultLogger.info('Segunda validación falló (imagen): llegó otro mensaje durante IA', {
                    userId, numberPhone, name,
                    flowVersion,
                    action: 'conversation_image_post_ai_invalid',
                    file: 'media.js'
                })
                fs.unlink(pathImg, (error) => {
                    if (error) defaultLogger.error('Error eliminando Imagen', { userId, numberPhone, name, error: error.message, action: 'delete_image', file: 'media.js' });
                });
                return endFlow()
            }

            // Alarm IA-side ESTÁ DENTRO de respondAndFinalize (ya lo tenía media.js originalmente)
            await respondAndFinalize({
                response,
                combinedMessages: combinedInput,
                image: responseImage,
                name, numberPhone, userId, ctx, provider, flowDynamic, state,
                flowVersion,
                pathImg
            })
            return endFlow()

        } catch (error) {
            defaultLogger.error('Error en flujo de medios (único addAction)', {
                userId, numberPhone, name,
                error: error.message,
                stack: error.stack,
                context: ctx,
                file: 'media.js'
            })
            return endFlow()
        } finally {
            try {
                await provider.vendor.readMessages([ctx.key])
                await new Promise(resolve => setTimeout(resolve, 5000));
                await provider.vendor.sendPresenceUpdate('paused', ctx.key.remoteJid)
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
