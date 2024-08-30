const { addKeyword,EVENTS } = require('@bot-whatsapp/bot')
const { putWhatsapp,putWhatsappEmailVendor,getWhatsapp,whatsappStatus }  = require('../services/aws');
const { downloadMediaMessage }  = require("@adiwajshing/baileys")
const fs = require("fs");


const media = addKeyword(EVENTS.MEDIA)
.addAction(async (ctx, { flowDynamic,endFlow }) => {
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

        const buffer = await downloadMediaMessage(ctx, "buffer");
        const pathImg = `${process.cwd()}/media/imagen${numberPhone}-${Date.now()}.jpg`;
        await fs.writeFileSync(pathImg, buffer);

        await flowDynamic(name+". Voy a validar el pago para confirmarte el pedido.") 

        console.log("putWhatsappEmailVendor Image Transfer")
        
        await putWhatsappEmailVendor(numberPhone)
        await putWhatsapp(numberPhone,name,false)
        
        return  endFlow();
        
    }catch(err){
        console.log(`[ERROR]:`,err)
    }
})

module.exports = { media };

