const { addKeyword,EVENTS } = require('@bot-whatsapp/bot')
const { handlerAI } = require("../services/audio")
const { run, runDetermine } = require('../services/openai');
const { getWhatsapp,putWhatsapp,whatsappStatus,regexAlarm,putWhatsappEmailVendor } = require('../services/aws');
const { setTimeout } = require('timers/promises');

const voice = addKeyword(EVENTS.VOICE_NOTE)
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

        console.log(`[QUE QUIERES COMPRAR VOICE:`,ai.toLowerCase())
        
    }catch(err){
        console.log(`[ERROR VOICE]:`,err)
        return
    }
})
.addAction(async (ctx, { flowDynamic,endFlow, state,gotoFlow }) => {
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

            console.log(`[TEXT VOICE]:`,text)

            const getRegexAlarm = await regexAlarm(text)
            if(getRegexAlarm){
                console.log("Chat bot Active Alarm : "+numberPhone+", message:",text)
                const responseAlarm=await putWhatsappEmailVendor(numberPhone,name,text)
                console.log("putWhatsappEmailVendor: "+responseAlarm)
                if(responseAlarm){
                    await flowDynamic(name+". Estamos contactando a un vendedor para atenderte.") 
                }else{
                    await flowDynamic(name+". Lo sentimos, pero no tenemos personal disponible en este momento.") 
                }
                await putWhatsapp(numberPhone,name,false)
                return  endFlow();
            }


            if (text.toLowerCase().includes('hola') 
                || text.toLowerCase().includes('buenos dias')
            || text.toLowerCase().includes('menu') ) {
                console.log(`[FLOW MENU VOICE]`)
                await flowDynamic(name) 
                await flowDynamic([
                    {
                        body:'🍽️ Nuestro Menú 🍽️',
                        media: 'https://res.cloudinary.com/dletveudc/image/upload/v1723064623/samples/logos/DALL_E_2024-08-07_17.01.05_-_A_visually_appealing_menu_showcasing_four_dishes_with_their_names_prices_and_options._The_menu_has_a_modern_design_with_a_clean_layout_and_vibrant_c_szhr8x.webp'
                    }
                ]) 
                await flowDynamic("Quedo atento a tu pedido.") 
                return;
            }            

            const newHistory = (state.getMyState()?.history ?? [])

            console.log(`[HISTORY VOICE]:`,newHistory)

            newHistory.push({
                role: 'user',
                content: text
            })

            const largeResponse = await run(name, newHistory,text)

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
        console.log(`[ERROR VOICE]:`,err)
        return
    }
});


module.exports = { voice };

