const { addKeyword,EVENTS } = require('@bot-whatsapp/bot')
const { handlerAI } = require("../services/audio")
const { run, runDetermine } = require('../services/openai');
const { getWhatsapp,putWhatsapp,whatsappStatus,regexAlarm,putWhatsappEmailVendor } = require('../services/aws');
const { setTimeout } = require('timers/promises');

const voice = addKeyword(EVENTS.VOICE_NOTE)
.addAction(async (ctx, {state,endFlow, gotoFlow}) => {

    const userId = ctx.key.remoteJid; // Obtener el identificador único del usuario (número de teléfono)

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
        const ai = await runDetermine(history,numberPhone)

        console.log(`[QUE QUIERES COMPRAR VOICE:[${userId}] `,ai.toLowerCase())
        
    }catch(err){
        console.log(`[ERROR VOICE]:[${userId}] `,err)
        return
    }
})
.addAction(async (ctx, { flowDynamic,endFlow, state,gotoFlow }) => {

    const userId = ctx.key.remoteJid; // Obtener el identificador único del usuario (número de teléfono)


    try{
            const name = ctx?.pushName ?? ''
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

            const text = await handlerAI(ctx,numberPhone)

            console.log(`[TEXT VOICE]:[${userId}] `,text)

            const getRegexAlarm = await regexAlarm(text)
            if(getRegexAlarm){
                console.log("Chat bot Active Alarm : "+numberPhone+", message:",text)
                const responseAlarm=await putWhatsappEmailVendor(numberPhone,name,text)
                console.log("putWhatsappEmailVendor: "+responseAlarm)
                if(responseAlarm){
                    await flowDynamic("Estamos contactando a un vendedor para atenderte.") 
                }else{
                    await flowDynamic("Lo sentimos, pero no tenemos personal disponible en este momento.") 
                }
                await putWhatsapp(numberPhone,name,false)
                return  endFlow();
            }        

            const newHistory = (state.getMyState()?.history ?? [])

            console.log(`[HISTORY VOICE]:[${userId}] `,newHistory)

            newHistory.push({
                role: 'user',
                content: text
            })

            const largeResponse = await run(name, newHistory,text,numberPhone)

            const chunks = largeResponse.split(/(?<!\d)\.(?=\s|$)|:\n\n/g);
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
        console.log(`[ERROR VOICE]:[${userId}] `,err)
        return
    }
});


module.exports = { voice };

