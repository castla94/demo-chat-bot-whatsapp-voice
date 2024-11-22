const { addKeyword,EVENTS } = require('@bot-whatsapp/bot')
const { putWhatsapp,putWhatsappEmailVendor }  = require('../services/aws');
const { downloadMediaMessage }  = require("@adiwajshing/baileys")
const fs = require("fs");


const media = addKeyword(EVENTS.MEDIA)
.addAction(async (ctx, { flowDynamic,endFlow }) => {
    try{
        const numberPhone = ctx.from
        const name = ctx?.pushName ?? ''

        const buffer = await downloadMediaMessage(ctx, "buffer");
        const pathImg = `${process.cwd()}/media/imagen${numberPhone}-${Date.now()}.jpg`;
        await fs.writeFileSync(pathImg, buffer);

        const responseAlarm=await putWhatsappEmailVendor(numberPhone,name,"Comprobante de Pago Enviado.")
        console.log("putWhatsappEmailVendor Image Transfer: "+responseAlarm)

        if(responseAlarm){
            await flowDynamic(name+". Gracias por enviar el comprobante de pago") 
            await flowDynamic("Voy a validar el pago") 
        }else{
            await flowDynamic(name+". Lo sentimos, pero no tenemos personal disponible en este momento.") 
        }

        await putWhatsapp(numberPhone,name,false)
        
        return  endFlow();
        
    }catch(err){
        console.log(`[ERROR]:`,err)
    }
})

module.exports = { media };

