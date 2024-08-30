const { addKeyword,EVENTS } = require('@bot-whatsapp/bot')
const { run, runDetermine } = require('../services/openai');
const { getWhatsapp,putWhatsapp,putWhatsappOrderConfirmation,whatsappStatus } = require('../services/aws');
const { setTimeout } = require('timers/promises');

/**
 * Un flujo conversacion que es por defecto cunado no se contgiene palabras claves en otros flujos
 */
//BotWhatsapp.EVENTS.WELCOME
const chatbot = addKeyword(EVENTS.WELCOME)
    .addAction(async (ctx, {state,endFlow, gotoFlow}) => {
        try{

            const numberPhone = ctx.from

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

            const history = (state.getMyState()?.history ?? [])
            const ai = await runDetermine(history)

            console.log(`[QUE QUIERES COMPRAR:`,ai.toLowerCase())

            if (ctx.body.toLowerCase().includes('nombre completo') 
                && (ctx.body.toLowerCase().includes('número de teléfono')
            || ctx.body.toLowerCase().includes('numero de telefono') )
            && (ctx.body.toLowerCase().includes('método de pago')
            || ctx.body.toLowerCase().includes('método de pago'))) {
                console.log("putWhatsappOrderConfirmation")
                await putWhatsappOrderConfirmation(numberPhone,ctx.body,"pending_payment")
            }
            
        }catch(err){
            console.log(`[ERROR]:`,err)
            return
        }
    })
    .addAction(async (ctx, { flowDynamic,endFlow, state }) => {
        try{

            const numberPhone = ctx.from

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
            const name = ctx?.pushName ?? ''
    
            console.log(`[HISTORY]:`,newHistory)
    
            newHistory.push({
                role: 'user',
                content: ctx.body
            })
    
            const largeResponse = await run(name, newHistory,ctx.body)

            const chunks = largeResponse.split(/(?<!\d)\.\s+/g);
            for (const chunk of chunks) {
                await flowDynamic(chunk)
                await setTimeout(3000)
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
