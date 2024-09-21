const { addKeyword,EVENTS } = require('@bot-whatsapp/bot')
const { run, runDetermine } = require('../services/openai');
const { getWhatsapp,putWhatsapp,whatsappStatus,regexAlarm,putWhatsappEmailVendor } = require('../services/aws');
const { setTimeout } = require('timers/promises');

/**
 * Un flujo conversacion que es por defecto cunado no se contgiene palabras claves en otros flujos
 */
//BotWhatsapp.EVENTS.WELCOME
const chatbot = addKeyword(EVENTS.WELCOME)
    .addAction(async (ctx, {state,endFlow, gotoFlow,flowDynamic}) => {
        try{

            const numberPhone = ctx.from
            const name = ctx?.pushName ?? ''
            
            const getWhatsappStatus = await whatsappStatus();
            if(getWhatsappStatus && !getWhatsappStatus.status){
                console.log("Chat bot Disabled from database")
                return  endFlow();
            }

            const validateWhatsapp = await getWhatsapp(numberPhone)
            if(validateWhatsapp && !validateWhatsapp.status){
                console.log("Chat bot Session Disabled from database : "+numberPhone)
                return  endFlow();
            }

            const getRegexAlarm = await regexAlarm(ctx.body)
            if(getRegexAlarm){
                console.log("Chat bot Active Alarm : "+numberPhone+", message:",ctx.body)
                const responseAlarm=await putWhatsappEmailVendor(numberPhone,name,ctx.body)
                console.log("putWhatsappEmailVendor: "+responseAlarm)
                if(responseAlarm){
                    await flowDynamic(name+". Estamos contactando a un vendedor para atenderte.") 
                }else{
                    await flowDynamic(name+". Lo sentimos, pero no tenemos personal disponible en este momento.") 
                }
                await putWhatsapp(numberPhone,name,false)
                return  endFlow();
            }

            const history = (state.getMyState()?.history ?? [])
            const ai = await runDetermine(history)

            console.log(`[QUE QUIERES COMPRAR:`,ai.toLowerCase())
            
        }catch(err){
            console.log(`[ERROR]:`,err)
            return
        }
    })
    .addAction(async (ctx, { flowDynamic,endFlow, state }) => {
        try{

            const numberPhone = ctx.from
            const name = ctx?.pushName ?? ''

            const getWhatsappStatus = await whatsappStatus(numberPhone)
            if(getWhatsappStatus && !getWhatsappStatus.status){
                console.log("Chat bot Disabled from database")
                return  endFlow();
            }

            const validateWhatsapp = await getWhatsapp(numberPhone)
            if(validateWhatsapp && !validateWhatsapp.status){
                console.log("Chat bot Session Disabled from database : "+numberPhone)
                return  endFlow();
            }

            const newHistory = (state.getMyState()?.history ?? [])
    
            console.log(`[HISTORY]:`,newHistory)
    
            newHistory.push({
                role: 'user',
                content: ctx.body
            })
    
            const largeResponse = await run(name, newHistory,ctx.body)

            const chunks = largeResponse.split(/(?<!\d)[\.\:]\s*/g);
            for (const chunk of chunks) {
                await flowDynamic(chunk)
                await setTimeout(1000)
            }

            newHistory.push({
                role: 'assistant',
                content: largeResponse
            })
        
            await state.update({history: newHistory})

            if(!validateWhatsapp){
                console.log("putWhatsapp")
                await putWhatsapp(numberPhone,name,true)
            }
    
        }catch(err){
            console.log(`[ERROR]:`,err)
        }
    })


    module.exports = { chatbot };
