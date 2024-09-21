const { addKeyword } = require('@bot-whatsapp/bot')
const { getWhatsapp,whatsappStatus } = require('../services/aws');

const welcome =  addKeyword(["buenas","hola","como esta"])
.addAction(async (ctx, { flowDynamic,endFlow,state }) => {
    try{
        await state.update({history: []})

        const numberPhone = ctx.from

        const getWhatsappStatus = await whatsappStatus();
        if(getWhatsappStatus && !getWhatsappStatus.status){
            console.log("Chat bot Disabled from database",getWhatsappStatus.status)
            return  endFlow();
        }

        const validateWhatsapp = await getWhatsapp(numberPhone)
        if(validateWhatsapp && !validateWhatsapp.status){
            console.log("Chat bot Session Disabled from database : "+numberPhone)
            return  endFlow();
        }

        await flowDynamic([
            {
                body:'¡Bienvenido a nuestro Restaurante! 🌟\n\n'+
                'Estamos encantados de atenderte. ¿En qué podemos ayudarte hoy?'+
                '\n\n📋 Para ver el menú, escribe: *Menu*\n\n'+
                '🧑‍💼Para hablar con un vendedor, escribe: *Vendedor*',
            }
        ]) 
    }catch(err){
        console.log(`[ERROR]:`,err)
    }
})

module.exports = { welcome };
