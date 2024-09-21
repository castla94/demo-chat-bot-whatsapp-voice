const { addKeyword } = require('@bot-whatsapp/bot')
const { putWhatsapp,putWhatsappEmailVendor } = require('../services/aws');


const vendor = addKeyword("Vendedor")
.addAction(async (ctx, { flowDynamic,endFlow }) => {
    try{

        const numberPhone = ctx.from
        const name = ctx?.pushName ?? ''

        const responseAlarm=await putWhatsappEmailVendor(numberPhone,name,ctx.body)
        console.log("putWhatsappEmailVendor: "+responseAlarm)

        if(responseAlarm){
            await flowDynamic(name+". Estamos contactando a un vendedor para atenderte.") 
        }else{
            await flowDynamic(name+". Lo sentimos, pero no tenemos personal disponible en este momento.") 
        }

        await putWhatsapp(numberPhone,name,false)
        
        return  endFlow();
        
    }catch(err){
        console.log(`[ERROR]:`,err)
    }
})

module.exports = { vendor };
