const { addKeyword } = require('@bot-whatsapp/bot')
const { getWhatsapp } = require('../services/aws');

const welcome =  addKeyword(["buenas","hola","como esta"])
.addAction(async (ctx, { flowDynamic }) => {
    try{

        const numberPhone = ctx.from

        const validateWhatsapp = await getWhatsapp(numberPhone)
        if(validateWhatsapp && !validateWhatsapp.status){
            console.log("endFlow welcome keyword")
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
