const { addKeyword,EVENTS } = require('@bot-whatsapp/bot')
const { run, runDetermine } = require('../services/openai');
const { getWhatsapp,putWhatsapp,whatsappStatus,regexAlarm,putWhatsappEmailVendor,putWhatsappOrderConfirmation } = require('../services/aws');
//const { setTimeout } = require('timers/promises');


// Crear un almacenamiento para los mensajes de cada usuario
const userBuffers = {}; // Un objeto para almacenar el buffer de cada usuario
const userTimeouts = {}; // Un objeto para almacenar el timeout de cada usuario
const TIMEOUT = 10000; 

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}


/**
 * Un flujo conversacion que es por defecto cunado no se contgiene palabras claves en otros flujos
 */
//BotWhatsapp.EVENTS.WELCOME
const chatbot = addKeyword(EVENTS.WELCOME)
    .addAction(async (ctx, {state,endFlow, gotoFlow,flowDynamic}) => {
        try{

            const userId = ctx.key.remoteJid; // Obtener el identificador único del usuario (número de teléfono)

            // Inicializar el buffer y la variable de bienvenida si es la primera vez que el usuario escribe
            if (!userBuffers[userId]) {
                userBuffers[userId] = []; // Crear un buffer de mensajes para este usuario
            }
    
            userBuffers[userId].push(ctx.body);

            // Si ya hay un timeout activo para este usuario, lo reiniciamos
            if (userTimeouts[userId]) {
                clearTimeout(userTimeouts[userId]);
            }
            
            const numberPhone = ctx.from
            const name = ctx?.pushName ?? ''
            
            const getWhatsappStatus = await whatsappStatus();
            if(getWhatsappStatus && !getWhatsappStatus.status){
                console.log("Chat bot Disabled from database")
                return  endFlow();
            }

            const validateWhatsapp = await getWhatsapp(numberPhone)
            if(validateWhatsapp && !validateWhatsapp.status){
                console.log(`Chat bot Session Disabled from database : [${userId}]`)
                return  endFlow();
            }

            const getRegexAlarm = await regexAlarm(ctx.body)
            if(getRegexAlarm){
                console.log("Chat bot Active Alarm : "+numberPhone+", message:",ctx.body)
                const responseAlarm=await putWhatsappEmailVendor(numberPhone,name,ctx.body)
                console.log(`putWhatsappEmailVendor: [${userId}] `+responseAlarm)
                if(responseAlarm){
                    await flowDynamic("Estamos contactando a un vendedor para atenderte.") 
                }else{
                    await flowDynamic("Lo sentimos, pero no tenemos personal disponible en este momento.") 
                }
                await putWhatsapp(numberPhone,name,false)
                return  endFlow();
            }

            // Configuramos un timeout para recolectar los mensajes durante 5 segundos para este usuario
            userTimeouts[userId] = setTimeout(async () => {

                const history = (state.getMyState()?.history ?? [])
                const ai = await runDetermine(history)

                console.log(`[QUE QUIERES COMPRAR:[${userId}]`,ai.toLowerCase())
    
            }, TIMEOUT); //  segundos de espera para este usuario
            
        }catch(err){
            console.log(`[ERROR]:[${userId}]`,err)
            return
        }
    })
    .addAction(async (ctx, { flowDynamic,endFlow, state }) => {
        try{

            const userId = ctx.key.remoteJid; // Obtener el identificador único del usuario (número de teléfono)

            // Si ya hay un timeout activo para este usuario, lo reiniciamos
            if (userTimeouts[userId]) {
                clearTimeout(userTimeouts[userId]);
            }

            const numberPhone = ctx.from
            const name = ctx?.pushName ?? ''

            const getWhatsappStatus = await whatsappStatus(numberPhone)
            if(getWhatsappStatus && !getWhatsappStatus.status){
                console.log(`Chat bot Disabled from database`)
                return  endFlow();
            }

            const validateWhatsapp = await getWhatsapp(numberPhone)
            if(validateWhatsapp && !validateWhatsapp.status){
                console.log(`Chat bot Session Disabled from database : `+numberPhone)
                return  endFlow();
            }
                console.log(`[userBuffers[${userId}]]:`,userBuffers[userId])

            // Configuramos un timeout para recolectar los mensajes durante 5 segundos para este usuario
            userTimeouts[userId] = setTimeout(async () => {
                // Concatenar los mensajes del usuario
                const combinedMessages = userBuffers[userId].join(' ');

                console.log(`[setTimeout[${userId}]]:`,combinedMessages)

                // Limpiar el buffer del usuario
                userBuffers[userId] = [];

                const newHistory = (state.getMyState()?.history ?? [])
    
                console.log(`[HISTORY[${userId}]]:`,newHistory)
        
                newHistory.push({
                    role: 'user',
                    content: combinedMessages
                })
        
                const largeResponse = await run(name, newHistory,combinedMessages)

                if (largeResponse.toLowerCase().includes("pedido recibido".toLowerCase())) {
                    console.log("Procesing Order",{
                        name,
                        numberPhone
                    });
                    putWhatsappOrderConfirmation(name,numberPhone,largeResponse,"pending_payment");
                }

                const chunks = largeResponse.split(/(?<!\d)\.(?=\s|$)|:\n\n/g);
                for (const chunk of chunks) {
                    await flowDynamic(chunk)
                    await sleep(2000)
                }

                newHistory.push({
                    role: 'assistant',
                    content: largeResponse
                })
            
                await state.update({history: newHistory})

                if(!validateWhatsapp){
                    console.log(`putWhatsapp`)
                    await putWhatsapp(numberPhone,name,true)
                }
            }, TIMEOUT); // segundos de espera para este usuario

        }catch(err){
            console.log(`[ERROR[${userId}]]:`,err)
        }
    })


    module.exports = { chatbot };
