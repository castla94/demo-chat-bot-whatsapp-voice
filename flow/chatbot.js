const { addKeyword, EVENTS } = require('@bot-whatsapp/bot')
const { run, runDetermine, runUpdatePromptServicesProduct } = require('../services/openai')
const {
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
} = require('../services/aws')

const { defaultLogger } = require('../helpers/cloudWatchLogger');

// Constantes de configuración
let TIMEOUT_MS = 10000 // Tiempo de espera aleatorio entre 45-60 segundos

// Almacenamiento en memoria para gestionar mensajes de usuarios
const userBuffers = {} // Buffer de mensajes por usuario
const userTimeouts = {} // Timeouts por usuario

/**
 * Función auxiliar para pausar la ejecución
 * @param {number} ms - Milisegundos a esperar
 * @returns {Promise} Promesa que se resuelve después del tiempo especificado
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Flujo principal del chatbot que maneja la conversación por defecto
 * cuando no hay coincidencias con palabras clave
 */
const chatbot = addKeyword(EVENTS.WELCOME)
    // Primera acción: Validación inicial y procesamiento de mensajes
    .addAction(async (ctx, { state, endFlow, flowDynamic }) => {
        try {

            const userId = ctx.key.remoteJid
            const numberPhone = ctx.from
            const name = ctx?.pushName ?? ''

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

            defaultLogger.info('Iniciando procesamiento de mensaje', {
                userId,
                numberPhone,
                name,
                messageBody: ctx.body,
                action: 'message_received',
                timestamp: new Date().toISOString(),
                file: 'chatbot.js'
            })

            // Inicializar buffer de mensajes si no existe
            if (!userBuffers[userId]) {
                userBuffers[userId] = []
            }
            // Check if message already exists in buffer to avoid duplicates
            if (userBuffers[userId].indexOf(ctx.body) !== -1) {
                defaultLogger.info('Mensaje duplicado, ignorando...', {
                    userId,
                    numberPhone,
                    name,
                    action: 'duplicate_message',
                    file: 'chatbot.js'
                })
                return endFlow()
            }
            userBuffers[userId].push(ctx.body)

            // Reiniciar timeout si existe
            if (userTimeouts[userId]) {
                clearTimeout(userTimeouts[userId])
            }

            // Validar si el usuario está en lista blanca
            const isWhitelisted = await getWhatsappWhitelist(numberPhone)
            defaultLogger.info('Verificación de whitelist', {
                userId,
                numberPhone,
                name,
                isWhitelisted,
                action: 'whitelist_verification',
                file: 'chatbot.js'
            })

            if (isWhitelisted) {
                userBuffers[userId] = [] // Limpiar buffer
                defaultLogger.info('Usuario en whitelist, finalizando flujo', {
                    userId,
                    numberPhone,
                    name,
                    action: 'whitelist_end_flow',
                    file: 'chatbot.js'
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
                file: 'chatbot.js'
            })

            if (botStatus && !botStatus.status) {
                userBuffers[userId] = [] // Limpiar buffer
                await postWhatsappConversation(numberPhone, ctx.body, "");
                defaultLogger.info('Bot desactivado globalmente', {
                    action: 'global_status_end_flow',
                    file: 'chatbot.js'
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
                file: 'chatbot.js'
            })

            if (userStatus && !userStatus.status) {
                userBuffers[userId] = [] // Limpiar buffer
                await postWhatsappConversation(numberPhone, ctx.body, "");
                defaultLogger.info('Usuario desactivado', {
                    userId,
                    numberPhone,
                    name,
                    action: 'user_disabled_end_flow',
                    file: 'chatbot.js'
                })
                return endFlow()
            }
            // Call the alarm processing method
            const shouldEndFlow = await processAlarm(ctx, numberPhone, name, flowDynamic, ctx.body, "user")
            if (shouldEndFlow) return endFlow()

            TIMEOUT_MS = Math.floor(Math.random() * (15000 - 10000 + 1) + 10000) // Tiempo de espera aleatorio entre 45-60 segundos


            // Get current conversation history from state
            const historyGlobalStatus = state.getMyState()?.history ?? []
            // Check if there's no conversation history
            if (historyGlobalStatus.length <= 0) {
                // Fetch conversation history from database
                const historyDB = await getWhatsappConversation(numberPhone);
                defaultLogger.info('Historial de conversación recuperado de la base de datos', {
                    userId,
                    numberPhone,
                    name,
                    historyLength: historyDB?.length || 0,
                    action: 'history_db_retrieved',
                    file: 'chatbot.js'
                })

                defaultLogger.info('Estado actualizado con el historial de conversación', {
                    userId,
                    numberPhone,
                    name,
                    action: 'history_state_updated',
                    file: 'chatbot.js'
                })
                await state.update({ history: historyDB })
            }



        } catch (error) {
            defaultLogger.error('Error en primera acción chatbot flujo', {
                userId: ctx.key.remoteJid,
                numberPhone: ctx.from,
                name: ctx?.pushName,
                error: error.message,
                stack: error.stack,
                context: ctx,
                file: 'chatbot.js'
            })
        }
    })
    // Segunda acción: Procesamiento de respuesta y gestión de conversación
    .addAction(async (ctx, { flowDynamic, endFlow, state }) => {
        try {
            const userId = ctx.key.remoteJid
            const numberPhone = ctx.from
            const name = ctx?.pushName ?? ''

            defaultLogger.info('Iniciando segunda acción', {
                userId,
                numberPhone,
                name,
                messageBody: ctx.body,
                action: 'second_action_start',
                file: 'chatbot.js'
            })

            // Reiniciar timeout existente
            if (userTimeouts[userId]) {
                clearTimeout(userTimeouts[userId])
            }

            // Validar si el usuario está en lista blanca
            const isWhitelisted = await getWhatsappWhitelist(numberPhone)
            defaultLogger.info('Verificación de whitelist', {
                userId,
                numberPhone,
                name,
                isWhitelisted,
                action: 'whitelist_verification',
                file: 'chatbot.js'
            })

            if (isWhitelisted) {
                userBuffers[userId] = [] // Limpiar buffer
                defaultLogger.info('Usuario en whitelist, finalizando flujo', {
                    userId,
                    numberPhone,
                    name,
                    action: 'whitelist_end_flow',
                    file: 'chatbot.js'
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
                file: 'chatbot.js'
            })

            if (botStatus && !botStatus.status) {
                userBuffers[userId] = [] // Limpiar buffer
                defaultLogger.info('Bot desactivado globalmente', {
                    action: 'global_status_end_flow',
                    file: 'chatbot.js'
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
                file: 'chatbot.js'
            })

            if (userStatus && !userStatus.status) {
                userBuffers[userId] = [] // Limpiar buffer
                defaultLogger.info('Usuario desactivado', {
                    userId,
                    numberPhone,
                    name,
                    action: 'user_disabled_end_flow',
                    file: 'chatbot.js'
                })
                return endFlow()
            }

            // Procesar mensajes acumulados
            userTimeouts[userId] = setTimeout(async () => {
                const combinedMessages = userBuffers[userId].join(' ')
                userBuffers[userId] = [] // Limpiar buffer

                const newHistory = (state.getMyState()?.history ?? [])
                newHistory.push({
                    role: 'user',
                    content: combinedMessages
                })

                defaultLogger.info('Procesando mensajes acumulados', {
                    userId,
                    numberPhone,
                    name,
                    combinedMessages,
                    history: newHistory,
                    action: 'processing_messages',
                    file: 'chatbot.js'
                })

                // Obtener respuesta del modelo
                const response = await run(name, newHistory, combinedMessages, numberPhone)
                defaultLogger.info('Respuesta del modelo obtenida', {
                    userId,
                    numberPhone,
                    name,
                    modelResponse: response,
                    action: 'model_response',
                    file: 'chatbot.js'
                })

                // Call the alarm processing method
                const shouldEndFlow = await processAlarm(ctx, numberPhone, name, flowDynamic, response, "IA")
                if (shouldEndFlow) return endFlow()

                // Procesar orden si se detecta
                if (response.toLowerCase().includes("datos recibidos")) {

                    const whatsappPrompt = await promptGetWhatsapp();
                    if (whatsappPrompt.products_dynamic) {
                        const updatePrompt = await runUpdatePromptServicesProduct(response);
                        defaultLogger.info('Prompt actualizado', {
                            userId,
                            numberPhone,
                            name,
                            updatePrompt,
                            action: 'update_prompt_complete',
                            file: 'chatbot.js'
                        });

                        const responseUpdateProductWhatsapp = await promptUpdateProductWhatsapp(updatePrompt);
                        defaultLogger.info('Respuesta de actualización de producto prompt', {
                            userId,
                            numberPhone,
                            name,
                            responseUpdateProductWhatsapp,
                            action: 'product_update_response',
                            file: 'chatbot.js'
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
                        file: 'chatbot.js'
                    })
                }

                // Enviar respuesta en chunks
                const chunks = response.split(/(?<!\d)\.(?=\s|$)|:\n\n/g)

                const greetings = ['hola', 'como esta', 'buenos dias', 'buenas tardes', 'buenas noches']
                if (greetings.some(greeting => ctx.body.toLowerCase().includes(greeting))) {
                    /*await putWhatsapp(numberPhone, name, true)
                    defaultLogger.info('Usuario activado', {
                        userId,
                        numberPhone,
                        name,
                        action: 'user_active',
                        file: 'chatbot.js'
                    })*/
                    // Get welcome message 
                    const whatsappPrompt = await promptGetWhatsapp()
                    await displayFile(whatsappPrompt,flowDynamic)
                }

                for (const chunk of chunks) {
                    await flowDynamic(chunk.replace(/^[\n]+/, '').trim())
                    await sleep(2000)
                }

                // Actualizar historial
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

                // Actualizar estado del usuario si es nuevo
                if (!userStatus) {
                    const newUserStatus = await putWhatsapp(numberPhone, name, true)
                    defaultLogger.info('Nuevo usuario registrado', {
                        userId,
                        numberPhone,
                        name,
                        newUserStatus,
                        action: 'new_user_registration',
                        file: 'chatbot.js'
                    })
                }
            }, TIMEOUT_MS)

        } catch (error) {
            defaultLogger.error('Error en segunda acción chatbot flujo', {
                userId: ctx.key.remoteJid,
                numberPhone: ctx.from,
                name: ctx?.pushName,
                error: error.message,
                stack: error.stack,
                context: ctx,
                file: 'chatbot.js'
            })
        }
    })


const displayFile = async (whatsappPrompt, flowDynamic) => {
    const hasValidMenuUrl = whatsappPrompt.url_menu &&
        whatsappPrompt.url_menu !== "" &&
        whatsappPrompt.url_menu !== "NA"
    if (hasValidMenuUrl) {
        await flowDynamic([{
            body: '.',
            media: whatsappPrompt.url_menu
        }])
    }
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
const processAlarm = async (ctx, numberPhone, name, flowDynamic, question, UserOrIA) => {
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
        } else {
            await postWhatsappConversation(numberPhone, "", question);
        }
        
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

        await flowDynamic(alarmResponse
            ? message
            : "Lo sentimos, pero no tenemos personal disponible en este momento."
        )

        await putWhatsapp(numberPhone, name, false)
        return true
    }
    return false
}

module.exports = { chatbot }
