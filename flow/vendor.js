const { addKeyword } = require('@bot-whatsapp/bot')
const { putWhatsapp,putWhatsappEmailVendor } = require('../services/aws');


const vendor = addKeyword("Vendedor")
.addAction(async (ctx, { flowDynamic,endFlow }) => {
    try{

        const numberPhone = ctx.from
        const name = ctx?.pushName ?? ''

        await flowDynamic(name+". Estamos contactando a un vendedor para atenderte.") 

        console.log("putWhatsappEmailVendor")
        
        await putWhatsappEmailVendor(numberPhone)
        await putWhatsapp(numberPhone,name,false)
        
        return  endFlow();
        
    }catch(err){
        console.log(`[ERROR]:`,err)
    }
})

module.exports = { vendor };
